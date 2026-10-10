import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import * as schema from "@orbit/db/schema";
import { betterAuth } from "better-auth/minimal";
import {
	admin,
	captcha,
	emailOTP,
	haveIBeenPwned,
	lastLoginMethod,
	organization,
} from "better-auth/plugins";
import { db } from "../db";
import { emailSender, organizationInvitationEmail } from "../email";
import { env } from "../env";
import { adminAllowlist } from "./plugins/admin-allowlist";
import {
	emailVerificationGuards,
	OTP_EXPIRES_IN,
	releaseUnverifiedAccount,
	sendOtpEmail,
} from "./plugins/email-verification";
import { memberGuards } from "./plugins/member-guards";
import {
	personalOrganization,
	personalOrganizationOptions,
} from "./plugins/personal-organization";
import { ac, roles } from "./roles";

// Durations are in seconds, like Better Auth's options.
const INVITATION_EXPIRES_IN = 60 * 60 * 48;
const IMPERSONATION_SESSION_DURATION = 60 * 60;

export const auth = betterAuth({
	baseURL: env.BETTER_AUTH_URL,
	secret: env.BETTER_AUTH_SECRET,
	trustedOrigins: env.CORS_ORIGINS,
	database: drizzleAdapter(db, { provider: "pg", schema }),
	emailAndPassword: {
		enabled: true,
		requireEmailVerification: true,
		// A reset may follow a compromise, so sign out every existing session.
		revokeSessionsOnPasswordReset: true,
		onExistingUserSignUp: ({ user }) =>
			releaseUnverifiedAccount(user, createVerificationOtp),
		// Duplicate sign-ups get a fake user back; give it the admin plugin's
		// fields so it is indistinguishable from a real one.
		customSyntheticUser: ({ coreFields, additionalFields, id }) => ({
			...coreFields,
			role: "user",
			banned: false,
			banReason: null,
			banExpires: null,
			...additionalFields,
			id,
		}),
	},
	emailVerification: {
		// The verification email is an OTP (see emailOTP below); verifying it
		// signs the user in. Only unverified users can verify (see
		// emailVerificationGuards), so this never works as a passwordless sign-in.
		autoSignInAfterVerification: true,
	},
	// OTPs are only for email verification and password reset, so the link
	// flows, OTP sign-in and the deprecated reset alias are switched off.
	disabledPaths: [
		"/sign-in/email-otp",
		"/forget-password/email-otp",
		"/send-verification-email",
		"/verify-email",
		"/request-password-reset",
		"/reset-password",
	],
	plugins: [
		captcha({
			provider: "cloudflare-turnstile",
			secretKey: env.TURNSTILE_SECRET_KEY,
			// Every unauthenticated endpoint that creates an account, checks a
			// password or sends an email.
			endpoints: [
				"/sign-up/email",
				"/sign-in/email",
				"/email-otp/send-verification-otp",
				"/email-otp/request-password-reset",
			],
		}),
		haveIBeenPwned(),
		emailOTP({
			// Sends the sign-up verification email as an OTP instead of a link.
			overrideDefaultEmailVerification: true,
			// Never create accounts from an OTP; sign-up goes through
			// /sign-up/email so captcha and password checks apply.
			disableSignUp: true,
			expiresIn: OTP_EXPIRES_IN,
			storeOTP: "hashed",
			sendVerificationOTP: sendOtpEmail,
		}),
		lastLoginMethod({
			// Email verification signs the user in, which the default resolver
			// doesn't recognize.
			customResolveMethod: (ctx) =>
				ctx.path === "/email-otp/verify-email" ? "email" : null,
		}),
		admin({
			impersonationSessionDuration: IMPERSONATION_SESSION_DURATION,
		}),
		organization({
			ac,
			roles,
			dynamicAccessControl: { enabled: true },
			teams: { enabled: true },
			invitationExpiresIn: INVITATION_EXPIRES_IN,
			sendInvitationEmail: async ({
				id,
				email,
				role,
				organization,
				inviter,
			}) => {
				const url = new URL("/accept-invitation", env.APP_URL);
				url.searchParams.set("id", id);
				await emailSender.send({
					to: email,
					...organizationInvitationEmail({
						organizationName: organization.name,
						inviterName: inviter.user.name,
						role,
						url: url.toString(),
						expiresInHours: INVITATION_EXPIRES_IN / 3600,
					}),
				});
			},
			...personalOrganizationOptions,
		}),
		// Local plugins. Hooks run in plugin order, so these come after admin()
		// (its banned-user check runs before a session gets an active org), and
		// personalOrganization() comes before memberGuards() (an owner invitation
		// is refused as such before the inviter's role is checked).
		personalOrganization({ createOrganization }),
		memberGuards(),
		emailVerificationGuards(),
		adminAllowlist({ emails: env.ADMIN_EMAILS }),
	],
});

// Server-side calls the local plugins need. They're passed in rather than
// imported, which would be an import cycle; the explicit return types stop
// TypeScript from inferring `auth` from itself.
function createOrganization(body: {
	name: string;
	slug: string;
	userId: string;
}): Promise<{ id: string }> {
	return auth.api.createOrganization({ body });
}

function createVerificationOtp(email: string): Promise<string> {
	return auth.api.createVerificationOTP({
		body: { email, type: "email-verification" },
	});
}
