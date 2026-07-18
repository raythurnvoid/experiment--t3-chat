#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const DEFAULT_TERMS = [
	"projection",
	"projections",
	"data",
	"state",
	"thing",
	"things",
	"stuff",
	"handler",
	"handlers",
	"manager",
	"managers",
	"row",
	"rows",
];

const args = process.argv.slice(2);
const pathArgs = [];
const extraTerms = [];
let scanStaged = false;
let scanUnstaged = false;
let afterDoubleDash = false;

for (let index = 0; index < args.length; index++) {
	const arg = args[index];
	if (afterDoubleDash) {
		pathArgs.push(arg);
		continue;
	}
	if (arg === "--") {
		afterDoubleDash = true;
		continue;
	}
	if (arg === "--staged") {
		scanStaged = true;
		continue;
	}
	if (arg === "--unstaged") {
		scanUnstaged = true;
		continue;
	}
	if (arg === "--all") {
		scanStaged = true;
		scanUnstaged = true;
		continue;
	}
	if (arg === "--term") {
		const term = args[index + 1];
		if (!term) {
			console.error("diff-vocabulary-audit: --term requires a value");
			process.exit(1);
		}
		extraTerms.push(term);
		index++;
		continue;
	}
	if (arg.startsWith("--term=")) {
		const term = arg.slice("--term=".length).trim();
		if (!term) {
			console.error("diff-vocabulary-audit: --term requires a value");
			process.exit(1);
		}
		extraTerms.push(term);
		continue;
	}
	pathArgs.push(arg);
}

if (!scanStaged && !scanUnstaged) {
	scanStaged = true;
	scanUnstaged = true;
}

const watchedTerms = [...DEFAULT_TERMS, ...extraTerms];
const watchedTermPattern = new RegExp(
	`(?:\\b(?:${watchedTerms.map(escape_regex).join("|")})\\b|\\bre-project(?:ing|ed)?\\b)`,
	"iu",
);
const ignoredPathPattern = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$|(?:^|\/)_generated\//u;
const warnings = [];

if (scanUnstaged) {
	collect_warnings("unstaged", ["diff", "--unified=0", "--no-ext-diff", "--", ...pathArgs]);
	collect_untracked_warnings();
}
if (scanStaged) {
	collect_warnings("staged", ["diff", "--cached", "--unified=0", "--no-ext-diff", "--", ...pathArgs]);
}

if (warnings.length === 0) {
	console.log("Vocabulary audit: no watched terms found in added diff lines.");
	process.exit(0);
}

console.log("Vocabulary audit warnings:");
for (const warning of warnings) {
	console.log(`${warning.path}:${warning.lineNumber} [${warning.scope}] "${warning.term}": ${warning.text.trim()}`);
}
console.log("");
console.log("Warnings only. Replace vague terms with concrete code nouns when the local context supports it.");

function collect_warnings(scope, gitArgs) {
	const diff = execFileSync("git", gitArgs, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
	let filePath = null;
	let nextLineNumber = 0;

	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) {
			const match = /^diff --git a\/.* b\/(.+)$/u.exec(line);
			filePath = match?.[1] ?? null;
			continue;
		}
		if (line.startsWith("@@")) {
			const match = /\+(\d+)(?:,\d+)?/u.exec(line);
			nextLineNumber = match ? Number(match[1]) : 0;
			continue;
		}
		if (line.startsWith("+++") || line.startsWith("---")) {
			continue;
		}
		if (line.startsWith("+")) {
			if (filePath && !ignoredPathPattern.test(filePath)) {
				const text = line.slice(1);
				const textForAudit = text.replace(/`[^`]*`/gu, "");
				const match = watchedTermPattern.exec(textForAudit);
				if (match) {
					warnings.push({ scope, path: filePath, lineNumber: nextLineNumber, term: match[0], text });
				}
			}
			nextLineNumber++;
			continue;
		}
		if (line.startsWith(" ")) {
			nextLineNumber++;
		}
	}
}

function collect_untracked_warnings() {
	const output = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathArgs], {
		encoding: "utf8",
		maxBuffer: 50 * 1024 * 1024,
	});

	for (const filePath of output.split("\0").filter(Boolean)) {
		if (ignoredPathPattern.test(filePath)) continue;

		const lines = readFileSync(filePath, "utf8").split(/\r?\n/u);
		for (let index = 0; index < lines.length; index++) {
			const text = lines[index];
			const textForAudit = text.replace(/`[^`]*`/gu, "");
			const match = watchedTermPattern.exec(textForAudit);
			if (match) {
				warnings.push({ scope: "untracked", path: filePath, lineNumber: index + 1, term: match[0], text });
			}
		}
	}
}

function escape_regex(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
