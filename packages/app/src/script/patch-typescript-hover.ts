import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

type PatchResult =
	| {
			ok: true;
			filePath: string;
			beforeLength: number;
			afterLength: number;
	  }
	| {
			ok: false;
			filePath: string;
			reason: string;
	  };

const ai_chat_DEFAULT_HOVER_MAXIMUM_LENGTH = 50_000;
const ai_chat_DEFAULT_STRICT = false;

function resolveTypeScriptLibFile(moduleId: string) {
	const require = createRequire(import.meta.url);
	return require.resolve(moduleId);
}

function patchTypeScriptFile(filePath: string, desiredMaximumLength: number): PatchResult {
	const before = fs.readFileSync(filePath, "utf8");

	const replacementCandidates: Array<{
		name: string;
		regexp: RegExp;
		replacer: (match: string, prefix: string, num: string, suffix: string) => string;
	}> = [
		{
			name: "defaultMaximumTruncationLength var assignment",
			regexp: /^(\s*var\s+defaultMaximumTruncationLength\s*=\s*)(\d+)(\s*;)/m,
			replacer: (_match, prefix, num, suffix) => {
				const current = Number(num);
				if (Number.isFinite(current) && current >= desiredMaximumLength) {
					return `${prefix}${num}${suffix}`;
				}
				return `${prefix}${desiredMaximumLength}${suffix}`;
			},
		},
		{
			name: "defaultMaximumTruncationLength let/const assignment",
			regexp: /^(\s*(?:let|const)\s+defaultMaximumTruncationLength\s*=\s*)(\d+)(\s*;)/m,
			replacer: (_match, prefix, num, suffix) => {
				const current = Number(num);
				if (Number.isFinite(current) && current >= desiredMaximumLength) {
					return `${prefix}${num}${suffix}`;
				}
				return `${prefix}${desiredMaximumLength}${suffix}`;
			},
		},
	];

	let after = before;
	let didChange = false;
	for (const candidate of replacementCandidates) {
		if (!candidate.regexp.test(after)) {
			continue;
		}
		const next = after.replace(candidate.regexp, candidate.replacer);
		if (next !== after) {
			after = next;
			didChange = true;
		}
	}

	if (!didChange) {
		return {
			ok: false,
			filePath: filePath,
			reason:
				"Could not find a defaultMaximumTruncationLength declaration to patch (TypeScript internals may have changed).",
		};
	}

	fs.writeFileSync(filePath, after, "utf8");

	return {
		ok: true,
		filePath: filePath,
		beforeLength: before.length,
		afterLength: after.length,
	};
}

function formatResult(result: PatchResult) {
	if (result.ok) {
		return `patched: ${result.filePath}`;
	}
	return `skipped: ${result.filePath} (${result.reason})`;
}

function parseArgs(argv: string[]) {
	let maximumLength = ai_chat_DEFAULT_HOVER_MAXIMUM_LENGTH;
	let strict = ai_chat_DEFAULT_STRICT;

	for (const arg of argv) {
		if (arg === "--strict") {
			strict = true;
			continue;
		}

		if (arg.startsWith("--maximumLength=")) {
			const value = arg.slice("--maximumLength=".length);
			const parsed = Number(value);
			if (Number.isFinite(parsed) && parsed > 0) {
				maximumLength = parsed;
			}
			continue;
		}
	}

	return { maximumLength, strict };
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const desiredMaximumLength = args.maximumLength;

	const candidates: Array<{ label: string; resolver: () => string }> = [
		{ label: "typescript (lib/typescript.js)", resolver: () => resolveTypeScriptLibFile("typescript") },
		{
			label: "typescript/lib/tsserver.js",
			resolver: () => resolveTypeScriptLibFile("typescript/lib/tsserver"),
		},
		{
			label: "typescript/lib/tsserverlibrary.js",
			resolver: () => resolveTypeScriptLibFile("typescript/lib/tsserverlibrary"),
		},
	];

	const results: PatchResult[] = [];

	for (const candidate of candidates) {
		let resolved: string | undefined;
		try {
			resolved = candidate.resolver();
		} catch (error) {
			results.push({
				ok: false,
				filePath: `${candidate.label}`,
				reason: `not resolvable from this package (${error instanceof Error ? error.message : "unknown error"})`,
			});
			continue;
		}

		const filePath = path.resolve(resolved);
		if (!fs.existsSync(filePath)) {
			results.push({ ok: false, filePath: filePath, reason: "file does not exist" });
			continue;
		}

		results.push(patchTypeScriptFile(filePath, desiredMaximumLength));
	}

	for (const result of results) {
		// eslint-disable-next-line no-console
		console.log(formatResult(result));
	}

	const didPatchAnything = results.some((r) => r.ok);
	if (!didPatchAnything && args.strict) {
		console.error(
			`No TypeScript files were patched. If you're on Cursor, expandable hovers may be unsupported, and if you're on TypeScript >=5.9, prefer editor setting js/ts.hover.maximumLength.`,
		);
		process.exitCode = 1;
	}
}

main();
