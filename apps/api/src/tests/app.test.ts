import { describe, expect, test } from "bun:test";
import { testClient } from "hono/testing";
import app from "../app";

const client = testClient(app);

describe("app", () => {
	test("GET /health returns ok", async () => {
		const res = await client.health.$get();
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});

	test("unknown routes return a JSON 404", async () => {
		const res = await app.request("/nope");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Not Found" });
	});

	test("sets request id and security headers", async () => {
		const res = await app.request("/health");
		expect(res.headers.get("X-Request-Id")).toBeTruthy();
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});
});

describe("cors", () => {
	test("allows configured origins with credentials", async () => {
		const res = await app.request("/health", {
			headers: { Origin: "http://localhost:5173" },
		});
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
			"http://localhost:5173",
		);
		expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
	});

	test("answers preflight requests", async () => {
		const res = await app.request("/api/auth/sign-in/email", {
			method: "OPTIONS",
			headers: {
				Origin: "http://localhost:5173",
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "content-type",
			},
		});
		expect(res.status).toBe(204);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
			"http://localhost:5173",
		);
	});

	test("rejects other origins", async () => {
		const res = await app.request("/health", {
			headers: { Origin: "https://evil.example" },
		});
		expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});
});
