import * as schema from "@orbit/db/schema";
import type { BetterAuthPlugin } from "better-auth";
import {
	APIError,
	createAuthMiddleware,
	getSessionFromCtx,
} from "better-auth/api";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { MEMBER_GUARD_ERROR_CODES as ERRORS } from "../errors";
import { ADMIN_ROLE, OWNER_ROLE, parseRoles } from "../roles";

// Only these org roles may invite members or hand out the admin role, whatever
// permissions a custom role is given.
const MANAGER_ROLES = [OWNER_ROLE, ADMIN_ROLE];

// The org an organization endpoint acts on, resolved the way Better Auth does
// (an empty organizationId falls back to the active org).
function targetOrganizationId(
	body: { organizationId?: unknown } | undefined,
	activeOrganizationId: string | null | undefined,
): string | undefined {
	const organizationId = body?.organizationId || activeOrganizationId;
	return typeof organizationId === "string" ? organizationId : undefined;
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
	ctx: Parameters<typeof getSessionFromCtx>[0],
	error: keyof typeof ERRORS,
): Promise<void> {
	const session = await getSessionFromCtx(ctx);
	if (!session) return;
	const organizationId = targetOrganizationId(
		ctx.body,
		session.session.activeOrganizationId,
	);
	if (!organizationId) return;
	const memberRoles = await findMemberRoles(session.user.id, organizationId);
	if (!memberRoles.some((role) => MANAGER_ROLES.includes(role))) {
		throw APIError.from("FORBIDDEN", ERRORS[error]);
	}
}

export function memberGuards() {
	return {
		id: "member-guards",
		$ERROR_CODES: ERRORS,
		hooks: {
			before: [
				{
					// Custom roles may be granted invitation:create, but only owners and
					// admins may invite.
					matcher: (ctx) => ctx.path === "/organization/invite-member",
					handler: createAuthMiddleware(async (ctx) => {
						await assertManager(ctx, "ONLY_OWNERS_AND_ADMINS_CAN_INVITE");
					}),
				},
				{
					// Otherwise a custom role with member:update could make its holder an
					// admin, who can invite.
					matcher: (ctx) => ctx.path === "/organization/update-member-role",
					handler: createAuthMiddleware(async (ctx) => {
						if (!parseRoles(ctx.body?.role).includes(ADMIN_ROLE)) return;
						await assertManager(ctx, "ONLY_OWNERS_AND_ADMINS_CAN_ASSIGN_ADMIN");
					}),
				},
			],
		},
	} satisfies BetterAuthPlugin;
}
