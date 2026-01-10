// @ts-check

import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import reactRefresh from "eslint-plugin-react-refresh";
import importPlugin from "eslint-plugin-import";
import convexPlugin from "@convex-dev/eslint-plugin";
import { defineConfig } from "eslint/config";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Eslint rule to prevent the specified `files` from importing from the specified `from` paths.
 *
 * @param {{
 * 	files: string[];
 * 	from: string[];
 * 	allowTypeImports?: boolean;
 * 	message?: string;
 * }} args
 */
function restrictImports(args) {
	const { files, from, allowTypeImports = false, message } = args;

	const patterns = from.map((dir) => {
		// Match relative imports: ../dir/, ../../dir/, etc.
		const relativePattern = `^(\\.\\./)+${dir}(/.*)?(\\.ts)?$`;
		// Match TypeScript alias imports: @/../dir/ or @/ (if dir is src)
		const aliasPattern = dir === "src" ? `^@/(.*)?(\\.ts)?$` : `^@/\\.\\./${dir}(/.*)?(\\.ts)?$`;
		// Match bare imports: dir/... (resolved via baseUrl)
		const barePattern = `^${dir}(/.*)?(\\.ts)?$`;
		// Combine all patterns
		const regex = `${relativePattern}|${aliasPattern}|${barePattern}`;

		return {
			regex,
			allowTypeImports,
			message: message || `Files cannot import from ${dir}/`,
		};
	});

	/**
	 * @satisfies {import('eslint').Linter.Config}
	 */
	const config = {
		files,
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns,
				},
			],
		},
	};

	return config;
}

export default defineConfig(
	{ ignores: ["dist", "vendor"] },
	reactRefresh.configs.vite,
	{
		plugins: {
			js: js,
			"@typescript-eslint": tseslint.plugin,
			// @ts-expect-error
			"react-hooks": reactHooks,
		},
	},

	{
		files: ["src/**/*.{ts,tsx}", "server/**/*.ts", "shared/**/*.ts", "convex/**/*.ts"],
		extends: [
			js.configs.recommended,
			tseslint.configs.recommendedTypeChecked,
			importPlugin.flatConfigs.recommended,
			importPlugin.flatConfigs.typescript,
		],
		languageOptions: {
			ecmaVersion: 2025,
			globals: globals.browser,
			parserOptions: {
				projectService: true,
				tsconfigRootDir: __dirname,
			},
		},
		rules: {
			"no-useless-escape": "off",
			"no-empty": ["error", { allowEmptyCatch: true }],
			"no-unexpected-multiline": "off",
			"no-constant-condition": "off",
			"no-case-declarations": "off",
			"no-console": ["error", { allow: ["debug", "info", "error", "warn"] }],

			"@typescript-eslint/ban-ts-comment": "off",
			"@typescript-eslint/no-array-constructor": "off",
			"@typescript-eslint/no-array-delete": "off",
			"@typescript-eslint/await-thenable": "error",
			"@typescript-eslint/no-base-to-string": "off",
			"@typescript-eslint/no-duplicate-type-constituents": "error",
			"@typescript-eslint/no-empty-object-type": "off",
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-floating-promises": "off",
			"@typescript-eslint/no-for-in-array": "off",
			"@typescript-eslint/no-implied-eval": "off",
			"@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
			"@typescript-eslint/no-namespace": "off",
			"@typescript-eslint/no-non-null-asserted-optional-chain": "off",
			"@typescript-eslint/no-redundant-type-constituents": "error",
			"@typescript-eslint/no-this-alias": "off",
			"@typescript-eslint/no-unnecessary-type-assertion": "off",
			"@typescript-eslint/no-unnecessary-type-constraint": "off",
			"@typescript-eslint/no-unsafe-argument": "off",
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-unsafe-declaration-merging": "off",
			"@typescript-eslint/no-unsafe-enum-comparison": "off",
			"@typescript-eslint/no-unsafe-function-type": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-unsafe-return": "off",
			"@typescript-eslint/no-unused-expressions": "off",
			"@typescript-eslint/no-unused-vars": "off",
			"@typescript-eslint/prefer-as-const": "off",
			"@typescript-eslint/prefer-promise-reject-errors": [
				"error",
				{
					allowThrowingAny: true,
					allowThrowingUnknown: false,
				},
			],
			"@typescript-eslint/require-await": "off",
			"@typescript-eslint/restrict-template-expressions": "off",
			"@typescript-eslint/only-throw-error": [
				"error",
				{
					allowThrowingAny: true,
					allowThrowingUnknown: false,
				},
			],
			"@typescript-eslint/unbound-method": "error",

			"import/export": "off",
			"import/no-deprecated": "off",
			"import/no-empty-named-blocks": "off",
			"import/no-extraneous-dependencies": "off",
			"import/no-mutable-exports": "off",
			"import/no-named-as-default": "off",
			"import/no-named-as-default-member": "off",
			"import/no-unused-modules": "off",
			"import/no-amd": "off",
			"import/no-commonjs": "off",
			"import/no-import-module-exports": "off",
			"import/no-nodejs-modules": "off",
			"import/unambiguous": "off",
			"import/default": "off",
			"import/enforce-node-protocol-usage": "off",
			"import/named": "off",
			"import/namespace": "off",
			"import/no-absolute-path": "off",
			"import/no-cycle": "off",
			"import/no-dynamic-require": "off",
			"import/no-internal-modules": "off",
			"import/no-relative-packages": "off",
			"import/no-relative-parent-imports": "off",
			"import/no-restricted-paths": "off",
			"import/no-self-import": "off",
			"import/no-unresolved": "off",
			"import/no-useless-path-segments": "off",
			"import/no-webpack-loader-syntax": "off",
			"import/consistent-type-specifier-style": "off",
			"import/dynamic-import-chunkname": "off",
			"import/exports-last": "off",
			"import/extensions": ["error", "ignorePackages"],
			"import/first": "off",
			"import/group-exports": "off",
			"import/imports-first": "off",
			"import/max-dependencies": "off",
			"import/newline-after-import": "off",
			"import/no-anonymous-default-export": "off",
			"import/no-default-export": "off",
			"import/no-duplicates": "off",
			"import/no-named-default": "off",
			"import/no-named-export": "off",
			"import/no-namespace": "off",
			"import/no-unassigned-import": "off",
			"import/order": "off",
			"import/prefer-default-export": "off",
		},
	},

	{
		files: ["src/**/*.{ts,tsx}"],
		extends: [reactHooks.configs.flat["recommended-latest"]],
		rules: {
			"react-refresh/only-export-components": ["error", { allowConstantExport: true }],

			// React Hooks rules
			"react-hooks/exhaustive-deps": "off",
			"react-hooks/no-unused-directives": "off",
			"react-hooks/rules-of-hooks": "error",

			// React Compiler
			"react-hooks/automatic-effect-dependencies": "error",
			"react-hooks/capitalized-calls": "error",
			"react-hooks/config": "error",
			"react-hooks/error-boundaries": "error",
			"react-hooks/component-hook-factories": "error",
			"react-hooks/fbt": "error",
			"react-hooks/fire": "error",
			"react-hooks/gating": "error",
			"react-hooks/globals": "error",
			"react-hooks/hooks": "error",
			"react-hooks/immutability": "error",
			"react-hooks/invariant": "error",
			"react-hooks/memoized-effect-dependencies": "error",
			"react-hooks/no-deriving-state-in-effects": "error",
			"react-hooks/preserve-manual-memoization": "error",
			"react-hooks/purity": "error",
			"react-hooks/refs": "error",
			"react-hooks/rule-suppression": "error",
			"react-hooks/set-state-in-effect": "off",
			"react-hooks/set-state-in-render": "error",
			"react-hooks/static-components": "error",
			"react-hooks/syntax": "error",
			"react-hooks/unsupported-syntax": "error",
			"react-hooks/todo": "error",
			"react-hooks/use-memo": "error",
			"react-hooks/void-use-memo": "error",
			"react-hooks/incompatible-library": "warn",
		},
	},

	{
		files: ["convex/**/*.ts"],
		plugins: {
			"@convex-dev": convexPlugin,
		},
		languageOptions: {
			globals: globals.worker,
		},
		rules: convexPlugin.configs.recommended[0].rules,
	},

	restrictImports({
		files: ["src/**/*.{ts,tsx}"],
		from: ["server"],
	}),

	restrictImports({
		files: ["shared/**/*.ts"],
		from: ["server", "src", "novel"],
		allowTypeImports: true,
	}),

	restrictImports({
		files: ["server/**/*.ts"],
		from: ["src", "novel"],
	}),
);
