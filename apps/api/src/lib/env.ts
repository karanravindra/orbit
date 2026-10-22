import { z } from "zod";

// Cloudflare's documented Turnstile test secrets (always pass, always fail,
// token already spent). Fine for dev and tests, never for production.
const TURNSTILE_TEST_SECRETS = new Set([
	"1x0000000000000000000000000000000AA",
	"2x0000000000000000000000000000000AA",
	"3x0000000000000000000000000000000AA",
]);

// Senders that don't deliver mail. The console one logs codes and links, which
// would let anyone with log access take over accounts.
const NON_DELIVERING_EMAIL_PROVIDERS = new Set(["console", "memory"]);

export const envSchema = z
	.object({
		// Unset means production so the checks below can't be skipped by a
		// forgotten variable; dev and tests opt out explicitly.
		NODE_ENV: z
			.enum(["development", "test", "production"])
			.default("production"),
		PORT: z.coerce.number().int().min(1).max(65535).default(3000),
		DATABASE_PATH: z.string().min(1).default("../../orbit.sqlite"),
		SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
		MAX_BODY_BYTES: z.coerce.number().int().positive().default(1048576),
		// Generate one with `openssl rand -base64 32`.
		BETTER_AUTH_SECRET: z.string().min(32),
		// Public URL of this API; Better Auth uses it for callbacks and redirects.
		BETTER_AUTH_URL: z.url().default("http://localhost:3000"),
		// Comma-separated list of origins allowed to make credentialed requests.
		// Also used as Better Auth's trustedOrigins.
		CORS_ORIGINS: z
			.string()
			.default("http://localhost:5173")
			.transform((value) => value.split(",").map((origin) => origin.trim()))
			.pipe(z.array(z.url())),
		// Public URL of the web app; used to build links in emails (e.g. invitations).
		APP_URL: z.url().default("http://localhost:5173"),
		// Comma-separated allowlist of emails that become platform admins once
		// their address is verified.
		ADMIN_EMAILS: z
			.string()
			.default("")
			.transform((value) =>
				value
					.split(",")
					.map((email) => email.trim().toLowerCase())
					.filter(Boolean),
			)
			.pipe(z.array(z.email())),
		// Cloudflare Turnstile secret. For local dev and tests use Cloudflare's
		// always-pass test secret: 1x0000000000000000000000000000000AA
		// (rejected in production).
		TURNSTILE_SECRET_KEY: z.string().min(1),
		// Which EmailSender to use: "console" logs emails, "memory" keeps them in
		// memory for tests. Neither is allowed in production.
		EMAIL_PROVIDER: z.enum(["console", "memory", "resend"]).default("console"),
		EMAIL_FROM: z.string().min(1).default("Orbit <noreply@localhost>"),
		RESEND_API_KEY: z.string().min(1).optional(),
	})
	.superRefine((env, ctx) => {
		if (env.EMAIL_PROVIDER === "resend" && !env.RESEND_API_KEY) {
			ctx.addIssue({
				code: "custom",
				path: ["RESEND_API_KEY"],
				message: "Required for Resend delivery",
			});
		}
		if (env.NODE_ENV !== "production") return;
		for (const key of ["BETTER_AUTH_URL", "APP_URL"] as const) {
			if (!env[key].startsWith("https://"))
				ctx.addIssue({
					code: "custom",
					path: [key],
					message: "Production URLs must use HTTPS",
				});
		}
		if (TURNSTILE_TEST_SECRETS.has(env.TURNSTILE_SECRET_KEY)) {
			ctx.addIssue({
				code: "custom",
				path: ["TURNSTILE_SECRET_KEY"],
				message: "Cloudflare's test secrets can't be used in production",
			});
		}
		if (NON_DELIVERING_EMAIL_PROVIDERS.has(env.EMAIL_PROVIDER)) {
			ctx.addIssue({
				code: "custom",
				path: ["EMAIL_PROVIDER"],
				message: `"${env.EMAIL_PROVIDER}" doesn't deliver email and can't be used in production`,
			});
		}
	});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(input: Record<string, unknown>): Env {
	const result = envSchema.safeParse(input);
	if (!result.success)
		throw new Error(
			`Invalid environment variables:\n${z.prettifyError(result.error)}`,
		);
	return result.data;
}
