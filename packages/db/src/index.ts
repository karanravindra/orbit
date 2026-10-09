import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { relations } from "./relations";

export function createDb(url: string) {
	const client = new SQL(url);
	return drizzle({ client, relations });
}

export type Db = ReturnType<typeof createDb>;
