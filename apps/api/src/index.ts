import app from "./app";
import { db } from "./lib/db";
import { env } from "./lib/env";

const server = Bun.serve({ port: env.PORT, fetch: app.fetch });

// On a deploy or Ctrl-C, stop taking new requests, let in-flight ones finish,
// then close the database pool.
async function shutdown() {
	await server.stop();
	await db.$client.close();
	process.exit(0);
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
