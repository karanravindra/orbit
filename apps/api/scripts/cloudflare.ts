import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "../src/lib/env";

// Run from the repository root. All resource names derive from the PR number,
// never its branch name, and production and preview resources never overlap.
function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing ${name}`);
	return value;
}

const account = required("CLOUDFLARE_ACCOUNT_ID");
const token = required("CLOUDFLARE_API_TOKEN");
const mode = process.argv[2];
if (!["production", "preview", "cleanup"].includes(mode ?? ""))
	throw new Error("Expected production, preview, or cleanup");
const pr = mode === "production" ? undefined : required("PR_NUMBER");
if (pr && !/^[1-9]\d*$/.test(pr)) throw new Error("Invalid PR_NUMBER");
const prefix = process.env.WORKER_NAME ?? "orbit-api";
if (!/^[a-z][a-z0-9-]{0,39}$/.test(prefix))
	throw new Error("Invalid WORKER_NAME");
const name = pr ? `${prefix}-pr-${pr}` : prefix;
const root = resolve(import.meta.dir, "..");
const configPath = resolve(root, "wrangler.generated.json");
const secretPath = resolve(root, ".deploy-secrets.json");

async function api<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${account}${path}`,
		{
			...init,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			signal: AbortSignal.timeout(30000),
		},
	);
	const body = (await response.json()) as {
		success: boolean;
		result: T;
		errors?: { code: number; message: string }[];
	};
	if (!response.ok || !body.success)
		throw new Error(
			`Cloudflare ${path}: ${JSON.stringify(body.errors ?? response.status)}`,
		);
	return body.result;
}

async function findDatabase() {
	const databases = await api<{ uuid: string; name: string }[]>(
		`/d1/database?name=${encodeURIComponent(name)}`,
	);
	return databases.find((database) => database.name === name);
}

async function wrangler(...args: string[]) {
	const command = Bun.spawn(
		["bun", "x", "--no-install", "wrangler", ...args, "--config", configPath],
		{
			cwd: root,
			stdout: "inherit",
			stderr: "inherit",
		},
	);
	if ((await command.exited) !== 0)
		throw new Error(`Wrangler ${args[0]} failed`);
}

if (mode === "cleanup") {
	// Deleting a missing Worker is harmless; other failures must remain visible.
	const response = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}`,
		{
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(30000),
		},
	);
	if (!response.ok && response.status !== 404)
		throw new Error(`Worker cleanup failed: ${response.status}`);
	const database = await findDatabase();
	if (database)
		await api(`/d1/database/${database.uuid}`, { method: "DELETE" });
	console.log(`Removed preview ${name}`);
} else {
	// Validate deployment inputs before creating resources or applying migrations.
	const appUrl = required("APP_URL");
	const corsOrigins = process.env.CORS_ORIGINS || new URL(appUrl).origin;
	const authSecret = required("BETTER_AUTH_SECRET");
	if (authSecret.length < 32)
		throw new Error("BETTER_AUTH_SECRET must have at least 32 characters");
	const secrets: Record<string, string> = {
		BETTER_AUTH_SECRET: pr
			? await (async () => {
					const key = await crypto.subtle.importKey(
						"raw",
						new TextEncoder().encode(authSecret),
						{ name: "HMAC", hash: "SHA-256" },
						false,
						["sign"],
					);
					return Buffer.from(
						await crypto.subtle.sign(
							"HMAC",
							key,
							new TextEncoder().encode(name),
						),
					).toString("hex");
				})()
			: authSecret,
		TURNSTILE_SECRET_KEY: pr
			? "1x0000000000000000000000000000000AA"
			: required("TURNSTILE_SECRET_KEY"),
	};
	if (!pr) secrets.RESEND_API_KEY = required("RESEND_API_KEY");
	const sender = pr
		? "Orbit Preview <noreply@localhost>"
		: required("EMAIL_FROM");
	const subdomain = await api<{ subdomain: string }>("/workers/subdomain");
	const url =
		!pr && process.env.API_URL
			? new URL(process.env.API_URL).origin
			: `https://${name}.${subdomain.subdomain}.workers.dev`;
	if (!pr && !appUrl.startsWith("https://"))
		throw new Error("Production APP_URL must use HTTPS");
	const vars = {
		NODE_ENV: pr ? "development" : "production",
		BETTER_AUTH_URL: url,
		APP_URL: appUrl,
		CORS_ORIGINS: corsOrigins,
		EMAIL_PROVIDER: pr ? "console" : "resend",
		EMAIL_FROM: sender,
		ADMIN_EMAILS: pr ? "" : (process.env.ADMIN_EMAILS ?? ""),
	};
	parseEnv({ ...vars, ...secrets });
	const database =
		(await findDatabase()) ??
		(await api<{ uuid: string; name: string }>("/d1/database", {
			method: "POST",
			body: JSON.stringify({ name }),
		}));
	const base = Bun.JSONC.parse(
		await Bun.file(resolve(root, "wrangler.jsonc")).text(),
	) as Record<string, unknown>;
	const config = {
		...base,
		name,
		...(process.env.API_URL && !pr
			? { routes: [{ pattern: new URL(url).host, custom_domain: true }] }
			: {}),
		d1_databases: [
			{
				binding: "DB",
				database_name: name,
				database_id: database.uuid,
				migrations_dir: "../../packages/db/migrations",
			},
		],
		vars,
	};
	try {
		await Bun.write(configPath, JSON.stringify(config, null, 2));
		await Bun.write(secretPath, JSON.stringify(secrets), { mode: 0o600 });
		await wrangler("d1", "migrations", "apply", "DB", "--remote");
		await wrangler("deploy", "--secrets-file", secretPath);
		let ready = false;
		const deadline = Date.now() + 60000;
		while (Date.now() < deadline) {
			try {
				const response = await fetch(`${url}/health/ready`, {
					signal: AbortSignal.timeout(5000),
				});
				if (response.ok) {
					ready = true;
					break;
				}
			} catch {}
			await Bun.sleep(2000);
		}
		if (!ready) throw new Error(`Deployed API did not become ready: ${url}`);
		console.log(`Deployed ${url}`);
		if (process.env.GITHUB_STEP_SUMMARY) {
			const summary = Bun.file(process.env.GITHUB_STEP_SUMMARY);
			await Bun.write(
				summary,
				`${await summary.text()}\nAPI: ${url}\nDatabase: ${name}\n`,
			);
		}
	} finally {
		await Promise.all(
			[configPath, secretPath].map((path) => unlink(path).catch(() => {})),
		);
	}
}
