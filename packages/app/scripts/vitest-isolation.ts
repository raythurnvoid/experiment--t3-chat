import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as ts from "typescript";

const isolated_text = /vi\.(?:mock|doMock|hoisted|resetModules)\s*\(/;
const helper_path = /\.test(?:-fixtures)?(?:\.[jt]sx?)?$/;
const permanent_calls = new Set(["fn", "spyOn"]);
const module_hooks = new Set(["beforeEach", "afterEach", "beforeAll", "afterAll"]);

/**
 * Give tests with permanent mocks or imported helper hooks fresh loaded modules.
 * Vitest reloads setup files per test file, so their hooks do not require isolation.
 */
export function vitest_find_isolated_files(root: string, files: string[], setupFiles: string[]) {
	const setup = new Set(setupFiles.map((file) => resolve(root, file)));
	const cache = new Map<string, { direct: boolean; isolated: boolean; imports: string[] }>();

	function inspect(file: string) {
		const cached = cache.get(file);
		if (cached) return cached;
		const text = readFileSync(file, "utf8");
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
		const direct = isolated_text.test(text);
		const info = { direct, isolated: direct, imports: [] as string[] };
		cache.set(file, info);
		for (const statement of source.statements) {
			if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
			const specifier = statement.moduleSpecifier;
			if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) continue;
			if (ts.isImportDeclaration(statement)) {
				const clause = statement.importClause;
				if (clause?.isTypeOnly) continue;
				const bindings = clause?.namedBindings;
				if (
					!clause?.name &&
					bindings &&
					ts.isNamedImports(bindings) &&
					bindings.elements.length > 0 &&
					bindings.elements.every((item) => item.isTypeOnly)
				)
					continue;
			} else {
				if (statement.isTypeOnly) continue;
				const bindings = statement.exportClause;
				if (
					bindings &&
					ts.isNamedExports(bindings) &&
					bindings.elements.length > 0 &&
					bindings.elements.every((item) => item.isTypeOnly)
				)
					continue;
			}
			if (!helper_path.test(specifier.text)) continue;
			const helper = specifier.text.replace(/\.jsx?$/, (extension) => (extension === ".jsx" ? ".tsx" : ".ts"));
			info.imports.push(resolve(dirname(file), /\.[jt]sx?$/.test(helper) ? helper : `${helper}.ts`));
		}
		function visit(node: ts.Node) {
			// Factory bodies create fresh mocks when called. Only load-time calls persist between files.
			if (ts.isFunctionLike(node)) return;
			if (ts.isCallExpression(node)) {
				const call = node.expression;
				if (
					(ts.isIdentifier(call) && module_hooks.has(call.text)) ||
					(ts.isPropertyAccessExpression(call) &&
						ts.isIdentifier(call.expression) &&
						call.expression.text === "vi" &&
						permanent_calls.has(call.name.text))
				)
					info.isolated = true;
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
		return info;
	}

	function needs_isolation(file: string, visited: Set<string>, helper: boolean): boolean {
		if (setup.has(file) || visited.has(file)) return false;
		visited.add(file);
		const info = inspect(file);
		if (helper ? info.isolated : info.direct) return true;
		return info.imports.some((imported) => needs_isolation(imported, visited, true));
	}

	return files.filter((file) => needs_isolation(resolve(root, file), new Set(), false));
}
