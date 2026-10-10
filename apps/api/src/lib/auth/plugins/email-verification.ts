import * as schema from "@orbit/db/schema";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { EmailOTPOptions } from "better-auth/plugins";
import { and, eq } from "drizzle-orm";
import {
	emailSender,
	passwordResetOtpEmail,
	verificationOtpEmail,
} from "../../../email";
import { db } from "../../db";
import { EMAIL_VERIFICATION_ERROR_CODES as ERRORS } from "../errors";

// In seconds, like Better Auth's options.
export const OTP_EXPIRES_IN = 60 * 5;

// Emails the codes the email OTP plugin issues.
export async function sendOtpEmail({
	email,
	otp,
	type,
}: Parameters<EmailOTPOptions["sendVerificationOTP"]>[0]): Promise<void> {
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

// Signing up again with the email of an unverified account means nobody has
// proven they own it yet, so whoever set its password may be squatting it.
// Drop that password: the inbox owner verifies, gets signed in and sets a
// password with a reset code; the squatter is locked out. A fresh code goes
// out so a real user signing up twice isn't stuck.
export async function releaseUnverifiedAccount(
	user: { id: string; email: string; emailVerified: boolean },
	createVerificationOtp: (email: string) => Promise<string>,
): Promise<void> {
	if (user.emailVerified) return;
	await db
		.delete(schema.account)
		.where(
			and(
				eq(schema.account.userId, user.id),
				eq(schema.account.providerId, "credential"),
			),
		);
	const otp = await createVerificationOtp(user.email);
	await sendOtpEmail({ email: user.email, otp, type: "email-verification" });
}

// Verifying an email signs the user in, so verification codes only go to, and
// only work for, unverified users. That way they never work as a passwordless
// sign-in.
export function emailVerificationGuards() {
	return {
		id: "email-verification-guards",
		$ERROR_CODES: ERRORS,
		hooks: {
			before: [
				{
					matcher: (ctx) => ctx.path === "/email-otp/send-verification-otp",
					handler: createAuthMiddleware(async (ctx) => {
						if (ctx.body?.type === "sign-in") {
							throw APIError.from("BAD_REQUEST", ERRORS.OTP_SIGN_IN_DISABLED);
						}
						// The response matches a real send to avoid leaking who is
						// verified.
						if (
							ctx.body?.type === "email-verification" &&
							(await isEmailVerified(ctx.body?.email))
						) {
							return ctx.json({ success: true });
						}
					}),
				},
				{
					// Backs up the check above for codes issued before verification.
					matcher: (ctx) => ctx.path === "/email-otp/verify-email",
					handler: createAuthMiddleware(async (ctx) => {
						if (await isEmailVerified(ctx.body?.email)) {
							throw APIError.from("BAD_REQUEST", ERRORS.INVALID_OTP);
						}
					}),
				},
			],
		},
	} satisfies BetterAuthPlugin;
}
