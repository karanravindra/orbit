import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import * as schema from "@orbit/db/schema";
import {
	APIError,
	createAuthMiddleware,
	getSessionFromCtx,
} from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import {
	admin,
	captcha,
	emailOTP,
	haveIBeenPwned,
	lastLoginMethod,
	organization,
} from "better-auth/plugins";
import { and, eq } from "drizzle-orm";
import { env } from "../env";
import { ac, roles } from "./access-control";
import { db } from "./db";
import {
	emailSender,
	organizationInvitationEmail,
	passwordResetOtpEmail,
	verificationOtpEmail,
} from "./email";

// Durations are in seconds, like Better Auth's options.
const OTP_EXPIRES_IN = 60 * 5;
const INVITATION_EXPIRES_IN = 60 * 60 * 48;
const IMPERSONATION_SESSION_DURATION = 60 * 60;

const OWNER_ROLE = "owner";
const ADMIN_ROLE = "admin";
// Only these org roles may invite members or hand out the admin role, whatever
// permissions a custom role is given.
const MANAGER_ROLES = [OWNER_ROLE, ADMIN_ROLE];

// Role strings may hold several comma-separated roles; request bodies may also
// send an array whose elements hold commas. Matches Better Auth's own parsing
// so a role can't slip past these checks and still be stored.
function parseRoles(role: unknown): string[] {
	const list = Array.isArray(role) ? role : [role ?? ""];
	return list
		.flatMap((r) => String(r).split(","))
		.map((r) => r.trim())
		.filter(Boolean);
}

function forbidden(code: string, message: string): APIError {
	return new APIError("FORBIDDEN", { code, message });
}

// The org an organization endpoint acts on, resolved the way Better Auth does
// (an empty organizationId falls back to the active org).
function targetOrganizationId(
	body: { organizationId?: unknown } | undefined,
	activeOrganizationId: string | null | undefined,
): string | undefined {
	const organizationId = body?.organizationId || activeOrganizationId;
	return typeof organizationId === "string" ? organizationId : undefined;
}

async function isEmailVerified(email: unknown): Promise<boolean> {
	if (typeof email !== "string") return false;
	const [row] = await db
		.select({ emailVerified: schema.user.emailVerified })
		.from(schema.user)
		.where(eq(schema.user.email, email.toLowerCase()))
		.limit(1);
	return row?.emailVerified === true;
}

async function findPersonalOrganizationId(
	userId: string,
): Promise<string | undefined> {
	const [row] = await db
		.select({ id: schema.organization.id })
		.from(schema.organization)
		.where(eq(schema.organization.personalOwnerId, userId))
		.limit(1);
	return row?.id;
}

async function findMemberRoles(
	userId: string,
	organizationId: string,
): Promise<string[]> {
	const [row] = await db
		.select({ role: schema.member.role })
		.from(schema.member)
		.where(
			and(
				eq(schema.member.userId, userId),
				eq(schema.member.organizationId, organizationId),
			),
		)
		.limit(1);
	return parseRoles(row?.role);
}

// Throws unless the requester is an owner or admin of the org the request
// targets. Better Auth itself rejects requests without a session or org.
async function assertManager(
	ctx: { body?: { organizationId?: unknown } },
	session: Awaited<ReturnType<typeof getSessionFromCtx>>,
	code: string,
	message: string,
): Promise<void> {
	if (!session) return;
	const organizationId = targetOrganizationId(
		ctx.body,
		session.session.activeOrganizationId,
	);
	if (!organizationId) return;
	const memberRoles = await findMemberRoles(session.user.id, organizationId);
	if (!memberRoles.some((role) => MANAGER_ROLES.includes(role))) {
		throw forbidden(code, message);
	}
}

// Every user owns exactly one organization: their personal one. It is created
// through the plugin as a system action (no session) so the owner membership
// and default team are set up like any other org. Idempotent; returns its id.
async function ensurePersonalOrganization(user: {
	id: string;
	name: string;
}): Promise<string> {
	const existing = await findPersonalOrganizationId(user.id);
	if (existing) return existing;
	try {
		const created = await auth.api.createOrganization({
			body: {
				name: `${user.name}'s workspace`,
				slug: user.id.toLowerCase(),
				userId: user.id,
			},
		});
		return created.id;
	} catch (error) {
		// A concurrent call may have won the race on the unique personalOwnerId.
		const raced = await findPersonalOrganizationId(user.id);
		if (raced) return raced;
		throw error;
	}
}

// Requests that set emailVerified: true. update.before only sees the patch and
// update.after only sees the row, so this links the two for the same request.
const verifyingRequests = new WeakSet<object>();

export const auth = betterAuth({
	baseURL: env.BETTER_AUTH_URL,
	secret: env.BETTER_AUTH_SECRET,
	trustedOrigins: env.CORS_ORIGINS,
	database: drizzleAdapter(db, { provider: "pg", schema }),
	emailAndPassword: {
		enabled: true,
		requireEmailVerification: true,
		// A reset may follow a compromise, so sign out every existing session.
		revokeSessionsOnPasswordReset: true,
		// Signing up again with the email of an unverified account means nobody
		// has proven they own it yet, so whoever set its password may be
		// squatting it. Drop that password: the inbox owner verifies, gets signed
		// in and sets a password with a reset code; the squatter is locked out.
		// A fresh code goes out so a real user signing up twice isn't stuck.
		onExistingUserSignUp: async ({ user }) => {
			if (user.emailVerified) return;
			await db
				.delete(schema.account)
				.where(
					and(
						eq(schema.account.userId, user.id),
						eq(schema.account.providerId, "credential"),
					),
				);
			const otp = await auth.api.createVerificationOTP({
				body: { email: user.email, type: "email-verification" },
			});
			await emailSender.send({
				to: user.email,
				...verificationOtpEmail({
					otp,
					expiresInMinutes: OTP_EXPIRES_IN / 60,
				}),
			});
		},
		// Duplicate sign-ups get a fake user back; give it the admin plugin's
		// fields so it is indistinguishable from a real one.
		customSyntheticUser: ({ coreFields, additionalFields, id }) => ({
			...coreFields,
			role: "user",
			banned: false,
			banReason: null,
			banExpires: null,
			...additionalFields,
			id,
		}),
	},
	emailVerification: {
		// The verification email is an OTP (see emailOTP below); verifying it
		// signs the user in. Only unverified users can verify (see the hooks
		// below), so this never works as a passwordless sign-in.
		autoSignInAfterVerification: true,
	},
	// OTPs are only for email verification and password reset, so the link
	// flows, OTP sign-in and the deprecated reset alias are switched off.
	disabledPaths: [
		"/sign-in/email-otp",
		"/forget-password/email-otp",
		"/send-verification-email",
		"/verify-email",
		"/request-password-reset",
		"/reset-password",
	],
	hooks: {
		before: createAuthMiddleware(async (ctx) => {
			switch (ctx.path) {
				case "/email-otp/send-verification-otp": {
					if (ctx.body?.type === "sign-in") {
						throw new APIError("BAD_REQUEST", {
							code: "OTP_SIGN_IN_DISABLED",
							message: "Signing in with an email code is not enabled",
						});
					}
					// Verifying an email signs the user in, so verified users get no
					// code. The response matches a real send to avoid leaking who is
					// verified.
					if (
						ctx.body?.type === "email-verification" &&
						(await isEmailVerified(ctx.body?.email))
					) {
						return ctx.json({ success: true });
					}
					return;
				}
				case "/email-otp/verify-email": {
					// Backs up the check above for codes issued before verification.
					if (await isEmailVerified(ctx.body?.email)) {
						throw new APIError("BAD_REQUEST", {
							code: "INVALID_OTP",
							message: "Invalid OTP",
						});
					}
					return;
				}
				case "/organization/leave": {
					const session = await getSessionFromCtx(ctx);
					const organizationId = ctx.body?.organizationId;
					if (!session || typeof organizationId !== "string") return;
					if (
						(await findPersonalOrganizationId(session.user.id)) ===
						organizationId
					) {
						throw forbidden(
							"CANNOT_LEAVE_PERSONAL_ORGANIZATION",
							"You can't leave your personal organization",
						);
					}
					return;
				}
				case "/organization/invite-member": {
					// Checked here rather than in beforeCreateInvitation so resends,
					// which skip that hook, are covered too.
					if (parseRoles(ctx.body?.role).includes(OWNER_ROLE)) {
						throw forbidden(
							"CANNOT_INVITE_AS_OWNER",
							"Only the personal owner can have the owner role",
						);
					}
					// Custom roles may be granted invitation:create, but only owners
					// and admins may invite.
					await assertManager(
						ctx,
						await getSessionFromCtx(ctx),
						"ONLY_OWNERS_AND_ADMINS_CAN_INVITE",
						"Only owners and admins can invite members",
					);
					return;
				}
				case "/organization/update-member-role": {
					// Otherwise a custom role with member:update could make its
					// holder an admin, who can invite.
					if (!parseRoles(ctx.body?.role).includes(ADMIN_ROLE)) return;
					await assertManager(
						ctx,
						await getSessionFromCtx(ctx),
						"ONLY_OWNERS_AND_ADMINS_CAN_ASSIGN_ADMIN",
						"Only owners and admins can make someone an admin",
					);
					return;
				}
			}
		}),
	},
	databaseHooks: {
		user: {
			create: {
				after: async (user) => {
					// Runs after sign-up commits. If it fails, the org is created on
					// the user's first session instead.
					try {
						await ensurePersonalOrganization(user);
					} catch (error) {
						console.error("Failed to create personal organization", error);
					}
				},
			},
			update: {
				before: async (data, ctx) => {
					if (ctx && data.emailVerified === true) verifyingRequests.add(ctx);
				},
				// Allowlisted emails become platform admins when they are verified,
				// never at sign-up, so nobody can squat an admin address. The
				// self-service flows only write emailVerified: true for unverified
				// users (verify-email is blocked for verified ones and reset only
				// sets it when false), so a revoked role isn't re-granted.
				after: async (user, ctx) => {
					if (!user || !ctx || !verifyingRequests.has(ctx)) return;
					if (
						!user.emailVerified ||
						user.role === "admin" ||
						!env.ADMIN_EMAILS.includes(user.email.toLowerCase())
					) {
						return;
					}
					await db
						.update(schema.user)
						.set({ role: "admin" })
						.where(eq(schema.user.id, user.id));
				},
			},
		},
		session: {
			create: {
				// Every new session starts in the user's personal organization.
				before: async (session) => {
					let activeOrganizationId = await findPersonalOrganizationId(
						session.userId,
					);
					if (!activeOrganizationId) {
						const [owner] = await db
							.select({ id: schema.user.id, name: schema.user.name })
							.from(schema.user)
							.where(eq(schema.user.id, session.userId))
							.limit(1);
						// A failure here must not lock the user out; the session
						// starts without an active org and the next one retries.
						try {
							if (owner) {
								activeOrganizationId = await ensurePersonalOrganization(owner);
							}
						} catch (error) {
							console.error("Failed to create personal organization", error);
						}
					}
					return { data: { ...session, activeOrganizationId } };
				},
			},
		},
	},
	plugins: [
		captcha({
			provider: "cloudflare-turnstile",
			secretKey: env.TURNSTILE_SECRET_KEY,
			// Every unauthenticated endpoint that creates an account, checks a
			// password or sends an email.
			endpoints: [
				"/sign-up/email",
				"/sign-in/email",
				"/email-otp/send-verification-otp",
				"/email-otp/request-password-reset",
			],
		}),
		haveIBeenPwned(),
		emailOTP({
			// Sends the sign-up verification email as an OTP instead of a link.
			overrideDefaultEmailVerification: true,
			// Never create accounts from an OTP; sign-up goes through
			// /sign-up/email so captcha and password checks apply.
			disableSignUp: true,
			expiresIn: OTP_EXPIRES_IN,
			storeOTP: "hashed",
			async sendVerificationOTP({ email, otp, type }) {
				const expiresInMinutes = OTP_EXPIRES_IN / 60;
				switch (type) {
					case "email-verification":
						await emailSender.send({
							to: email,
							...verificationOtpEmail({ otp, expiresInMinutes }),
						});
						return;
					case "forget-password":
						await emailSender.send({
							to: email,
							...passwordResetOtpEmail({ otp, expiresInMinutes }),
						});
						return;
					// Sign-in and change-email OTPs are disabled.
					case "sign-in":
					case "change-email":
						return;
				}
			},
		}),
		lastLoginMethod({
			// Email verification signs the user in, which the default resolver
			// doesn't recognize.
			customResolveMethod: (ctx) =>
				ctx.path === "/email-otp/verify-email" ? "email" : null,
		}),
		admin({
			impersonationSessionDuration: IMPERSONATION_SESSION_DURATION,
		}),
		organization({
			ac,
			roles,
			dynamicAccessControl: { enabled: true },
			teams: { enabled: true },
			// Users can't create orgs: each gets a personal one at sign-up and
			// joins others by invitation. The limit backs that up for the
			// server-side create.
			allowUserToCreateOrganization: false,
			organizationLimit: async (user) =>
				(await findPersonalOrganizationId(user.id)) !== undefined,
			// Every org is someone's personal org, which lasts as long as the
			// user does (personalOwnerId cascades on user delete).
			disableOrganizationDeletion: true,
			invitationExpiresIn: INVITATION_EXPIRES_IN,
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
			sendInvitationEmail: async ({
				id,
				email,
				role,
				organization,
				inviter,
			}) => {
				const url = new URL("/accept-invitation", env.APP_URL);
				url.searchParams.set("id", id);
				await emailSender.send({
					to: email,
					...organizationInvitationEmail({
						organizationName: organization.name,
						inviterName: inviter.user.name,
						role,
						url: url.toString(),
						expiresInHours: INVITATION_EXPIRES_IN / 3600,
					}),
				});
			},
			organizationHooks: {
				beforeCreateOrganization: async ({ user }) => ({
					data: { personalOwnerId: user.id },
				}),
				// The personal owner is the only owner, so the org can't be handed
				// over and its owner can't be pushed out.
				beforeAddMember: async ({ member, organization }) => {
					if (
						parseRoles(member.role).includes(OWNER_ROLE) &&
						member.userId !== organization.personalOwnerId
					) {
						throw forbidden(
							"CANNOT_ADD_OWNER",
							"Only the personal owner can have the owner role",
						);
					}
				},
				// Accepting an invitation adds the member without beforeAddMember.
				beforeAcceptInvitation: async ({ invitation }) => {
					if (parseRoles(invitation.role).includes(OWNER_ROLE)) {
						throw forbidden(
							"CANNOT_ADD_OWNER",
							"Only the personal owner can have the owner role",
						);
					}
				},
				beforeUpdateMemberRole: async ({ member, newRole, organization }) => {
					if (member.userId === organization.personalOwnerId) {
						throw forbidden(
							"CANNOT_CHANGE_OWNER_ROLE",
							"The owner's role can't be changed",
						);
					}
					if (parseRoles(newRole).includes(OWNER_ROLE)) {
						throw forbidden(
							"CANNOT_ASSIGN_OWNER_ROLE",
							"Only the personal owner can have the owner role",
						);
					}
				},
				beforeRemoveMember: async ({ member, organization }) => {
					if (member.userId === organization.personalOwnerId) {
						throw forbidden(
							"CANNOT_REMOVE_OWNER",
							"The owner can't be removed from their personal organization",
						);
					}
				},
			},
		}),
	],
});
