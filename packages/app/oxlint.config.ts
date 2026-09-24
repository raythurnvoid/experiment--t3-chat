import { readFileSync } from "node:fs";

import { defineConfig } from "oxlint";

/**
 * TODO: Turn `@convex-dev/explicit-table-ids` back on when Oxlint JS plugins can see TypeScript types.
 *
 * That rule wants `db.get("users", id)` instead of `db.get(id)`. The same goes for
 * `patch`, `replace`, and `delete`. Both forms work. It is not in this config because
 * a JS plugin cannot read types, so the rule would load and check nothing.
 * The other Convex rules stay on.
 *
 * `no-redeclare` stays off. TypeScript ESLint already turns that JavaScript rule off,
 * because a type and a value may share a name.
 */

type OxlintOverride = {
	files?: string[];
	rules?: Record<string, unknown>;
};

type OxlintConfigFile = {
	ignorePatterns?: string[];
	overrides?: OxlintOverride[];
};

const base = JSON.parse(readFileSync(new URL("./oxlint.rules.json", import.meta.url), "utf8")) as OxlintConfigFile;

// These React Compiler rules are not in Oxlint yet. The native `react/*` rules cover the rest.
// Plugin 7.1 removed automatic-effect-dependencies and fire.
// component-hook-factories is still exported, but it checks nothing.
const reactHooksJsRules = {
	"react-hooks-js/config": "error",
	"react-hooks-js/fbt": "error",
	"react-hooks-js/gating": "error",
	"react-hooks-js/memoized-effect-dependencies": "error",
} as const;

const config = {
	...base,
	ignorePatterns: [...(base.ignorePatterns ?? []), "convex/_generated"],
	jsPlugins: ["@convex-dev/eslint-plugin", { name: "react-hooks-js", specifier: "eslint-plugin-react-hooks" }],
	overrides: (base.overrides ?? []).map((override) => {
		const rules = { ...(override.rules ?? {}) };

		if ("no-redeclare" in rules) {
			rules["no-redeclare"] = "off";
		}

		if (rules["react/rules-of-hooks"] === "error") {
			Object.assign(rules, reactHooksJsRules);
		}

		if (override.files?.length === 1 && override.files[0] === "convex/**/*.ts" && override.rules === undefined) {
			rules["@convex-dev/no-old-registered-function-syntax"] = "error";
			rules["@convex-dev/require-args-validator"] = "error";
		}

		return {
			...override,
			rules,
		};
	}),
};

export default defineConfig(config);
