import { afterAll, describe, expect, test } from "bun:test";
import { user } from "@orbit/db/schema";
import { eq } from "drizzle-orm";
import app from "../app";
import { db } from "../lib/db";

// Requires the Postgres service from compose.yml with migrations applied.
const email = `test-${crypto.randomUUID()}@example.com`;
const password = "correct-horse-battery-staple";
const origin = "http://localhost:5173";

function post(path: string, body: unknown) {
	return app.request(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: origin },
		body: JSON.stringify(body),
	});
}

afterAll(async () => {
	await db.delete(user).where(eq(user.email, email));
});

describe("email + password auth", () => {
	test("signs up a new user", async () => {
		const res = await post("/api/auth/sign-up/email", {
			name: "Test User",
			email,
			password,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { user: { email: string } };
		expect(body.user.email).toBe(email);
	});

	test("signs in and returns a session for the cookie", async () => {
		const signIn = await post("/api/auth/sign-in/email", { email, password });
		expect(signIn.status).toBe(200);

		const cookie = signIn.headers.get("Set-Cookie");
		expect(cookie).toContain("better-auth.session_token");

		const session = await app.request("/api/auth/get-session", {
			headers: { Cookie: cookie ?? "", Origin: origin },
		});
		const body = (await session.json()) as { user: { email: string } };
		expect(body.user.email).toBe(email);
	});

	test("rejects a wrong password", async () => {
		const res = await post("/api/auth/sign-in/email", {
			email,
			password: "wrong-password",
		});
		expect(res.status).toBe(401);
	});
});
