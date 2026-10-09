import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import * as schema from "@orbit/db/schema";
import { betterAuth } from "better-auth/minimal";
import { env } from "../env";
import { db } from "./db";

export const auth = betterAuth({
	baseURL: env.BETTER_AUTH_URL,
	secret: env.BETTER_AUTH_SECRET,
	trustedOrigins: env.CORS_ORIGINS,
	database: drizzleAdapter(db, { provider: "pg", schema }),
	emailAndPassword: {
		enabled: true,
	},
});
