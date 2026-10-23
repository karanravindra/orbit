import { afterAll, describe, expect, test } from "bun:test";
import {
	cookiesFrom,
	createUserTracker,
	getSession,
	latestOtp,
	request,
	signUpVerified,
	strongPassword,
	uniqueEmail,
} from "../../../test-utils/helpers";
import {
	BREACHED_PASSWORDS,
	FAILING_CAPTCHA_TOKEN,
} from "../../../test-utils/setup";

// The test preload migrates an in-memory SQLite database.
const users = createUserTracker();

afterAll(() => users.cleanup());

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
