import type { Db } from "@orbit/db";
import { sql } from "drizzle-orm";
import { Hono } from "hono";

export function createHealth(db: Db) {
	return new Hono()
		.get("/", (c) => c.json({ status: "ok" }, 200))
		.get("/ready", async (c) => {
			try {
				// Check both connectivity and the presence of the application schema.
				await db.get(sql`SELECT id FROM user LIMIT 1`);
				return c.json({ status: "ok" }, 200);
			} catch {
				return c.json({ status: "unavailable" }, 503);
			}
		});
}
