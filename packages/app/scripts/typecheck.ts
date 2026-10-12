import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

// TypeScript's config diagnostics need forward slashes on Windows.
const configPath = path
	.resolve(process.argv[2] ?? fileURLToPath(new URL("../tsconfig.app.json", import.meta.url)))
	.split(path.sep)
	.join("/");
const formatHost: ts.FormatDiagnosticsHost = {
	getCanonicalFileName: (fileName) => fileName,
	getCurrentDirectory: ts.sys.getCurrentDirectory,
	getNewLine: () => ts.sys.newLine,
};

const parsed = ts.getParsedCommandLineOfConfigFile(
	configPath,
	{},
	{
		...ts.sys,
		onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
			console.error(ts.formatDiagnosticsWithColorAndContext([diagnostic], formatHost));
			process.exit(2);
		},
	},
);
if (!parsed) {
	process.exit(2);
}
// Config errors must stay visible, even when the config is inside a vendor folder.
if (parsed.errors.length > 0) {
	console.error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, formatHost));
	process.exit(2);
}

console.info(`Using TypeScript compiler version ${ts.version}`);
const builder = ts.createIncrementalProgram({
	rootNames: parsed.fileNames,
	options: parsed.options,
	projectReferences: parsed.projectReferences,
	configFileParsingDiagnostics: parsed.errors,
});

// Match folders relative to the config so a parent named vendor does not hide app errors.
const configRoot = path.dirname(configPath);
const skipSourceFile = (file: ts.SourceFile) =>
	path
		.relative(configRoot, file.fileName)
		.split(path.sep)
		.some((part) => part === "vendor" || part === "node_modules");

// Process changed dependencies before reading cached app errors.
while (builder.getSemanticDiagnosticsOfNextAffectedFile(undefined, skipSourceFile)) {
	// The builder advances its changed-file list in the loop condition.
}
// Read diagnostics through the builder so unchanged files reuse cached checks.
const semanticDiagnostics = builder
	.getSourceFiles()
	.filter((file) => !skipSourceFile(file))
	.flatMap((file) => builder.getSemanticDiagnostics(file));
const configDiagnostics = [...builder.getConfigFileParsingDiagnostics(), ...builder.getOptionsDiagnostics()];
const diagnostics = ts.sortAndDeduplicateDiagnostics([
	...configDiagnostics,
	...builder.getSyntacticDiagnostics(),
	...builder.getGlobalDiagnostics(),
	...semanticDiagnostics,
	// noEmit still writes the build info used by the next check.
	...builder.emit().diagnostics,
]);
// Keep config errors visible even when their files are skipped.
const visibleDiagnostics = diagnostics.filter(
	(diagnostic) => configDiagnostics.includes(diagnostic) || !diagnostic.file || !skipSourceFile(diagnostic.file),
);
if (visibleDiagnostics.length > 0) {
	console.error(ts.formatDiagnosticsWithColorAndContext(visibleDiagnostics, formatHost));
}
console.info(
	`Visible errors: ${visibleDiagnostics.length}, suppressed errors: ${diagnostics.length - visibleDiagnostics.length}`,
);
process.exitCode = visibleDiagnostics.length > 0 ? 2 : 0;
