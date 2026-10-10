import { STATUS_CODES } from "node:http";
import type { ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";

// Error responses share Better Auth's { code, message } shape, so clients
// handle one format. The code is the status's name, e.g. NOT_FOUND.
function errorBody(status: number, message?: string) {
	const reason = STATUS_CODES[status] ?? "Unknown Error";
	return {
		code: reason.toUpperCase().replace(/\W+/g, "_"),
		message: message || reason,
	};
}

export const notFound: NotFoundHandler = (c) => c.json(errorBody(404), 404);

export const onError: ErrorHandler = (err, c) => {
	if (err instanceof HTTPException) {
		return c.json(errorBody(err.status, err.message), err.status);
	}
	console.error(`[${c.get("requestId")}]`, err);
	return c.json(errorBody(500), 500);
};
