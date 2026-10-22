// Test-only entry point. Production wrangler.jsonc points to src/worker.ts.

import { user } from "@orbit/db/schema";
import { createWorkerDb } from "@orbit/db/worker";
import { eq } from "drizzle-orm";
import { MemoryEmailSender } from "../email";
import { createAuth } from "../lib/auth";
import { parseEnv } from "../lib/env";
import worker, { type Bindings } from "../worker";

export default {
	async fetch(request: Request, bindings: Bindings): Promise<Response> {
		if (new URL(request.url).pathname !== "/__test/session")
			return worker.fetch(request, bindings);
		const db = createWorkerDb(bindings.DB);
		const env = parseEnv(bindings);
		const auth = createAuth({ db, env, emailSender: new MemoryEmailSender() });
		const email = `d1-${crypto.randomUUID()}@example.com`;
		const password = `pw-${crypto.randomUUID()}`;
		const created = await auth.api.createUser({
			body: { email, password, name: "D1 Test" },
		});
		await db
			.update(user)
			.set({ emailVerified: true })
			.where(eq(user.id, created.user.id));
		return auth.api.signInEmail({
			body: { email, password },
			asResponse: true,
		});
	},
};
