import { describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { notFound, onError } from "../errors";

const app = new Hono()
	.get("/limited", () => {
		throw new HTTPException(429, { message: "Slow down" });
	})
	.get("/forbidden", () => {
		throw new HTTPException(403);
	})
	.get("/broken", () => {
		throw new Error("database password is hunter2");
	});
app.notFound(notFound);
app.onError(onError);

describe("error responses", () => {
	test("unknown routes return NOT_FOUND", async () => {
		const res = await app.request("/nope");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({
			code: "NOT_FOUND",
			message: "Not Found",
		});
	});

	test("HTTP exceptions keep their status and message", async () => {
		const res = await app.request("/limited");
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({
			code: "TOO_MANY_REQUESTS",
			message: "Slow down",
		});
	});

	test("HTTP exceptions without a message use the status text", async () => {
		const res = await app.request("/forbidden");
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			code: "FORBIDDEN",
			message: "Forbidden",
		});
	});

	test("unexpected errors are logged but not exposed", async () => {
		const log = spyOn(console, "error").mockImplementation(() => {});
		try {
			const res = await app.request("/broken");
			expect(res.status).toBe(500);
			expect(await res.json()).toEqual({
				code: "INTERNAL_SERVER_ERROR",
				message: "Internal Server Error",
			});
			expect(log).toHaveBeenCalledTimes(1);
		} finally {
			log.mockRestore();
		}
	});
});
