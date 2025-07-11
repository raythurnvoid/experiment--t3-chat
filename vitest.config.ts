import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [],
	test: {
		include: ["src/**/*.{test}.{ts,tsx}"],
		exclude: [...configDefaults.exclude, "+personal/**/*"],
	},
});
