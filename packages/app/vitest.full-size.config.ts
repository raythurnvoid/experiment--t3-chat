import { defineConfig } from "vitest/config";
import config from "./vitest.config.ts";

// Runs only the slow full-size checks for test:files:full-size. Same setup as vitest.config.ts with the tag filter
// flipped. Set the filter here instead of merging configs: merged filter lists are combined with AND.
export default defineConfig({ ...config, test: { ...config.test, tagsFilter: ["full-size"] } });
