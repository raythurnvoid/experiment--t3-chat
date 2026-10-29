import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, test } from "vitest";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const convexRoot = path.join(appRoot, "convex");
const functionsPath = path.join(convexRoot, "functions.ts");

/**
 * The imports and re-exports of one module, with `import type` and `export type` left out.
 * `import { type A }` stays: with `verbatimModuleSyntax` it still loads the module.
 */
function read_imports(filePath: string) {
	const source = ts.createSourceFile(filePath, readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest);
	const imports: { from: string; names: string[] }[] = [];
	for (const statement of source.statements) {
		if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) {
			const bindings = statement.importClause?.namedBindings;
			imports.push({
				from: (statement.moduleSpecifier as ts.StringLiteral).text,
				names: !bindings
					? []
					: ts.isNamespaceImport(bindings)
						? ["*"]
						: bindings.elements.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text),
			});
		}
		if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly) {
			const clause = statement.exportClause;
			imports.push({
				from: (statement.moduleSpecifier as ts.StringLiteral).text,
				names:
					clause && ts.isNamedExports(clause)
						? clause.elements.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text)
						: ["*"],
			});
		}
	}
	return imports;
}

/**
 * The app file an import loads, or null for an npm package.
 */
function resolve_import(importer: string, from: string) {
	const base = from.startsWith("@/")
		? path.join(appRoot, "src", from.slice(2))
		: from.startsWith(".")
			? path.resolve(path.dirname(importer), from)
			: null;
	if (!base) return null;
	const file = [base, `${base}.ts`, `${base}.tsx`].find((candidate) => existsSync(candidate));
	// `_generated` files are `.js` with `.d.ts` types; they import only npm packages.
	if (!file && base.startsWith(path.join(convexRoot, "_generated"))) return base;
	if (!file) throw new Error(`Cannot resolve "${from}" from ${importer}`);
	return file;
}

const relative = (filePath: string) => path.relative(appRoot, filePath).replaceAll("\\", "/");

describe("functions.ts", () => {
	test("convex modules take mutation builders only from functions.ts", () => {
		const wrong = [];
		for (const fileName of readdirSync(convexRoot)) {
			const filePath = path.join(convexRoot, fileName);
			// Tests define no functions.
			if (!fileName.endsWith(".ts") || fileName.endsWith(".test.ts") || filePath === functionsPath) continue;
			for (const { from, names } of read_imports(filePath)) {
				const builders = /\/_generated\/server(\.js)?$/.test(from)
					? ["mutation", "internalMutation", "*"]
					: from === "convex/server"
						? ["mutationGeneric", "internalMutationGeneric", "*"]
						: [];
				for (const name of names) if (builders.includes(name)) wrong.push(`${relative(filePath)} imports ${name}`);
			}
		}
		expect(wrong).toEqual([]);
	});

	test("only the listed mutations are built by npm packages", () => {
		// A workpool builds its completion mutation from the raw builder, so it skips the wrapper and its
		// flush. Each one listed here writes no pending overlay source table.
		const allowed = [
			// Writes only `billing_cancel_polar_subscription_jobs`.
			"convex/billing.ts complete_polar_subscription_period_end_cancellation",
			// Writes only `github_mounts`. The sweep it schedules is a wrapped mutation.
			"convex/github_mounts.ts handle_materialize_complete",
		];
		const found = [];
		for (const fileName of readdirSync(convexRoot)) {
			const filePath = path.join(convexRoot, fileName);
			if (!fileName.endsWith(".ts") || fileName.endsWith(".test.ts")) continue;
			for (const match of readFileSync(filePath, "utf8").matchAll(/export const (\w+) = [\w.]+\.defineOnComplete\(/g))
				found.push(`${relative(filePath)} ${match[1]}`);
		}
		expect(found).toEqual(allowed);
	});

	test.each(["convex/functions.ts", "server/channels-notifications.ts"])("%s reaches no convex module", (entry) => {
		// Every mutation module imports functions.ts, so an app module it loads would load most of `convex/`.
		const entryPath = path.join(appRoot, entry);
		const reached = new Set([entryPath]);
		const queue = [entryPath];
		const wrong = [];
		for (const importer of queue) {
			for (const { from } of read_imports(importer)) {
				const file = resolve_import(importer, from);
				if (!file || reached.has(file)) continue;
				reached.add(file);
				if (file.startsWith(path.join(convexRoot, "_generated"))) continue;
				if (file.startsWith(convexRoot + path.sep)) wrong.push(`${relative(importer)} -> ${relative(file)}`);
				queue.push(file);
			}
		}
		expect(wrong).toEqual([]);
	});

	test("saved-place writers keep the selected-view authority contract", () => {
		// Review new writers here: selected access edits need capture, content and cleanup do not.
		const found = [];
		for (const directory of ["convex", "server"]) {
			for (const name of readdirSync(path.join(appRoot, directory), { recursive: true, encoding: "utf8" })) {
				if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name.endsWith(".test-fixtures.ts")) continue;
				const file = path.join(appRoot, directory, name);
				if (/\.(?:insert|patch|replace|delete)\(\s*["']files_saved_places["']/.test(readFileSync(file, "utf8")))
					found.push(relative(file));
			}
		}
		expect(found.sort()).toEqual([
			"convex/files_move_cohorts.ts",
			"convex/files_move_content.ts",
			"convex/files_sharing_db.ts",
			"server/files-content-heads.ts",
		]);
	});

	test("the Move runner does not eagerly load the file engine", () => {
		// Content helpers load only after a committed step asks for them.
		const allowed = new Set(["convex/values", "./_generated/api.js", "./_generated/server.js"]);
		const wrong = read_imports(path.join(convexRoot, "files_move_run.ts"))
			.map(({ from }) => from)
			.filter((from) => !allowed.has(from));
		expect(wrong, "the Move runner does not eagerly load the file engine").toEqual([]);
	});

	test("saved list entries do not load editor handlers", () => {
		const forbidden = new Set([
			"convex/files_nodes.ts",
			"convex/files_pending_updates.ts",
			"convex/files_metadata.ts",
			"convex/organizations.ts",
			"server/files.ts",
			"server/files-saved-content.ts",
			"shared/files-yjs.ts",
		]);
		const queue = ["files_tree.ts", "files_pending_list.ts"].map((name) => path.join(convexRoot, name));
		const reached = new Set(queue);
		const wrong = [];
		for (const importer of queue) {
			for (const { from } of read_imports(importer)) {
				if (
					/^(?:@tiptap\/|@mastra\/rag(?:\/|$)|yjs(?:\/|$)|y-prosemirror(?:\/|$)|prosemirror-|novel(?:\/|$)|marked(?:\/|$)|linkedom(?:\/|$))/.test(
						from,
					)
				) {
					wrong.push(`${relative(importer)} -> ${from}`);
				}
				const file = resolve_import(importer, from);
				if (!file || reached.has(file)) continue;
				reached.add(file);
				// Generated references do not load the modules their types name.
				if (file.startsWith(path.join(convexRoot, "_generated"))) continue;
				if (forbidden.has(relative(file))) wrong.push(`${relative(importer)} -> ${relative(file)}`);
				queue.push(file);
			}
		}
		expect(wrong, "saved list entries do not load editor handlers").toEqual([]);
	});

	test("Move read queries do not load producer handlers", () => {
		const forbidden = new Set([
			"convex/activities.ts",
			"convex/files_nodes.ts",
			"convex/files_nodes_content.ts",
			"convex/files_pending_updates.ts",
			"convex/files_pending_nodes.ts",
			"convex/files_visible.ts",
			"convex/files_transfer.ts",
			"convex/files_metadata.ts",
			"convex/organizations.ts",
			"convex/ai_chat_files.ts",
			"convex/ai_chat_workspaces.ts",
			"convex/files_pending_update_runs.ts",
			"convex/files_archive_runs.ts",
			"convex/files_subtree_ops.ts",
			"convex/files_move_cohorts.ts",
			"convex/files_write_policy_runs.ts",
			"convex/plugins_runtime.ts",
		]);
		const queue = ["activities_feed.ts", "files_transfer_status.ts", "files_pending_target.ts"].map((name) =>
			path.join(convexRoot, name),
		);
		const reached = new Set(queue);
		const wrong = [];
		for (const importer of queue) {
			for (const { from } of read_imports(importer)) {
				if (
					/^(?:@tiptap\/|@mastra\/rag(?:\/|$)|yjs(?:\/|$)|y-prosemirror(?:\/|$)|prosemirror-|novel(?:\/|$)|marked(?:\/|$)|linkedom(?:\/|$))/.test(
						from,
					)
				) {
					wrong.push(`${relative(importer)} -> ${from}`);
				}
				const file = resolve_import(importer, from);
				if (!file || reached.has(file)) continue;
				reached.add(file);
				// Generated references do not load the modules their types name.
				if (file.startsWith(path.join(convexRoot, "_generated"))) continue;
				if (forbidden.has(relative(file))) wrong.push(`${relative(importer)} -> ${relative(file)}`);
				queue.push(file);
			}
		}
		expect(wrong, "Move read queries do not load producer handlers").toEqual([]);
	});

	test("Move producers do not load the heavy content owner", () => {
		const forbidden = new Set([
			"convex/files_move_content.ts",
			"convex/files_move_media.ts",
			"convex/files_nodes.ts",
			"convex/files_nodes_content.ts",
			"convex/files_pending_updates.ts",
			"convex/files_pending_update_runs.ts",
			"convex/files_archive_runs.ts",
			"convex/files_subtree_ops.ts",
			"convex/ai_chat_files.ts",
			"convex/ai_chat_runs.ts",
			"convex/plugins_runtime.ts",
			"shared/files-yjs.ts",
			"server/files-markdown-chunking-mastra.ts",
		]);
		const queue = ["files_transfer.ts", "files_move_cohorts.ts"].map((name) => path.join(convexRoot, name));
		const reached = new Set(queue);
		const wrong = [];
		for (const importer of queue) {
			for (const { from } of read_imports(importer)) {
				if (
					/^(?:@tiptap\/|@mastra\/rag(?:\/|$)|yjs(?:\/|$)|y-prosemirror(?:\/|$)|prosemirror-|novel(?:\/|$)|marked(?:\/|$)|linkedom(?:\/|$))/.test(
						from,
					)
				) {
					wrong.push(`${relative(importer)} -> ${from}`);
				}
				const file = resolve_import(importer, from);
				if (!file || reached.has(file)) continue;
				reached.add(file);
				// Generated references do not load the modules their types name.
				if (file.startsWith(path.join(convexRoot, "_generated"))) continue;
				if (forbidden.has(relative(file))) wrong.push(`${relative(importer)} -> ${relative(file)}`);
				queue.push(file);
			}
		}
		expect(wrong, "Move producers do not load the heavy content owner").toEqual([]);
	});
});
