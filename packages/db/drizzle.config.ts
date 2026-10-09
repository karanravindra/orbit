import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "postgresql",
	schema: "./src/schema/index.ts",
	out: "./migrations",
	dbCredentials: {
		// Falls back to the Postgres service in compose.yml for local dev.
		url:
			process.env.DATABASE_URL ?? "postgres://orbit:orbit@localhost:5432/orbit",
	},
});
