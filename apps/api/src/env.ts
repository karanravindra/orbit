import { z } from "zod";

const schema = z.object({
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
