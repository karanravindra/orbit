import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { createLocalDb } from "./local";

// Wrangler and Docker use the same ordered SQL files. Keep this migration
// ledger compatible with Wrangler so either tool can inspect a local database.
export async function migrate(path: string) {
	const db = createLocalDb(path);
	try {
		await applyMigrations(db.$client);
	} finally {
		db.$client.close();
	}
}

export async function applyMigrations(client: Database) {
	client.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT UNIQUE NOT NULL,
			applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
		)`);
	const files = await Array.fromAsync(
		new Bun.Glob("*.sql").scan(resolve(import.meta.dir, "../migrations")),
	);
	for (const name of files.sort()) {
		if (client.query("SELECT 1 FROM d1_migrations WHERE name = ?").get(name))
			continue;
		const sql = await Bun.file(
			resolve(import.meta.dir, "../migrations", name),
		).text();
		client.transaction(() => {
			client.exec(sql);
			client.query("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
		})();
	}
}

if (import.meta.main)
	await migrate(process.env.DATABASE_PATH ?? "../../orbit.sqlite");
