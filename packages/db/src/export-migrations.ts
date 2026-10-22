import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

// Drizzle keeps snapshots in timestamped directories; Wrangler expects flat
// SQL files. Export the SQL verbatim so both runtimes apply identical changes.
const root = resolve(import.meta.dir, "..");
await mkdir(resolve(root, "migrations"), { recursive: true });
for await (const file of new Bun.Glob("*/migration.sql").scan(
	resolve(root, "drizzle"),
)) {
	const name = file.split("/")[0];
	await Bun.write(
		resolve(root, "migrations", `${name}.sql`),
		Bun.file(resolve(root, "drizzle", file)),
	);
}
