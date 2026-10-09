import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { env } from "./env";
import { auth } from "./lib/auth";

// Routes are chained so their types flow into AppType for the RPC client.
const app = new Hono()
	.use(requestId())
	.use(logger())
	.use(secureHeaders())
	.use(
		cors({
			origin: env.CORS_ORIGINS,
			credentials: true,
		}),
	)
	.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
	.get("/health", (c) => c.json({ status: "ok" }, 200));

app.notFound((c) => c.json({ error: "Not Found" }, 404));

app.onError((err, c) => {
	if (err instanceof HTTPException) {
		return c.json({ error: err.message }, err.status);
	}
	console.error(`[${c.get("requestId")}]`, err);
	return c.json({ error: "Internal Server Error" }, 500);
});

export type AppType = typeof app;

export default app;
