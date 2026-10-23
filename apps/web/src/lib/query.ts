import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
	defaultOptions: { queries: { staleTime: 15_000, retry: false } },
});

export async function refresh() {
	await queryClient.invalidateQueries();
}

export function date(value: string | Date | null | undefined) {
	return value
		? new Date(value).toLocaleString(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			})
		: "—";
}
