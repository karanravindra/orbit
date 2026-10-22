import type { Db } from "@orbit/db";
import * as schema from "@orbit/db/schema";
import type { BetterAuthPlugin } from "better-auth";
import {
	APIError,
	createAuthMiddleware,
	getSessionFromCtx,
} from "better-auth/api";
import type { OrganizationOptions } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { PERSONAL_ORGANIZATION_ERROR_CODES as ERRORS } from "../errors";
import { OWNER_ROLE, parseRoles } from "../roles";

// Every user owns exactly one organization: their personal one. The plugin
// creates it and starts every session in it; personalOrganizationOptions keep
// it the user's only org and them its only owner.

async function findPersonalOrganizationId(
	db: Db,
	userId: string,
): Promise<string | undefined> {
	const [row] = await db
		.select()
		.from(schema.organization)
		.where(eq(schema.organization.personalOwnerId, userId))
		.limit(1);
	return row?.id;
}

type CreateOrganization = (body: {
	name: string;
	slug: string;
	userId: string;
}) => Promise<{ id: string }>;

export function personalOrganization({
	createOrganization,
	db,
}: {
	db: Db;
	// Creates an org through the organization plugin as a system action (no
	// session), so the owner membership and default team are set up like any
	// other org.
	createOrganization: CreateOrganization;
}) {
	// Idempotent; returns the org's id.
	async function ensurePersonalOrganization(user: {
		id: string;
		name: string;
	}): Promise<string> {
		const existing = await findPersonalOrganizationId(db, user.id);
		if (existing) return existing;
		try {
			const created = await createOrganization({
				name: `${user.name}'s workspace`,
				slug: user.id.toLowerCase(),
				userId: user.id,
			});
			return created.id;
		} catch (error) {
			// A concurrent call may have won the race on the unique personalOwnerId.
			const raced = await findPersonalOrganizationId(db, user.id);
			if (raced) return raced;
			throw error;
		}
	}

	return {
		id: "personal-organization",
		$ERROR_CODES: ERRORS,
		init: (ctx) => ({
			options: {
				databaseHooks: {
					user: {
						create: {
							after: async (user) => {
								// Runs after sign-up commits. If it fails, the org is created
								// on the user's first session instead.
								try {
									await ensurePersonalOrganization(user);
								} catch (error) {
									ctx.logger.error(
										"Failed to create personal organization",
										error,
									);
								}
							},
						},
					},
					session: {
						create: {
							// Every new session starts in the user's personal organization.
							before: async (session) => {
								let activeOrganizationId = await findPersonalOrganizationId(
									db,
									session.userId,
								);
								if (!activeOrganizationId) {
									const [owner] = await db
										.select()
										.from(schema.user)
										.where(eq(schema.user.id, session.userId))
										.limit(1);
									// A failure here must not lock the user out; the session
									// starts without an active org and the next one retries.
									try {
										if (owner) {
											activeOrganizationId =
												await ensurePersonalOrganization(owner);
										}
									} catch (error) {
										ctx.logger.error(
											"Failed to create personal organization",
											error,
										);
									}
								}
								return { data: { ...session, activeOrganizationId } };
							},
						},
					},
				},
			},
		}),
		hooks: {
			before: [
				{
					matcher: (ctx) => ctx.path === "/organization/leave",
					handler: createAuthMiddleware(async (ctx) => {
						const session = await getSessionFromCtx(ctx);
						const organizationId = ctx.body?.organizationId;
						if (!session || typeof organizationId !== "string") return;
						if (
							(await findPersonalOrganizationId(db, session.user.id)) ===
							organizationId
						) {
							throw APIError.from(
								"FORBIDDEN",
								ERRORS.CANNOT_LEAVE_PERSONAL_ORGANIZATION,
							);
						}
					}),
				},
				{
					// Checked here rather than in beforeCreateInvitation so resends,
					// which skip that hook, are covered too.
					matcher: (ctx) => ctx.path === "/organization/invite-member",
					handler: createAuthMiddleware(async (ctx) => {
						if (parseRoles(ctx.body?.role).includes(OWNER_ROLE)) {
							throw APIError.from("FORBIDDEN", ERRORS.CANNOT_INVITE_AS_OWNER);
						}
					}),
				},
			],
		},
	} satisfies BetterAuthPlugin;
}

// Settings for organization() that go with the plugin above.
export function personalOrganizationOptions(db: Db) {
	return {
		// Users can't create orgs: each gets a personal one at sign-up and joins
		// others by invitation. The limit backs that up for the server-side create.
		allowUserToCreateOrganization: false,
		organizationLimit: async (user) =>
			(await findPersonalOrganizationId(db, user.id)) !== undefined,
		// Every org is someone's personal org, which lasts as long as the user does
		// (personalOwnerId cascades on user delete).
		disableOrganizationDeletion: true,
		schema: {
			organization: {
				additionalFields: {
					// Marks the personal org and its owner. Not writable via the API.
					personalOwnerId: {
						type: "string",
						required: false,
						input: false,
						unique: true,
						references: { model: "user", field: "id", onDelete: "cascade" },
					},
				},
			},
		},
		organizationHooks: {
			beforeCreateOrganization: async ({ user }) => ({
				data: { personalOwnerId: user.id },
			}),
			// The personal owner is the only owner, so the org can't be handed over
			// and its owner can't be pushed out.
			beforeAddMember: async ({ member, organization }) => {
				if (
					parseRoles(member.role).includes(OWNER_ROLE) &&
					member.userId !== organization.personalOwnerId
				) {
					throw APIError.from("FORBIDDEN", ERRORS.CANNOT_ADD_OWNER);
				}
			},
			// Accepting an invitation adds the member without beforeAddMember.
			beforeAcceptInvitation: async ({ invitation }) => {
				if (parseRoles(invitation.role).includes(OWNER_ROLE)) {
					throw APIError.from("FORBIDDEN", ERRORS.CANNOT_ADD_OWNER);
				}
			},
			beforeUpdateMemberRole: async ({ member, newRole, organization }) => {
				if (member.userId === organization.personalOwnerId) {
					throw APIError.from("FORBIDDEN", ERRORS.CANNOT_CHANGE_OWNER_ROLE);
				}
				if (parseRoles(newRole).includes(OWNER_ROLE)) {
					throw APIError.from("FORBIDDEN", ERRORS.CANNOT_ASSIGN_OWNER_ROLE);
				}
			},
			beforeRemoveMember: async ({ member, organization }) => {
				if (member.userId === organization.personalOwnerId) {
					throw APIError.from("FORBIDDEN", ERRORS.CANNOT_REMOVE_OWNER);
				}
			},
		},
	} satisfies OrganizationOptions;
}
