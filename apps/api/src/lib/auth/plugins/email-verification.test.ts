import { afterAll, describe, expect, test } from "bun:test";
import {
	cookiesFrom,
	createUserTracker,
	getSession,
	latestOtp,
	outbox,
	request,
	signUpVerified,
	strongPassword,
	uniqueEmail,
} from "../../../test-utils/helpers";
import { auth } from "..";

// Requires the orbit_test database with migrations applied (bun run test:migrate).
const users = createUserTracker();

afterAll(() => users.cleanup());

describe("sign-up and email verification", () => {
	const email = users.track(uniqueEmail());
	const password = strongPassword();

	test("signs up without a session and emails a verification OTP", async () => {
		const res = await request("/sign-up/email", {
			body: { name: "Test User", email, password },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			token: string | null;
			user: { email: string; emailVerified: boolean; role: string };
		};
		expect(body.token).toBeNull();
		expect(body.user).toMatchObject({
			email,
			emailVerified: false,
			role: "user",
		});
		expect(res.headers.getSetCookie()).toEqual([]);
		expect(latestOtp(email, "Verify your email")).toHaveLength(6);
	});

	test("refuses to sign in before the email is verified", async () => {
		const res = await request("/sign-in/email", { body: { email, password } });
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
	});

	test("rejects a wrong OTP", async () => {
		const otp = latestOtp(email, "Verify your email");
		const wrong = otp === "000000" ? "111111" : "000000";
		const res = await request("/email-otp/verify-email", {
			body: { email, otp: wrong },
		});
		expect(res.status).toBe(400);
	});

	test("resends a verification OTP on request", async () => {
		const before = outbox.sent.length;
		const res = await request("/email-otp/send-verification-otp", {
			body: { email, type: "email-verification" },
		});
		expect(res.status).toBe(200);
		expect(outbox.sent.length).toBe(before + 1);
		expect(latestOtp(email, "Verify your email")).toHaveLength(6);
	});

	test("verifies the email with the OTP and signs the user in", async () => {
		const res = await request("/email-otp/verify-email", {
			body: { email, otp: latestOtp(email, "Verify your email") },
		});
		expect(res.status).toBe(200);
		const cookie = cookiesFrom(res);
		expect(cookie).toContain("better-auth.session_token");
		expect(cookie).toContain("better-auth.last_used_login_method=email");

		const session = await getSession(cookie);
		expect(session?.user).toMatchObject({ email, emailVerified: true });
	});

	test("sends verified users no verification OTP", async () => {
		const before = outbox.sent.length;
		const res = await request("/email-otp/send-verification-otp", {
			body: { email, type: "email-verification" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true });
		expect(outbox.sent.length).toBe(before);
	});

	test("verification OTPs can't sign in a verified user", async () => {
		// A code issued before verification, or by any other means, must not
		// work as a passwordless sign-in.
		const otp = await auth.api.createVerificationOTP({
			body: { email, type: "email-verification" },
		});
		const res = await request("/email-otp/verify-email", {
			body: { email, otp },
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "INVALID_OTP" });
		expect(res.headers.getSetCookie()).toEqual([]);
	});

	test("duplicate sign-ups look like a fresh sign-up", async () => {
		const res = await request("/sign-up/email", {
			body: { name: "Someone Else", email, password: strongPassword() },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { token: null; user: object };
		expect(body.token).toBeNull();
		expect(Object.keys(body.user).sort()).toEqual(
			[
				"id",
				"name",
				"email",
				"emailVerified",
				"image",
				"createdAt",
				"updatedAt",
				"role",
				"banned",
				"banReason",
				"banExpires",
			].sort(),
		);
	});
});

describe("sign-up squatting", () => {
	const email = users.track(uniqueEmail());
	const squatterPassword = strongPassword();

	test("the inbox owner takes over an unverified account without its password", async () => {
		// Someone signs up with an address they don't own and never verifies it.
		const squat = await request("/sign-up/email", {
			body: { name: "Squatter", email, password: squatterPassword },
		});
		expect(squat.status).toBe(200);

		// The real owner signs up, is emailed a fresh code and verifies.
		const ownerPassword = strongPassword();
		const before = outbox.sent.length;
		const signUp = await request("/sign-up/email", {
			body: { name: "Owner", email, password: ownerPassword },
		});
		expect(signUp.status).toBe(200);
		expect(outbox.sent.length).toBe(before + 1);
		const verify = await request("/email-otp/verify-email", {
			body: { email, otp: latestOtp(email, "Verify your email") },
		});
		expect(verify.status).toBe(200);
		expect((await getSession(cookiesFrom(verify)))?.user.email).toBe(email);

		// The squatter's password no longer works.
		const squatterSignIn = await request("/sign-in/email", {
			body: { email, password: squatterPassword },
		});
		expect(squatterSignIn.status).toBe(401);

		// The owner sets their own password with a reset code.
		await request("/email-otp/request-password-reset", { body: { email } });
		const reset = await request("/email-otp/reset-password", {
			body: {
				email,
				otp: latestOtp(email, "Reset your password"),
				password: ownerPassword,
			},
		});
		expect(reset.status).toBe(200);
		const ownerSignIn = await request("/sign-in/email", {
			body: { email, password: ownerPassword },
		});
		expect(ownerSignIn.status).toBe(200);
	});

	test("signing up again leaves a verified account's password alone", async () => {
		const verifiedEmail = users.track(uniqueEmail());
		const { password } = await signUpVerified(verifiedEmail);
		const res = await request("/sign-up/email", {
			body: {
				name: "Someone Else",
				email: verifiedEmail,
				password: strongPassword(),
			},
		});
		expect(res.status).toBe(200);
		const signIn = await request("/sign-in/email", {
			body: { email: verifiedEmail, password },
		});
		expect(signIn.status).toBe(200);
	});
});
