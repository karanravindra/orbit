import { app, db, env } from "./local";

const server = Bun.serve({ port: env.PORT, fetch: app.fetch });

// On a deploy or Ctrl-C, stop taking new requests, let in-flight ones finish,
// then close the database pool.
let stopping = false;
async function shutdown() {
	if (stopping) return;
	stopping = true;
	const timeout = setTimeout(() => {
		console.error(JSON.stringify({ event: "shutdown_timeout" }));
		server.stop(true);
		process.exit(1);
	}, env.SHUTDOWN_TIMEOUT_MS);
	try {
		await server.stop();
		db.$client.close();
		clearTimeout(timeout);
		process.exit(0);
	} catch (error) {
		console.error("Shutdown failed", error);
		process.exit(1);
	}
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

console.log(JSON.stringify({ event: "listening", port: server.port }));
