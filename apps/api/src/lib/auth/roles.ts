import { createAccessControl } from "better-auth/plugins/access";
import {
	adminAc,
	defaultStatements,
	memberAc,
	ownerAc,
} from "better-auth/plugins/organization/access";

export const OWNER_ROLE = "owner";
export const ADMIN_ROLE = "admin";

// Organization permissions. App resources go in `statements` so org admins can
// grant them through custom roles (dynamic access control).
const statements = {
	...defaultStatements,
} as const;

export const ac = createAccessControl(statements);

// Passing `roles` replaces the plugin defaults, so all three built-in roles
// must be listed.
export const roles = {
	owner: ac.newRole(ownerAc.statements),
	admin: ac.newRole(adminAc.statements),
	member: ac.newRole(memberAc.statements),
};

// Role strings may hold several comma-separated roles; request bodies may also
// send an array whose elements hold commas. Matches Better Auth's own parsing
// so a role can't slip past these checks and still be stored.
export function parseRoles(role: unknown): string[] {
	const list = Array.isArray(role) ? role : [role ?? ""];
	return list
		.flatMap((r) => String(r).split(","))
		.map((r) => r.trim())
		.filter(Boolean);
}
