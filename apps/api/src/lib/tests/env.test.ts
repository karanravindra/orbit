import { describe, expect, test } from "bun:test";
import { parseEnv } from "../env";

const production = {
	BETTER_AUTH_SECRET: "test-secret-with-at-least-32-characters",
	BETTER_AUTH_URL: "https://api.example.com",
	APP_URL: "https://app.example.com",
	CORS_ORIGINS: "https://app.example.com",
	TURNSTILE_SECRET_KEY: "real-turnstile-secret",
	EMAIL_PROVIDER: "resend",
	EMAIL_FROM: "Orbit <mail@example.com>",
	RESEND_API_KEY: "test-resend-key",
};

describe("production environment", () => {
	test("defaults to production and accepts delivering email configuration", () => {
		expect(parseEnv(production).NODE_ENV).toBe("production");
	});
	test("requires the selected provider's credentials", () => {
		expect(() =>
			parseEnv({ ...production, RESEND_API_KEY: undefined }),
		).toThrow("RESEND_API_KEY");
	});
	test("rejects development email, captcha secrets, and insecure public URLs", () => {
		for (const override of [
			{ EMAIL_PROVIDER: "console" },
			{ EMAIL_PROVIDER: "memory" },
			{ TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA" },
			{ BETTER_AUTH_URL: "http://api.example.com" },
			{ APP_URL: "http://app.example.com" },
		])
			expect(() => parseEnv({ ...production, ...override })).toThrow();
	});
	test("parses explicit origins and normalizes admin email addresses", () => {
		const env = parseEnv({
			...production,
			CORS_ORIGINS: "https://app.example.com, https://other.example.com",
			ADMIN_EMAILS: "Admin@Example.com, ",
		});
		expect(env.CORS_ORIGINS).toEqual([
			"https://app.example.com",
			"https://other.example.com",
		]);
		expect(env.ADMIN_EMAILS).toEqual(["admin@example.com"]);
	});
});
