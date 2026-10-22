import type { D1Database } from "@cloudflare/workers-types";
import { createWorkerDb } from "@orbit/db/worker";
import { createApp } from "./app";
import { parseEnv } from "./lib/env";

export interface Bindings extends Record<string, unknown> {
	DB: D1Database;
}

export default {
	async fetch(request: Request, bindings: Bindings): Promise<Response> {
		try {
			const env = parseEnv(bindings);
			const db = createWorkerDb(bindings.DB);
			return await createApp({ db, env }).fetch(request);
		} catch (error) {
			console.error("Worker initialization failed", error);
			return Response.json(
				{ code: "INTERNAL_SERVER_ERROR", message: "Internal Server Error" },
				{ status: 500 },
			);
		}
	},
};
