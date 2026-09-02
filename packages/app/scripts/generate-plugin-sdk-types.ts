/// <reference types="node" />

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

import * as ts from "typescript";

/**
 * Writes `packages/bonobo-plugin-sdk/convex-api.d.ts`, the file a plugin type-checks its direct
 * Convex calls against. Run with `--check` to compare a fresh result with the committed file
 * instead of writing it; the app lint runs that mode.
 *
 * How it works: `plugin-sdk-api-entry.ts` exports the plugin doors as one value. This script
 * builds the app's own TypeScript program (`tsconfig.app.json`) with that entry added, asks the
 * compiler for the entry's declaration file, and then inlines the few app-owned type aliases the
 * compiler still prints by name. The result imports only from `convex/server` and `convex/values`.
 *
 * The compiler is used directly instead of a d.ts bundler. A bundler roots its own program at the
 * entry and stops on any diagnostic, and this app only type-checks cleanly under `tsc-silent`
 * with the vendor errors suppressed.
 */

const CHECK_FLAG = "--check";

/**
 * The packages the generated file may still import from. Every other import is an app type that
 * must be inlined, so a plugin never depends on app source.
 */
const ALLOWED_IMPORT_SPECIFIERS = new Set(["convex/server", "convex/values"]);

const GENERATED_HEADER = `/**
 * GENERATED FILE. Do not edit by hand.
 *
 * The public Convex functions a plugin frame may call on its own client, typed as the app
 * declares them. \`packages/app/scripts/generate-plugin-sdk-types.ts\` writes this file from the
 * app (\`pnpm run generate:plugin-sdk-types\`), and the app lint fails when it is stale.
 */
`;

/**
 * One `import("../app-file.js").Name<Args>` reference found in the emitted declaration text.
 */
type generate_plugin_sdk_types_AppAliasRef = {
	start: number;
	end: number;
	specifier: string;
	name: string;
	typeArguments: string[];
};

function generate_plugin_sdk_types_get_paths() {
	const scriptDir = path.dirname(fileURLToPath(import.meta.url));
	const appRootDir = path.resolve(scriptDir, "..");

	// The compiler reports file names with forward slashes on every platform. Keep the entry in
	// that form so it can be looked up in the program.
	const entryPath = path.resolve(scriptDir, "plugin-sdk-api-entry.ts").split(path.sep).join("/");

	return {
		appRootDir,
		tsconfigPath: path.resolve(appRootDir, "tsconfig.app.json"),
		entryPath,
		outputPath: path.resolve(appRootDir, "..", "bonobo-plugin-sdk", "convex-api.d.ts"),
	};
}

function generate_plugin_sdk_types_format_diagnostics(diagnostics: readonly ts.Diagnostic[]) {
	return diagnostics
		.map((diagnostic) => {
			const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
			if (!diagnostic.file || diagnostic.start === undefined) {
				return message;
			}

			const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
			return `${diagnostic.file.fileName}:${line + 1}:${character + 1} ${message}`;
		})
		.join("\n");
}

/**
 * Builds the app program with the entry added and returns the entry's declaration text.
 */
function generate_plugin_sdk_types_emit_entry(paths: ReturnType<typeof generate_plugin_sdk_types_get_paths>) {
	const config = ts.readConfigFile(paths.tsconfigPath, ts.sys.readFile);
	if (config.error) {
		throw new Error(generate_plugin_sdk_types_format_diagnostics([config.error]));
	}

	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, paths.appRootDir, undefined, paths.tsconfigPath);
	// The build info file belongs to the incremental lint build and goes away with the flag.
	const { tsBuildInfoFile: _tsBuildInfoFile, ...appOptions } = parsed.options;
	const options: ts.CompilerOptions = {
		...appOptions,
		// The app config sets `noEmit` for the editor and the lint. Declaration emit needs these
		// instead. `outDir` is never written to: the emit below keeps the text in memory.
		noEmit: false,
		declaration: true,
		emitDeclarationOnly: true,
		outDir: path.join(os.tmpdir(), "plugin-sdk-types-never-written"),
		incremental: false,
	};

	// The whole app is in the program so every ambient type the app relies on is present. A
	// program rooted at the entry alone would miss them and type some values as `any`.
	const program = ts.createProgram([...parsed.fileNames, paths.entryPath], options);
	const entry = program.getSourceFile(paths.entryPath);
	if (!entry) {
		throw new Error(`Entry ${paths.entryPath} is not in the program`);
	}

	let text = "";
	const result = program.emit(
		entry,
		(_fileName, data) => {
			text = data;
		},
		undefined,
		true,
	);
	if (result.diagnostics.length > 0) {
		throw new Error(`Declaration emit failed:\n${generate_plugin_sdk_types_format_diagnostics(result.diagnostics)}`);
	}
	if (result.emitSkipped || text === "") {
		throw new Error("Declaration emit produced no output");
	}

	return { program, options, text };
}

/**
 * Finds every `import("...")` type reference in a declaration text, in source order.
 */
function generate_plugin_sdk_types_find_import_refs(text: string) {
	const source = ts.createSourceFile("convex-api.d.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const refs: generate_plugin_sdk_types_AppAliasRef[] = [];

	const visit = (node: ts.Node) => {
		if (ts.isImportTypeNode(node)) {
			if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteral(node.argument.literal)) {
				throw new Error(`Unsupported import type: ${node.getText(source)}`);
			}
			if (!node.qualifier || !ts.isIdentifier(node.qualifier)) {
				throw new Error(`Unsupported import type qualifier: ${node.getText(source)}`);
			}

			refs.push({
				start: node.getStart(source),
				end: node.getEnd(),
				specifier: node.argument.literal.text,
				name: node.qualifier.text,
				typeArguments: (node.typeArguments ?? []).map((typeArgument) => typeArgument.getText(source)),
			});
			// An app reference is replaced whole, type arguments included, so nothing inside it is
			// visited now. A reference inside those arguments is found again in the next round.
			if (node.argument.literal.text.startsWith(".")) {
				return;
			}
		}

		ts.forEachChild(node, visit);
	};
	visit(source);

	return refs;
}

/**
 * Copies one app alias's right-hand side as text, with its type parameters replaced by the
 * written type arguments. A name the alias file imports from a package becomes
 * `import("<package>").Name`; a name from another app file becomes a relative `import("...")`
 * that the next round inlines in turn.
 */
function generate_plugin_sdk_types_inline_alias(
	ref: generate_plugin_sdk_types_AppAliasRef,
	emitted: ReturnType<typeof generate_plugin_sdk_types_emit_entry>,
	entryPath: string,
) {
	const { program, options } = emitted;
	const checker = program.getTypeChecker();

	const relativeFromEntry = (fileName: string) => {
		const relative = path.posix.relative(path.posix.dirname(entryPath), fileName).replace(/\.ts$/, ".js");
		return relative.startsWith(".") ? relative : `./${relative}`;
	};

	const resolvedModule = ts.resolveModuleName(ref.specifier, entryPath, options, ts.sys).resolvedModule;
	if (!resolvedModule) {
		throw new Error(`Cannot resolve ${ref.specifier} from ${entryPath}`);
	}
	const moduleFile = program.getSourceFile(resolvedModule.resolvedFileName);
	if (!moduleFile) {
		throw new Error(`${resolvedModule.resolvedFileName} is not in the program`);
	}
	const moduleSymbol = checker.getSymbolAtLocation(moduleFile);
	if (!moduleSymbol) {
		throw new Error(`${moduleFile.fileName} has no module symbol`);
	}

	const exportSymbol = checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === ref.name);
	if (!exportSymbol) {
		throw new Error(`${moduleFile.fileName} does not export ${ref.name}`);
	}
	const aliasSymbol =
		exportSymbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exportSymbol) : exportSymbol;
	const declaration = aliasSymbol.declarations?.[0];
	if (!declaration || !ts.isTypeAliasDeclaration(declaration)) {
		throw new Error(`${ref.name} from ${moduleFile.fileName} is not a type alias, so it cannot be inlined`);
	}

	const declarationFile = declaration.getSourceFile();
	const typeParameters = (declaration.typeParameters ?? []).map((parameter) => parameter.name.text);
	if (typeParameters.length !== ref.typeArguments.length) {
		throw new Error(
			`${ref.name} takes ${typeParameters.length} type parameters but ${ref.typeArguments.length} were written`,
		);
	}

	const edits: { start: number; end: number; text: string }[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isTypeQueryNode(node)) {
			throw new Error(`${ref.name} uses typeof, which cannot be inlined`);
		}

		if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
			const parameterIndex = typeParameters.indexOf(node.typeName.text);
			if (parameterIndex !== -1) {
				edits.push({
					start: node.getStart(declarationFile),
					end: node.getEnd(),
					text: ref.typeArguments[parameterIndex]!,
				});
				return;
			}

			const symbol = checker.getSymbolAtLocation(node.typeName);
			const localDeclaration = symbol?.declarations?.[0];
			if (!localDeclaration) {
				throw new Error(`${ref.name}: cannot resolve ${node.typeName.text}`);
			}

			const localFile = localDeclaration.getSourceFile();
			// A global or a lib type (`Record`, `Array`) needs no import and stays as written.
			const isGlobal = localFile.hasNoDefaultLib || localFile.fileName.includes("/node_modules/");
			if (!isGlobal && ts.isImportSpecifier(localDeclaration)) {
				const importDeclaration = localDeclaration.parent.parent.parent;
				const importedSpecifier = (importDeclaration.moduleSpecifier as ts.StringLiteral).text;
				const importedModule = ts.resolveModuleName(importedSpecifier, localFile.fileName, options, ts.sys).resolvedModule;
				if (!importedModule) {
					throw new Error(`${ref.name}: cannot resolve ${importedSpecifier} from ${localFile.fileName}`);
				}

				const importedName = (localDeclaration.propertyName ?? localDeclaration.name).text;
				const pointer = importedModule.isExternalLibraryImport
					? importedSpecifier
					: relativeFromEntry(importedModule.resolvedFileName);
				edits.push({
					start: node.typeName.getStart(declarationFile),
					end: node.typeName.getEnd(),
					text: `import("${pointer}").${importedName}`,
				});
			} else if (!isGlobal) {
				edits.push({
					start: node.typeName.getStart(declarationFile),
					end: node.typeName.getEnd(),
					text: `import("${relativeFromEntry(localFile.fileName)}").${node.typeName.text}`,
				});
			}
		}

		ts.forEachChild(node, visit);
	};
	visit(declaration.type);

	// Apply the edits from the end so the earlier offsets stay valid.
	let rightHandSide = declaration.type.getText(declarationFile);
	const base = declaration.type.getStart(declarationFile);
	for (const edit of edits.sort((a, b) => b.start - a.start)) {
		rightHandSide = rightHandSide.slice(0, edit.start - base) + edit.text + rightHandSide.slice(edit.end - base);
	}

	return rightHandSide;
}

/**
 * Replaces every app alias reference until only package imports remain.
 */
function generate_plugin_sdk_types_inline_app_aliases(
	emitted: ReturnType<typeof generate_plugin_sdk_types_emit_entry>,
	entryPath: string,
) {
	let text = emitted.text;

	for (let round = 0; round < 10; round++) {
		const appRefs = generate_plugin_sdk_types_find_import_refs(text).filter((ref) => ref.specifier.startsWith("."));
		if (appRefs.length === 0) {
			break;
		}

		for (const ref of appRefs.sort((a, b) => b.start - a.start)) {
			text =
				text.slice(0, ref.start) + generate_plugin_sdk_types_inline_alias(ref, emitted, entryPath) + text.slice(ref.end);
		}
	}

	const leftover = generate_plugin_sdk_types_find_import_refs(text).filter(
		(ref) => !ALLOWED_IMPORT_SPECIFIERS.has(ref.specifier),
	);
	if (leftover.length > 0) {
		const names = [...new Set(leftover.map((ref) => `${ref.specifier} ${ref.name}`))].join(", ");
		throw new Error(`The generated file would still import app types: ${names}`);
	}

	return text;
}

/**
 * Turns the entry's declaration into the file the SDK ships: one exported type, a header, tabs.
 */
function generate_plugin_sdk_types_render(text: string) {
	const declarationPrefix = "export declare const bonobo_convex_api: ";
	const declarationStart = text.indexOf(declarationPrefix);
	if (declarationStart === -1 || text.indexOf(declarationPrefix, declarationStart + 1) !== -1) {
		throw new Error("Expected exactly one `bonobo_convex_api` declaration in the emitted text");
	}

	const body = text.slice(declarationStart + declarationPrefix.length);
	// The compiler indents with four spaces; the SDK package uses tabs.
	const tabbed = body.replace(/^(?: {4})+/gm, (indent) => "\t".repeat(indent.length / 4));

	return `${GENERATED_HEADER}export type BonoboConvexApi = ${tabbed}`.replace(/\r\n/g, "\n");
}

async function generate_plugin_sdk_types_main() {
	const check = process.argv.includes(CHECK_FLAG);
	const paths = generate_plugin_sdk_types_get_paths();

	const emitted = generate_plugin_sdk_types_emit_entry(paths);
	const output = generate_plugin_sdk_types_render(generate_plugin_sdk_types_inline_app_aliases(emitted, paths.entryPath));

	if (!check) {
		await fs.writeFile(paths.outputPath, output, "utf8");
		console.log(`[generate_plugin_sdk_types] Wrote ${paths.outputPath}`);
		return;
	}

	// An editor may save the committed file with CRLF; only the content matters.
	const committed = await fs.readFile(paths.outputPath, "utf8").then(
		(content) => content.replace(/\r\n/g, "\n"),
		() => null,
	);
	if (committed === output) {
		console.log(`[generate_plugin_sdk_types] ${paths.outputPath} is up to date`);
		return;
	}

	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-sdk-types-"));
	const freshPath = path.join(tempDir, "convex-api.d.ts");
	await fs.writeFile(freshPath, output, "utf8");
	console.error(
		`[generate_plugin_sdk_types] ${paths.outputPath} is stale. Run "pnpm run generate:plugin-sdk-types" in packages/app. Fresh output: ${freshPath}`,
	);
	process.exitCode = 1;
}

generate_plugin_sdk_types_main().catch((error: unknown) => {
	console.error("[generate_plugin_sdk_types] Failed", error);
	process.exitCode = 1;
});
