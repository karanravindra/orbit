import {
	adminClient,
	emailOTPClient,
	lastLoginMethodClient,
	organizationClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const auth = createAuthClient({
	baseURL: import.meta.env.VITE_API_URL || window.location.origin,
	plugins: [
		emailOTPClient(),
		lastLoginMethodClient(),
		adminClient(),
		organizationClient({
			teams: { enabled: true },
			dynamicAccessControl: { enabled: true },
			schema: {
				organization: {
					additionalFields: {
						personalOwnerId: { type: "string", required: false, input: false },
					},
				},
			},
		}),
	],
});

export async function result<T>(
	request: Promise<{
		data: T;
		error: { message?: string; status?: number; code?: string } | null;
	}>,
): Promise<NonNullable<T>> {
	const response = await request;
	if (response.error)
		throw new Error(
			response.error.message || "The request failed. Please try again.",
		);
	return response.data as NonNullable<T>;
}

export type Session = typeof auth.$Infer.Session;
export type Workspace = typeof auth.$Infer.Organization;
export type Member = typeof auth.$Infer.Member;
