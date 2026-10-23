import { expect, test } from "bun:test";
import { ResendEmailSender } from "../resend";

const message = {
	to: "user@example.com",
	subject: "Verify",
	text: "Code 123456",
	html: "<p>123456</p>",
};

test("Resend sends the complete generic message with the configured sender", async () => {
	const sender = new ResendEmailSender(
		"test-key",
		"Orbit <mail@example.com>",
		async (url, init) => {
			expect(url).toBe("https://api.resend.com/emails");
			expect(init.method).toBe("POST");
			expect(new Headers(init.headers).get("Authorization")).toBe(
				"Bearer test-key",
			);
			expect(JSON.parse(String(init.body))).toEqual({
				from: "Orbit <mail@example.com>",
				...message,
			});
			expect(init.signal).toBeInstanceOf(AbortSignal);
			return Response.json({ id: "email-1" });
		},
	);
	await sender.send(message);
});

test("Resend rejects delivery failures without exposing provider response details", async () => {
	const sender = new ResendEmailSender(
		"test-key",
		"Orbit <mail@example.com>",
		async () => new Response("private recipient data", { status: 429 }),
	);
	await expect(sender.send(message)).rejects.toThrow(
		"Email delivery failed (Resend HTTP 429)",
	);
});
