import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cwd = resolve(import.meta.dir, "..");
const state = await mkdtemp(join(tmpdir(), "orbit-d1-"));
const socket = Bun.serve({ port: 0, fetch: () => new Response() });
const port = socket.port;
await socket.stop(true);
const url = `http://localhost:${port}`;
let server: ReturnType<typeof Bun.spawn> | undefined;

try {
	const migration = Bun.spawn(
		[
			"bun",
			"x",
			"--no-install",
			"wrangler",
			"d1",
			"migrations",
			"apply",
			"DB",
			"--local",
			"--persist-to",
			state,
		],
		{ cwd, stdout: "inherit", stderr: "inherit" },
	);
	assert.equal(await migration.exited, 0, "D1 migrations must apply");
	server = Bun.spawn(
		[
			"bun",
			"x",
			"--no-install",
			"wrangler",
			"dev",
			"src/test-utils/worker-fixture.ts",
			"--local",
			"--port",
			String(port),
			"--persist-to",
			state,
			"--var",
			"BETTER_AUTH_SECRET:test-worker-secret-01234567890123456789",
			"--var",
			"NODE_ENV:test",
			"--var",
			"EMAIL_PROVIDER:memory",
			"--var",
			`BETTER_AUTH_URL:${url}`,
		],
		{ cwd, stdout: "inherit", stderr: "inherit", detached: true },
	);
	const deadline = Date.now() + 60000;
	let ready = false;
	while (Date.now() < deadline) {
		if (server.exitCode !== null)
			throw new Error("Wrangler exited before becoming ready");
		try {
			const response = await fetch(`${url}/health/ready`, {
				signal: AbortSignal.timeout(1000),
			});
			if (response.ok) {
				ready = true;
				break;
			}
		} catch {}
		await Bun.sleep(200);
	}
	assert(ready, "Worker must report D1 readiness");
	const session = await fetch(`${url}/__test/session`);
	assert.equal(session.status, 200, await session.clone().text());
	const cookie = session.headers
		.getSetCookie()
		.map((header) => header.split(";")[0])
		.join("; ");
	assert(
		cookie.includes("better-auth.session_token"),
		"Sign-in must issue a session cookie",
	);
	const response = await fetch(`${url}/api/auth/get-session`, {
		headers: { Cookie: cookie },
	});
	assert.equal(response.status, 200);
	const body = (await response.json()) as {
		user: { name: string };
		session: { activeOrganizationId: string };
	};
	assert.equal(body.user.name, "D1 Test");
	assert(
		body.session.activeOrganizationId,
		"D1 sessions must start in a personal organization",
	);
	console.log(
		"Workers/D1 migration, sign-in, session, and personal organization checks passed.",
	);
} finally {
	if (server?.pid && server.exitCode === null) {
		process.kill(-server.pid, "SIGTERM");
		await server.exited;
	}
	await rm(state, { recursive: true, force: true });
}
