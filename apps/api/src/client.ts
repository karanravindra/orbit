import { hc } from "hono/client";
import type { AppType } from "./app";

// Typed RPC client for the frontend. Auth routes are untyped here; use
// Better Auth's own client for those.
export function createClient(baseUrl: string) {
	return hc<AppType>(baseUrl, { init: { credentials: "include" } });
}
