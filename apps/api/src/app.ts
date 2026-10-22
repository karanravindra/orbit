import type { Db } from "@orbit/db";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { createEmailSender, type EmailSender } from "./email";
import { type Auth, createAuth } from "./lib/auth";
import type { Env } from "./lib/env";
import { createHealth } from "./routes/health";
import { notFound, onError } from "./utils/errors";

// Routes are chained so their types flow into AppType for the RPC client.
export function createApp({
	db,
	env,
	emailSender = createEmailSender(env),
	auth = createAuth({ db, env, emailSender }),
}: {
	db: Db;
	env: Env;
	emailSender?: EmailSender;
	auth?: Auth;
}) {
	const app = new Hono()
		.use(requestId())
		.use(async (c, next) => {
			const start = performance.now();
			await next();
			if (env.NODE_ENV !== "test")
				console.log(
					JSON.stringify({
						event: "request",
						requestId: c.get("requestId"),
						method: c.req.method,
						path: c.req.path,
						status: c.res.status,
						durationMs: Math.round(performance.now() - start),
					}),
				);
		})
		.use(secureHeaders())
		.use(
			cors({
				origin: env.CORS_ORIGINS,
				credentials: true,
				exposeHeaders: ["X-Request-Id"],
			}),
		)
		.use(
			bodyLimit({
				maxSize: env.MAX_BODY_BYTES,
				onError: (c) =>
					c.json(
						{ code: "PAYLOAD_TOO_LARGE", message: "Payload Too Large" },
						413,
					),
			}),
		)
		.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
		.route("/health", createHealth(db));

	app.notFound(notFound);
	app.onError(onError);
	return app;
}

export type AppType = ReturnType<typeof createApp>;
