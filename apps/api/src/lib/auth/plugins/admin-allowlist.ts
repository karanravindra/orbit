import * as schema from "@orbit/db/schema";
import type { BetterAuthPlugin } from "better-auth";
import { eq } from "drizzle-orm";
import { db } from "../../db";

// Allowlisted emails become platform admins when they are verified, never at
// sign-up, so nobody can squat an admin address. The self-service flows only
// write emailVerified: true for unverified users (verify-email is blocked for
// verified ones and reset only sets it when false), so a revoked role isn't
// re-granted.
export function adminAllowlist({ emails }: { emails: string[] }) {
	// Requests that set emailVerified: true. update.before only sees the patch
	// and update.after only sees the row, so this links the two for the same
	// request.
	const verifyingRequests = new WeakSet<object>();

	return {
		id: "admin-allowlist",
		init: () => ({
			options: {
				databaseHooks: {
					user: {
						update: {
							before: async (data, ctx) => {
								if (ctx && data.emailVerified === true) {
									verifyingRequests.add(ctx);
								}
							},
							after: async (user, ctx) => {
								if (!user || !ctx || !verifyingRequests.has(ctx)) return;
								if (
									!user.emailVerified ||
									user.role === "admin" ||
									!emails.includes(user.email.toLowerCase())
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
				},
			},
		}),
	} satisfies BetterAuthPlugin;
}
