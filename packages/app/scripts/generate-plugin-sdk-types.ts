/// <reference types="node" />

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

import * as ts from "typescript";

/**
 * Writes the two generated files the SDK ships: `convex-api.d.ts`, which a plugin type-checks its
 * direct Convex calls against, and `http-api.d.ts`, which types the host HTTP routes it may call.
 * Run with `--check` to compare fresh results with the committed files instead of writing them;
 * the app lint runs that mode and names the file that is stale.
 *
 * How it works: each entry under `scripts/` exports one value whose type is the whole surface.
 * This script builds the app's own TypeScript program (`tsconfig.app.json`) with that entry added,
 * asks the compiler for the entry's declaration file, and then inlines the few app-owned type
 * aliases the compiler still prints by name. The result imports only from `convex/server` and
 * `convex/values`.
 *
 * The two entries reach a plain structure by different routes. The doors are values, so the
 * compiler already prints their types in full. The route schema is built from `typeof` and the
 * inliner refuses that, so `plugin-sdk-http-api-entry.ts` wraps it in an `Expand` mapped type that
 * makes the compiler resolve the shape before it prints. That file's docblock says why.
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

function generate_plugin_sdk_types_header(description: string) {
	return `/**
 * GENERATED FILE. Do not edit by hand.
 *
${description}
 * \`packages/app/scripts/generate-plugin-sdk-types.ts\` writes this file from the app
 * (\`pnpm run generate:plugin-sdk-types\`), and the app lint fails when it is stale.
 */
`;
}

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

/**
 * One entry file and the SDK file it produces.
 */
type generate_plugin_sdk_types_Target = {
	entryPath: string;
	outputPath: string;
	constName: string;
	typeName: string;
	/** Emitted after the main type as `export type <pathTypeName> = keyof <typeName>;`. */
	pathTypeName: string | null;
	/** The header lines between "GENERATED FILE" and the "how it is written" sentence. */
	description: string;
};

function generate_plugin_sdk_types_get_paths() {
	const scriptDir = path.dirname(fileURLToPath(import.meta.url));
	const appRootDir = path.resolve(scriptDir, "..");
	const sdkDir = path.resolve(appRootDir, "..", "bonobo-plugin-sdk");

	// The compiler reports file names with forward slashes on every platform. Keep the entries in
	// that form so they can be looked up in the program.
	const entryPath = (fileName: string) => path.resolve(scriptDir, fileName).split(path.sep).join("/");

	const targets: generate_plugin_sdk_types_Target[] = [
		{
			entryPath: entryPath("plugin-sdk-api-entry.ts"),
			outputPath: path.resolve(sdkDir, "convex-api.d.ts"),
			constName: "bonobo_convex_api",
			typeName: "BonoboConvexApi",
			pathTypeName: null,
			description:
				" * The public Convex functions a plugin frame may call on its own client, typed as the app\n * declares them.\n *",
		},
		{
			entryPath: entryPath("plugin-sdk-http-api-entry.ts"),
			outputPath: path.resolve(sdkDir, "http-api.d.ts"),
			constName: "bonobo_http_api",
			typeName: "BonoboHttpApi",
			pathTypeName: "BonoboHttpApiPath",
			description:
				" * The host HTTP routes a plugin may call, typed as the app declares them: the request body of\n * each route, and the body of every status it answers.\n *",
		},
	];

	return {
		appRootDir,
		tsconfigPath: path.resolve(appRootDir, "tsconfig.app.json"),
		targets,
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
 * Builds the app program with both entries added.
 *
 * One program serves both targets. Building the whole app twice would cost about twice the time
 * and answer the same thing.
 */
function generate_plugin_sdk_types_build_program(paths: ReturnType<typeof generate_plugin_sdk_types_get_paths>) {
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
	// program rooted at the entries alone would miss them and type some values as `any`.
	const program = ts.createProgram(
		[...parsed.fileNames, ...paths.targets.map((target) => target.entryPath)],
		options,
	);

	return { program, options };
}

/**
 * Returns one entry's declaration text.
 */
function generate_plugin_sdk_types_emit_entry(
	built: ReturnType<typeof generate_plugin_sdk_types_build_program>,
	entryPath: string,
) {
	const entry = built.program.getSourceFile(entryPath);
	if (!entry) {
		throw new Error(`Entry ${entryPath} is not in the program`);
	}

	let text = "";
	const result = built.program.emit(
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
		throw new Error(`Declaration emit produced no output for ${entryPath}`);
	}

	return { ...built, text };
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

	// The render step keeps the declaration and drops everything above it, so a top-level
	// `import type { X } from "../app-file.js"` would be dropped and leave `X` dangling in the SDK
	// file. The loop above cannot see one: it looks for inline `import("...")` types, and a real
	// import statement is not one. This fires when an entry hands the compiler a type it can print
	// by name instead of a shape it has to write out.
	const source = ts.createSourceFile("emitted.d.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const importedNames = source.statements
		.filter((statement) => ts.isImportDeclaration(statement))
		.map((statement) => statement.getText(source));
	if (importedNames.length > 0) {
		throw new Error(`The emitted declaration still imports app types by name:\n${importedNames.join("\n")}`);
	}

	return text;
}

/**
 * Turns one entry's declaration into the file the SDK ships: the exported type, a header, tabs.
 */
function generate_plugin_sdk_types_render(text: string, target: generate_plugin_sdk_types_Target) {
	const declarationPrefix = `export declare const ${target.constName}: `;
	const declarationStart = text.indexOf(declarationPrefix);
	if (declarationStart === -1 || text.indexOf(declarationPrefix, declarationStart + 1) !== -1) {
		throw new Error(`Expected exactly one \`${target.constName}\` declaration in the emitted text`);
	}

	const body = text.slice(declarationStart + declarationPrefix.length);
	// The compiler indents with four spaces; the SDK package uses tabs.
	const tabbed = body.replace(/^(?: {4})+/gm, (indent) => "\t".repeat(indent.length / 4));

	const header = generate_plugin_sdk_types_header(target.description);
	const pathType = target.pathTypeName ? `\nexport type ${target.pathTypeName} = keyof ${target.typeName};\n` : "";

	return `${header}export type ${target.typeName} = ${tabbed}${pathType}`.replace(/\r\n/g, "\n");
}

async function generate_plugin_sdk_types_main() {
	const check = process.argv.includes(CHECK_FLAG);
	const paths = generate_plugin_sdk_types_get_paths();
	const built = generate_plugin_sdk_types_build_program(paths);

	for (const target of paths.targets) {
		const emitted = generate_plugin_sdk_types_emit_entry(built, target.entryPath);
		const output = generate_plugin_sdk_types_render(
			generate_plugin_sdk_types_inline_app_aliases(emitted, target.entryPath),
			target,
		);

		if (!check) {
			await fs.writeFile(target.outputPath, output, "utf8");
			console.log(`[generate_plugin_sdk_types] Wrote ${target.outputPath}`);
			continue;
		}

		// An editor may save a committed file with CRLF; only the content matters.
		const committed = await fs.readFile(target.outputPath, "utf8").then(
			(content) => content.replace(/\r\n/g, "\n"),
			() => null,
		);
		if (committed === output) {
			console.log(`[generate_plugin_sdk_types] ${target.outputPath} is up to date`);
			continue;
		}

		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-sdk-types-"));
		const freshPath = path.join(tempDir, path.basename(target.outputPath));
		await fs.writeFile(freshPath, output, "utf8");
		console.error(
			`[generate_plugin_sdk_types] ${target.outputPath} is stale. Run "pnpm run generate:plugin-sdk-types" in packages/app. Fresh output: ${freshPath}`,
		);
		process.exitCode = 1;
	}
}

generate_plugin_sdk_types_main().catch((error: unknown) => {
	console.error("[generate_plugin_sdk_types] Failed", error);
	process.exitCode = 1;
});
