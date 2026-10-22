import type { D1Database } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";
import { relations } from "./relations";

export function createWorkerDb(binding: D1Database) {
	return drizzle(binding, { relations });
}
