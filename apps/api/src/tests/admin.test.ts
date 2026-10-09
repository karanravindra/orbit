import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { organization, user } from "@orbit/db/schema";
import { eq } from "drizzle-orm";
import { env } from "../env";
import { auth } from "../lib/auth";
import { db } from "../lib/db";
import {
	cookiesFrom,
	createUserTracker,
	getSession,
	latestOtp,
	request,
	type SignedInUser,
	signUpVerified,
	strongPassword,
	uniqueEmail,
} from "./helpers";

// Requires the Postgres service from compose.yml with migrations applied.
const adminEmail = env.ADMIN_EMAILS[0];
if (!adminEmail) throw new Error("Tests need ADMIN_EMAILS (see .env.test)");

const users = createUserTracker();

async function roleOf(email: string) {
	const [row] = await db
		.select({ role: user.role })
		.from(user)
		.where(eq(user.email, email));
	return row?.role;
}

beforeAll(async () => {
	// The allowlisted address is fixed, so clear any leftover from a failed run.
	await db.delete(user).where(eq(user.email, adminEmail));
	users.track(adminEmail);
});

afterAll(() => users.cleanup());

describe("platform admin bootstrap", () => {
	const password = strongPassword();
	let admin: SignedInUser;

	test("allowlisted emails are plain users until verified", async () => {
		const res = await request("/sign-up/email", {
			body: { name: "Admin", email: adminEmail, password },
		});
		expect(res.status).toBe(200);
		expect(await roleOf(adminEmail)).toBe("user");
	});

	test("become admins when their email is verified", async () => {
		const res = await request("/email-otp/verify-email", {
			body: {
				email: adminEmail,
				otp: latestOtp(adminEmail, "Verify your email"),
			},
		});
		expect(res.status).toBe(200);
		expect(await roleOf(adminEmail)).toBe("admin");

		const cookie = cookiesFrom(res);
		const [row] = await db
			.select()
			.from(user)
			.where(eq(user.email, adminEmail));
		admin = { id: row?.id ?? "", email: adminEmail, password, cookie };
		expect((await getSession(cookie))?.user.role).toBe("admin");
	});

	test("other emails stay users after verification", async () => {
		const email = users.track(uniqueEmail());
		await signUpVerified(email);
		expect(await roleOf(email)).toBe("user");
	});

	test("a revoked admin role is not re-granted", async () => {
		await db.update(user).set({ role: "user" }).where(eq(user.id, admin.id));
		try {
			const update = await request("/update-user", {
				cookie: admin.cookie,
				body: { name: "Renamed Admin" },
			});
			expect(update.status).toBe(200);
			expect(await roleOf(adminEmail)).toBe("user");

			// Verifying the already-verified address again is refused.
			const otp = await auth.api.createVerificationOTP({
				body: { email: adminEmail, type: "email-verification" },
			});
			const verify = await request("/email-otp/verify-email", {
				body: { email: adminEmail, otp },
			});
			expect(verify.status).toBe(400);
			expect(await roleOf(adminEmail)).toBe("user");
		} finally {
			await db.update(user).set({ role: "admin" }).where(eq(user.id, admin.id));
		}
	});

	test("admins can impersonate users for one hour", async () => {
		const email = users.track(uniqueEmail());
		const target = await signUpVerified(email);
		const [targetOrg] = await db
			.select()
			.from(organization)
			.where(eq(organization.personalOwnerId, target.id));

		const res = await request("/admin/impersonate-user", {
			cookie: admin.cookie,
			body: { userId: target.id },
		});
		expect(res.status).toBe(200);

		const session = await getSession(cookiesFrom(res));
		expect(session?.user.id).toBe(target.id);
		expect(session?.session.impersonatedBy).toBe(admin.id);
		expect(session?.session.activeOrganizationId).toBe(targetOrg?.id ?? "");
		const minutes =
			(new Date(session?.session.expiresAt ?? 0).getTime() - Date.now()) /
			60_000;
		expect(minutes).toBeGreaterThan(59);
		expect(minutes).toBeLessThanOrEqual(60);
	});

	test("regular users cannot use admin endpoints", async () => {
		const regular = await signUpVerified(users.track(uniqueEmail()));
		const res = await request("/admin/impersonate-user", {
			cookie: regular.cookie,
			body: { userId: admin.id },
		});
		expect(res.status).toBe(403);
	});
});
