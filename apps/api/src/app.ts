import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { notFound, onError } from "./errors";
import { auth } from "./lib/auth";
import { env } from "./lib/env";
import { health } from "./routes/health";

// Routes are chained so their types flow into AppType for the RPC client.
const app = new Hono()
	.use(requestId())
	// Request lines would bury test output.
	.use(logger(env.NODE_ENV === "test" ? () => {} : console.log))
	.use(secureHeaders())
	.use(
		cors({
			origin: env.CORS_ORIGINS,
			credentials: true,
		}),
	)
	.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
	.route("/health", health);

app.notFound(notFound);
app.onError(onError);

export type AppType = typeof app;

export default app;
