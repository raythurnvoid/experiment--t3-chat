import { defineConfig } from "vitest/config";
import config from "./vitest.config.ts";

// Runs the "typecheck-full" checks too, for test:typecheck:full. Same setup as vitest.config.ts with that tag
// allowed. Set the filter here instead of passing --tags-filter: filter lists are combined with AND.
export default defineConfig({ ...config, test: { ...config.test, tagsFilter: ["!full-size"] } });
