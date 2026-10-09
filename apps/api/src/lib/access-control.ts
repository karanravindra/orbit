import { createAccessControl } from "better-auth/plugins/access";
import {
	adminAc,
	defaultStatements,
	memberAc,
	ownerAc,
} from "better-auth/plugins/organization/access";

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
