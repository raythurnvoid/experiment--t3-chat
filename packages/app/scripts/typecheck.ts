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

// Read diagnostics through the builder so unchanged files reuse cached checks.
const configDiagnostics = [...builder.getConfigFileParsingDiagnostics(), ...builder.getOptionsDiagnostics()];
const diagnostics = ts.sortAndDeduplicateDiagnostics([
	...configDiagnostics,
	...builder.getSyntacticDiagnostics(),
	...builder.getGlobalDiagnostics(),
	...builder.getSemanticDiagnostics(),
	// noEmit still writes the build info used by the next check.
	...builder.emit().diagnostics,
]);
// Keep the same path filters as the old lint:tsc command.
const visibleDiagnostics = diagnostics.filter(
	(diagnostic) =>
		configDiagnostics.includes(diagnostic) || !diagnostic.file || !/vendor|node_modules/.test(diagnostic.file.fileName),
);
if (visibleDiagnostics.length > 0) {
	console.error(ts.formatDiagnosticsWithColorAndContext(visibleDiagnostics, formatHost));
}
console.info(
	`Visible errors: ${visibleDiagnostics.length}, suppressed errors: ${diagnostics.length - visibleDiagnostics.length}`,
);
process.exitCode = visibleDiagnostics.length > 0 ? 2 : 0;
