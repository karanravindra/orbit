import { afterAll, describe, expect, test } from "bun:test";
import { auth } from "../lib/auth";
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
} from "./helpers";
import { BREACHED_PASSWORDS, FAILING_CAPTCHA_TOKEN } from "./setup";

// Requires the Postgres service from compose.yml with migrations applied.
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

describe("email + password sign-in", () => {
	const email = users.track(uniqueEmail());
	let password: string;

	test("signs in a verified user and returns a session cookie", async () => {
		({ password } = await signUpVerified(email));
		const res = await request("/sign-in/email", { body: { email, password } });
		expect(res.status).toBe(200);
		const cookie = cookiesFrom(res);
		expect(cookie).toContain("better-auth.session_token");
		expect(cookie).toContain("better-auth.last_used_login_method=email");
		expect((await getSession(cookie))?.user.email).toBe(email);
	});

	test("rejects a wrong password", async () => {
		const res = await request("/sign-in/email", {
			body: { email, password: strongPassword() },
		});
		expect(res.status).toBe(401);
	});
});

describe("password reset via OTP", () => {
	const email = users.track(uniqueEmail());

	test("resets the password with an emailed OTP and signs out other sessions", async () => {
		const { password: oldPassword, cookie } = await signUpVerified(email);
		expect(await getSession(cookie)).not.toBeNull();

		const requested = await request("/email-otp/request-password-reset", {
			body: { email },
		});
		expect(requested.status).toBe(200);

		const newPassword = strongPassword();
		const reset = await request("/email-otp/reset-password", {
			body: {
				email,
				otp: latestOtp(email, "Reset your password"),
				password: newPassword,
			},
		});
		expect(reset.status).toBe(200);
		expect(await getSession(cookie)).toBeNull();

		const oldSignIn = await request("/sign-in/email", {
			body: { email, password: oldPassword },
		});
		expect(oldSignIn.status).toBe(401);
		const newSignIn = await request("/sign-in/email", {
			body: { email, password: newPassword },
		});
		expect(newSignIn.status).toBe(200);
	});

	test("rejects a breached new password", async () => {
		await request("/email-otp/request-password-reset", { body: { email } });
		const res = await request("/email-otp/reset-password", {
			body: {
				email,
				otp: latestOtp(email, "Reset your password"),
				password: BREACHED_PASSWORDS[0],
			},
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "PASSWORD_COMPROMISED" });
	});
});

describe("abuse protection", () => {
	test("rejects a breached password at sign-up", async () => {
		const email = users.track(uniqueEmail());
		const res = await request("/sign-up/email", {
			body: { name: "Test User", email, password: BREACHED_PASSWORDS[0] },
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "PASSWORD_COMPROMISED" });
	});

	test.each([
		["/sign-up/email", { name: "x", email: "x@example.com", password: "x" }],
		["/sign-in/email", { email: "x@example.com", password: "x" }],
		[
			"/email-otp/send-verification-otp",
			{ email: "x@example.com", type: "email-verification" },
		],
		["/email-otp/request-password-reset", { email: "x@example.com" }],
	])("requires a captcha token on %s", async (path, body) => {
		const res = await request(path, { body, captcha: false });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "MISSING_RESPONSE" });
	});

	test("rejects a token Turnstile fails", async () => {
		const res = await request("/sign-in/email", {
			body: { email: "x@example.com", password: "x" },
			captcha: FAILING_CAPTCHA_TOKEN,
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ code: "VERIFICATION_FAILED" });
	});

	test("does not offer OTP sign-in", async () => {
		const signIn = await request("/sign-in/email-otp", {
			body: { email: "x@example.com", otp: "123456" },
		});
		expect(signIn.status).toBe(404);

		const send = await request("/email-otp/send-verification-otp", {
			body: { email: "x@example.com", type: "sign-in" },
		});
		expect(send.status).toBe(400);
		expect(await send.json()).toMatchObject({ code: "OTP_SIGN_IN_DISABLED" });
	});

	test.each([
		"/send-verification-email",
		"/verify-email",
		"/request-password-reset",
		"/reset-password",
		"/forget-password/email-otp",
	])("disables the link-based flow %s", async (path) => {
		const res = await request(path, { body: { email: "x@example.com" } });
		expect(res.status).toBe(404);
	});
});
