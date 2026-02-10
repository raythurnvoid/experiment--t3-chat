import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://localhost:5173";

export default defineConfig({
	testDir: "./tests",
	fullyParallel: false,
	forbidOnly: false,
	retries: 0,
	workers: 1,
	timeout: 90_000,
	expect: {
		timeout: 10_000,
	},
	reporter: "html",
	use: {
		baseURL,
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "e2e",
			testMatch: /e2e\/.*\.test\.ts/,
			use: {
				...devices["Desktop Chrome"],
			},
		},
	],
});
