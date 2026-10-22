import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { relations } from "./relations";

export function createLocalDb(path: string) {
	const client = new Database(path, { create: true });
	client.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
	client.exec("PRAGMA journal_mode = WAL;");
	return drizzle({ client, relations });
}
