import { expect } from "bun:test";
import { user, verification } from "@orbit/db/schema";
import { inArray } from "drizzle-orm";
import app from "../app";
import { db } from "../lib/db";
import { emailSender, MemoryEmailSender } from "../lib/email";

export const origin = "http://localhost:5173";

// The token Turnstile test site keys produce; accepted by the test secret.
export const CAPTCHA_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

if (!(emailSender instanceof MemoryEmailSender)) {
	throw new Error("Tests need EMAIL_PROVIDER=memory (see .env.test)");
}
export const outbox: MemoryEmailSender = emailSender;

// Random passwords so the breached-password check never trips by accident.
export function strongPassword(): string {
	return `pw-${crypto.randomUUID()}`;
}

export function uniqueEmail(label = "test"): string {
	return `${label}-${crypto.randomUUID()}@example.com`;
}

type RequestOptions = {
	method?: "GET" | "POST";
	body?: unknown;
	cookie?: string;
	// The Turnstile token to send, or false to send none.
	captcha?: string | false;
};

export function request(path: string, options: RequestOptions = {}) {
	const { method = "POST", body, cookie, captcha = CAPTCHA_TOKEN } = options;
	const headers: Record<string, string> = { Origin: origin };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	if (cookie) headers.Cookie = cookie;
	if (captcha) headers["x-captcha-response"] = captcha;
	return app.request(`/api/auth${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

// Turns a response's Set-Cookie headers into a Cookie request header. Later
// headers win, and cleared cookies are dropped.
export function cookiesFrom(res: Response): string {
	const cookies = new Map<string, string>();
	for (const header of res.headers.getSetCookie()) {
		const [pair = ""] = header.split(";");
		const separator = pair.indexOf("=");
		const name = separator === -1 ? pair : pair.slice(0, separator);
		const value = separator === -1 ? "" : pair.slice(separator + 1);
		if (value) cookies.set(name, value);
		else cookies.delete(name);
	}
	return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

export function latestOtp(email: string, subject: string): string {
	const message = outbox.latest(email);
	expect(message?.subject).toBe(subject);
	const otp = message?.text.match(/\b(\d{6})\b/)?.[1];
	if (!otp) throw new Error(`No OTP emailed to ${email}`);
	return otp;
}

// Better Auth stores email OTPs under `${type}-otp-${email}`.
const OTP_TYPES = ["email-verification", "forget-password", "sign-in"];

// Tracks users created by a test file so they can be removed afterwards, along
// with their OTPs (keyed by email, so they don't cascade).
export function createUserTracker() {
	const emails: string[] = [];
	return {
		track(email: string) {
			emails.push(email.toLowerCase());
			return email;
		},
		async cleanup() {
			if (emails.length === 0) return;
			await db.delete(user).where(inArray(user.email, emails));
			const otpIdentifiers = emails.flatMap((email) =>
				OTP_TYPES.map((type) => `${type}-otp-${email}`),
			);
			await db
				.delete(verification)
				.where(inArray(verification.identifier, otpIdentifiers));
		},
	};
}

export type SignedInUser = {
	id: string;
	email: string;
	password: string;
	cookie: string;
};

// Signs up, verifies the emailed OTP and returns the resulting session.
export async function signUpVerified(
	email: string,
	name = "Test User",
): Promise<SignedInUser> {
	const password = strongPassword();
	const signUp = await request("/sign-up/email", {
		body: { name, email, password },
	});
	expect(signUp.status).toBe(200);
	const { user: created } = (await signUp.json()) as { user: { id: string } };

	const verify = await request("/email-otp/verify-email", {
		body: { email, otp: latestOtp(email, "Verify your email") },
	});
	expect(verify.status).toBe(200);

	return { id: created.id, email, password, cookie: cookiesFrom(verify) };
}

export async function getSession(cookie: string) {
	const res = await request("/get-session", { method: "GET", cookie });
	expect(res.status).toBe(200);
	return (await res.json()) as {
		user: { id: string; email: string; role: string; emailVerified: boolean };
		session: {
			activeOrganizationId: string | null;
			impersonatedBy: string | null;
			expiresAt: string;
		};
	} | null;
}
