import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/*.spec.ts",
	fullyParallel: false,
	workers: 1,
	use: { baseURL: "http://127.0.0.1:5174", trace: "retain-on-failure" },
	webServer: [
		{
			command: "bun run e2e/server.ts",
			url: "http://127.0.0.1:3100/health",
			reuseExistingServer: false,
		},
		{
			command: "bun run dev --port 5174 --strictPort",
			url: "http://127.0.0.1:5174",
			env: { VITE_API_URL: "http://127.0.0.1:3100" },
			reuseExistingServer: false,
		},
	],
});
