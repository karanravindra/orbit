import { z } from "zod";

// Senders that don't deliver mail. The console one logs codes and links, which
// would let anyone with log access take over accounts.
const NON_DELIVERING_EMAIL_PROVIDERS = new Set(["console", "memory"]);

const schema = z
	.object({
		// Unset means production so the checks below can't be skipped by a
		// forgotten variable; dev and tests opt out explicitly.
		NODE_ENV: z
			.enum(["development", "test", "production"])
			.default("production"),
		PORT: z.coerce.number().int().positive().default(3000),
		DATABASE_URL: z.url(),
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
		// Which EmailSender to use: "console" logs emails, "memory" keeps them in
		// memory for tests. Neither is allowed in production.
		EMAIL_PROVIDER: z.enum(["console", "memory"]).default("console"),
		EMAIL_FROM: z.string().min(1).default("Orbit <noreply@localhost>"),
	})
	.superRefine((env, ctx) => {
		if (env.NODE_ENV !== "production") return;
		if (NON_DELIVERING_EMAIL_PROVIDERS.has(env.EMAIL_PROVIDER)) {
			ctx.addIssue({
				code: "custom",
				path: ["EMAIL_PROVIDER"],
				message: `"${env.EMAIL_PROVIDER}" doesn't deliver email and can't be used in production`,
			});
		}
	});

const result = schema.safeParse(process.env);

if (!result.success) {
	console.error(
		"Invalid environment variables:\n",
		z.prettifyError(result.error),
	);
	process.exit(1);
}

export const env = result.data;
