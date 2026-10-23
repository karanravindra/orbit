// Isolated integration server. Never imported by the application or API entry points.
import {
	createApp,
	createAuth,
	MemoryEmailSender,
	parseEnv,
} from "@orbit/api/testing";
import { createLocalDb } from "@orbit/db/local";
import { applyMigrations } from "@orbit/db/migrate";
import { user } from "@orbit/db/schema";
import { eq } from "drizzle-orm";

const db = createLocalDb(":memory:");
await applyMigrations(db.$client);
const env = parseEnv({
	NODE_ENV: "test",
	BETTER_AUTH_URL: "http://127.0.0.1:3100",
	BETTER_AUTH_SECRET: "integration-tests-only-secret-at-least-32-characters",
	APP_URL: "http://127.0.0.1:5174",
	CORS_ORIGINS: "http://127.0.0.1:5174",
	TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
	EMAIL_PROVIDER: "memory",
});
const emailSender = new MemoryEmailSender();
const auth = createAuth({ db, env, emailSender });
const app = createApp({ db, env, emailSender, auth });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
	async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.startsWith("https://api.pwnedpasswords.com/range/"))
			return new Response("");
		if (url === "https://challenges.cloudflare.com/turnstile/v0/siteverify")
			return Response.json({ success: true });
		return originalFetch(input, init);
	},
	{ preconnect: originalFetch.preconnect },
);

Bun.serve({
	hostname: "127.0.0.1",
	port: 3100,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__test/email")
			return Response.json(
				emailSender.latest(url.searchParams.get("to") || "") || null,
			);
		if (url.pathname === "/__test/user" && request.method === "POST") {
			const body = (await request.json()) as {
				email: string;
				name: string;
				role?: "admin" | "user";
			};
			const created = await auth.api.createUser({
				body: { ...body, password: "Orbit-E2E-passphrase-739!" },
			});
			await db
				.update(user)
				.set({ emailVerified: true })
				.where(eq(user.id, created.user.id));
			return Response.json(created.user);
		}
		return app.fetch(request);
	},
});
