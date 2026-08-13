import { tool, type InferToolInput, type InferToolOutput } from "ai";
import Exa, { ExaError, type RegularSearchOptions, type SearchResponse } from "exa-js";
import z from "zod";
import dedent from "dedent";
import { createPatch } from "diff";
import type { ActionCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";
import { internal } from "../convex/_generated/api.js";
import type { public_api_Scope } from "../shared/public-api.ts";
import { files_READ_RANGE_MAX_LINES } from "../convex/files_nodes.ts";
import { server_path_normalize } from "./server-utils.ts";
import { crypto_random_hex, crypto_sha256_hex } from "./crypto-utils.ts";
import {
	files_EDITABLE_TEXT_EXTENSIONS,
	files_editable_text_refusal_message,
	files_get_editable_text_content_type,
	files_normalize_ai_edit_content,
	files_normalize_lf_newlines,
} from "./files.ts";
import { path_name_of } from "../shared/paths.ts";
import {
	bash_EXTERNAL_MOUNTS_ROOT,
	bash_PLUGINS_MOUNT_ROOT,
	bash_is_path_under,
	files_agent_upsert_file_pending_update,
} from "./bash-utils.ts";

/**
 * Advanced replace utility mirroring OpenCode's edit replacer pipeline.
 *
 * Notes:
 * - We require oldString to be non-empty (unlike OpenCode's special-case overwrite).
 * - The pipeline order and algorithms match OpenCode's active modes.
 */
type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.0;
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.3;

/**
 * Calculate the similarity between two strings.
 *
 * @returns A number between 0 and 1, an higher number means the strings are more similar.
 */
function levenshtein(a: string, b: string): number {
	if (a === "" || b === "") return Math.max(a.length, b.length);
	const matrix: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
		Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
	);
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
		}
	}
	return matrix[a.length][b.length];
}

/**
 * Inspired by `vendor/opencode/packages/opencode/src/tool/edit.ts` (SimpleReplacer)
 *
 * This replacer matches the exact literal oldString as-is,
 * ensuring byte-for-byte precision and highly predictable diffs in the simplest case.
 *
 * Order: 1
 * Pros:
 * - Exact and fast
 * - Lowest risk, predictable diffs
 * Cons:
 * - Brittle to whitespace/escaping/indentation changes
 */
function* ai_chat_tool_edit_file_replacer_simple(_content: string, find: string): Generator<string, void, unknown> {
	if (find !== find.trim()) return;
	yield find;
}

/**
 * Inspired by `vendor/opencode/packages/opencode/src/tool/edit.ts` (LineTrimmedReplacer)
 *
 * This replacer compares multi-line content by trimming each line before matching,
 * making it resilient to incidental leading/trailing spaces while preserving the original block.
 *
 * Order: 2
 * Pros:
 * - Ignores leading/trailing whitespace per line
 * - Good for multi-line blocks
 * Cons:
 * - Can collide when multiple blocks are equal after per-line trim
 */
function* ai_chat_tool_edit_file_replacer_line_trimmed(
	content: string,
	find: string,
): Generator<string, void, unknown> {
	const originalLines = content.split("\n");
	const searchLines = find.split("\n");
	if (searchLines[searchLines.length - 1] === "") searchLines.pop();
	for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
		let matches = true;
		for (let j = 0; j < searchLines.length; j++) {
			const originalTrimmed = originalLines[i + j].trim();
			const searchTrimmed = searchLines[j].trim();
			if (originalTrimmed !== searchTrimmed) {
				matches = false;
				break;
			}
		}
		if (matches) {
			let matchStartIndex = 0;
			for (let k = 0; k < i; k++) matchStartIndex += originalLines[k].length + 1;
			let matchEndIndex = matchStartIndex;
			for (let k = 0; k < searchLines.length; k++) {
				matchEndIndex += originalLines[i + k].length;
				if (k < searchLines.length - 1) matchEndIndex += 1;
			}
			yield content.substring(matchStartIndex, matchEndIndex);
		}
	}
}

/**
 * Inspired by `vendor/opencode/packages/opencode/src/tool/edit.ts` (BlockAnchorReplacer)
 *
 * This replacer anchors on the first and last trimmed lines of the block,
 * then checks middle-line similarity, allowing matches even when the interior has drifted.
 *
 * Order: 3
 * Pros:
 * - Robust to middle-line drift using first/last anchors
 * - Can find moved blocks
 * Cons:
 * - Heuristic thresholds; slower on large files
 * - Possible false positives
 */
function* ai_chat_tool_edit_file_replacer_block_anchor(
	content: string,
	find: string,
): Generator<string, void, unknown> {
	const originalLines = content.split("\n");
	const searchLines = find.split("\n");
	if (searchLines.length < 3) return;
	if (searchLines[searchLines.length - 1] === "") searchLines.pop();
	const firstLineSearch = searchLines[0].trim();
	const lastLineSearch = searchLines[searchLines.length - 1].trim();
	const searchBlockSize = searchLines.length;
	const candidates: Array<{ startLine: number; endLine: number }> = [];
	for (let i = 0; i < originalLines.length; i++) {
		if (originalLines[i].trim() !== firstLineSearch) continue;
		for (let j = i + 2; j < originalLines.length; j++) {
			if (originalLines[j].trim() === lastLineSearch) {
				candidates.push({ startLine: i, endLine: j });
				break;
			}
		}
	}
	if (candidates.length === 0) return;
	if (candidates.length === 1) {
		const { startLine, endLine } = candidates[0]!;
		const actualBlockSize = endLine - startLine + 1;
		let similarity = 0;
		const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
		if (linesToCheck > 0) {
			for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
				const originalLine = originalLines[startLine + j].trim();
				const searchLine = searchLines[j].trim();
				const maxLen = Math.max(originalLine.length, searchLine.length);
				if (maxLen === 0) continue;
				const distance = levenshtein(originalLine, searchLine);
				similarity += (1 - distance / maxLen) / linesToCheck;
				if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) break;
			}
		} else {
			similarity = 1.0;
		}
		if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
			let matchStartIndex = 0;
			for (let k = 0; k < startLine; k++) matchStartIndex += originalLines[k].length + 1;
			let matchEndIndex = matchStartIndex;
			for (let k = startLine; k <= endLine; k++) {
				matchEndIndex += originalLines[k].length;
				if (k < endLine) matchEndIndex += 1;
			}
			yield content.substring(matchStartIndex, matchEndIndex);
		}
		return;
	}
	let bestMatch: { startLine: number; endLine: number } | null = null;
	let maxSimilarity = -1;
	for (const candidate of candidates) {
		const { startLine, endLine } = candidate;
		const actualBlockSize = endLine - startLine + 1;
		let similarity = 0;
		const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
		if (linesToCheck > 0) {
			for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
				const originalLine = originalLines[startLine + j].trim();
				const searchLine = searchLines[j].trim();
				const maxLen = Math.max(originalLine.length, searchLine.length);
				if (maxLen === 0) continue;
				const distance = levenshtein(originalLine, searchLine);
				similarity += 1 - distance / maxLen;
			}
			similarity /= linesToCheck || 1;
		} else {
			similarity = 1.0;
		}
		if (similarity > maxSimilarity) {
			maxSimilarity = similarity;
			bestMatch = candidate;
		}
	}
	if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
		const { startLine, endLine } = bestMatch;
		let matchStartIndex = 0;
		for (let k = 0; k < startLine; k++) matchStartIndex += originalLines[k].length + 1;
		let matchEndIndex = matchStartIndex;
		for (let k = startLine; k <= endLine; k++) {
			matchEndIndex += originalLines[k].length;
			if (k < endLine) matchEndIndex += 1;
		}
		yield content.substring(matchStartIndex, matchEndIndex);
	}
}

/**
 * Inspired by `vendor/opencode/packages/opencode/src/tool/edit.ts` (WhitespaceNormalizedReplacer)
 *
 * This replacer collapses whitespace for comparison so that spacing differences
 * do not prevent a match, while still yielding the original text for replacement.
 *
 * Order: 4
 * Pros:
 * - Collapses whitespace; tolerant to spacing variations
 * - Works for inline and multi-line matches
 * Cons:
 * - Risky when whitespace is semantically meaningful (tables, YAML, code)
 */
function* ai_chat_tool_edit_file_replacer_whitespace_normalized(
	content: string,
	find: string,
): Generator<string, void, unknown> {
	const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim();
	const normalizedFind = normalizeWhitespace(find);
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (normalizeWhitespace(line) === normalizedFind) {
			yield line;
		} else {
			const normalizedLine = normalizeWhitespace(line);
			if (normalizedLine.includes(normalizedFind)) {
				const words = find.trim().split(/\s+/);
				if (words.length > 0) {
					const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
					try {
						const regex = new RegExp(pattern);
						const match = line.match(regex);
						if (match) yield match[0]!;
					} catch {}
				}
			}
		}
	}
	const findLines = find.split("\n");
	if (findLines.length > 1) {
		for (let i = 0; i <= lines.length - findLines.length; i++) {
			const block = lines.slice(i, i + findLines.length);
			if (normalizeWhitespace(block.join("\n")) === normalizedFind) {
				yield block.join("\n");
			}
		}
	}
}

/**
 * Inspired by `vendor/opencode/packages/opencode/src/tool/edit.ts` (IndentationFlexibleReplacer)
 *
 * This replacer removes common indentation before comparison to handle blocks
 * that have been re-indented, matching the original block regardless of leading spaces.
 *
 * Order: 5
 * Pros:
 * - Matches blocks regardless of common leading indentation
 * - Good for re-indented code/docs
 * Cons:
 * - Can over-match the same block at multiple indents
 */
function* ai_chat_tool_edit_file_replacer_indentation_flexible(
	content: string,
	find: string,
): Generator<string, void, unknown> {
	const removeIndentation = (text: string) => {
		const lines = text.split("\n");
		const nonEmpty = lines.filter((l) => l.trim().length > 0);
		if (nonEmpty.length === 0) return text;
		const minIndent = Math.min(
			...nonEmpty.map((line) => {
				const m = line.match(/^(\s*)/);
				return m ? m[1]!.length : 0;
			}),
		);
		return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n");
	};
	const normalizedFind = removeIndentation(find);
	const contentLines = content.split("\n");
	const findLines = find.split("\n");
	for (let i = 0; i <= contentLines.length - findLines.length; i++) {
		const block = contentLines.slice(i, i + findLines.length).join("\n");
		if (removeIndentation(block) === normalizedFind) yield block;
	}
}

/**
 * Inspired by `vendor/opencode/packages/opencode/src/tool/edit.ts` (EscapeNormalizedReplacer)
 *
 * This replacer unescapes sequences like \n and \t when matching,
 * making it possible to locate content embedded inside string literals or escaped contexts.
 *
 * Order: 6
 * Pros:
 * - Unescapes sequences (\n, \t, \' , \" , \`, \\) to match embedded strings
 * Cons:
 * - May over-match in files with many similar string literals
 */
function* ai_chat_tool_edit_file_replacer_escape_normalized(
	content: string,
	find: string,
): Generator<string, void, unknown> {
	const unescapeString = (str: string): string =>
		str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, captured) => {
			switch (captured) {
				case "n":
					return "\n";
				case "t":
					return "\t";
				case "r":
					return "\r";
				case "'":
					return "'";
				case '"':
					return '"';
				case "`":
					return "`";
				case "\\":
					return "\\";
				case "\n":
					return "\n";
				case "$":
					return "$";
				default:
					return match;
			}
		});
	const unescapedFind = unescapeString(find);
	if (unescapeString(content) === content && unescapedFind === find) {
		return;
	}
	if (unescapeString(content) === unescapedFind) {
		yield content;
	}
	if (content.includes(unescapedFind)) yield unescapedFind;
	const lines = content.split("\n");
	const findLines = unescapedFind.split("\n");
	for (let i = 0; i <= lines.length - findLines.length; i++) {
		const block = lines.slice(i, i + findLines.length).join("\n");
		const unescapedBlock = unescapeString(block);
		if (unescapedBlock === unescapedFind) yield block;
	}
}

/**
 * Inspired by `vendor/opencode/packages/opencode/src/tool/edit.ts` (TrimmedBoundaryReplacer)
 *
 * This replacer trims only the outer boundary of the target text before matching,
 * making it resilient when the copied block includes extra leading or trailing blank space.
 *
 * Order: 7
 * Pros:
 * - Helps when the copied block differs only at the boundaries
 * Cons:
 * - Higher collision risk than earlier matchers
 */
function* ai_chat_tool_edit_file_replacer_trimmed_boundary(
	content: string,
	find: string,
): Generator<string, void, unknown> {
	const trimmedFind = find.trim();
	const trimmedFindLines = trimmedFind.split("\n");

	if (trimmedFind === find) return;

	if (content.includes(trimmedFind)) yield trimmedFind;

	const lines = content.split("\n");

	for (let i = 0; i <= lines.length - trimmedFindLines.length; i++) {
		const block = lines.slice(i, i + trimmedFindLines.length).join("\n");
		if (block.trim() === trimmedFind) yield block;
	}
}

/**
 * Inspired by `vendor/opencode/packages/opencode/src/tool/edit.ts` (ContextAwareReplacer)
 *
 * This replacer uses the first and last lines as anchors and accepts a candidate block
 * when the middle lines still resemble the requested block closely enough.
 *
 * Order: 8
 * Pros:
 * - Helps when the middle of a block drifted slightly
 * Cons:
 * - Heuristic; riskier than the earlier exact-ish fallbacks
 */
function* ai_chat_tool_edit_file_replacer_context_aware(
	content: string,
	find: string,
): Generator<string, void, unknown> {
	const findLines = find.split("\n");
	if (findLines.length < 3) return;
	if (findLines[findLines.length - 1] === "") findLines.pop();

	const contentLines = content.split("\n");
	const firstLine = findLines[0].trim();
	const lastLine = findLines[findLines.length - 1].trim();

	for (let i = 0; i < contentLines.length; i++) {
		if (contentLines[i].trim() !== firstLine) continue;

		for (let j = i + 2; j < contentLines.length; j++) {
			if (contentLines[j].trim() !== lastLine) continue;

			const blockLines = contentLines.slice(i, j + 1);
			if (blockLines.length !== findLines.length) break;

			let matchingLines = 0;
			let totalNonEmptyLines = 0;

			for (let k = 1; k < blockLines.length - 1; k++) {
				const blockLine = blockLines[k].trim();
				const findLine = findLines[k].trim();

				if (blockLine.length > 0 || findLine.length > 0) {
					totalNonEmptyLines++;
					if (blockLine === findLine) matchingLines++;
				}
			}

			if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
				yield blockLines.join("\n");
				break;
			}

			break;
		}
	}
}

export function replace_once_or_all(
	content: string,
	oldString: string,
	newString: string,
	opts?: { replaceAll?: boolean; mode?: "auto" | "exact" },
): { content: string; matches: number; matcher: string } {
	if (oldString.length === 0) throw new Error("oldString must not be empty");
	if (oldString === newString) throw new Error("oldString and newString must be different");

	const replaceAll = !!opts?.replaceAll;
	let foundMatch = false;
	const activePipeline =
		opts?.mode === "exact"
			? ([["simple", ai_chat_tool_edit_file_replacer_simple]] as const)
			: ([
					["simple", ai_chat_tool_edit_file_replacer_simple],
					["line_trimmed", ai_chat_tool_edit_file_replacer_line_trimmed],
					["block_anchor", ai_chat_tool_edit_file_replacer_block_anchor],
					["whitespace_normalized", ai_chat_tool_edit_file_replacer_whitespace_normalized],
					["indentation_flexible", ai_chat_tool_edit_file_replacer_indentation_flexible],
					["escape_normalized", ai_chat_tool_edit_file_replacer_escape_normalized],
					["trimmed_boundary", ai_chat_tool_edit_file_replacer_trimmed_boundary],
					["context_aware", ai_chat_tool_edit_file_replacer_context_aware],
					// Keep MultiOccurrence disabled.
					// `replaceAll` already handles the safe exact global-replace case.
				] as const satisfies ReadonlyArray<readonly [string, Replacer]>);

	for (const [matcher, replacer] of activePipeline) {
		for (const search of replacer(content, oldString)) {
			const firstIndex = content.indexOf(search);
			if (firstIndex === -1) continue;
			foundMatch = true;
			if (replaceAll) {
				const occurrences = search.length === 0 ? 0 : content.split(search).length - 1;
				if (occurrences === 0) continue;
				return {
					content: content.split(search).join(newString),
					matches: occurrences,
					matcher,
				};
			} else {
				const lastIndex = content.lastIndexOf(search);
				if (firstIndex !== lastIndex) continue;
				const updated = content.substring(0, firstIndex) + newString + content.substring(firstIndex + search.length);
				return { content: updated, matches: 1, matcher };
			}
		}
	}

	if (!foundMatch) {
		throw new Error(
			"oldString not found in content. It must match exactly, including whitespace, indentation, and line endings.",
		);
	}

	throw new Error("Found multiple matches for oldString. Provide more surrounding context to make the match unique.");
}

// The plain text half of the writable-extension contract, shown in tool descriptions so the
// model learns the real rule instead of assuming Markdown-only writes.
const ai_chat_PLAIN_TEXT_EXTENSIONS_LIST = files_EDITABLE_TEXT_EXTENSIONS.filter((extension) => extension !== "md")
	.map((extension) => `.${extension}`)
	.join(", ");

// #region bash
export function ai_chat_tool_create_bash(
	ctx: ActionCtx,
	ctxData: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		organizationName: string;
		workspaceName: string;
		userId: Id<"users">;
		getThreadId: () => Id<"ai_chat_threads"> | null;
	},
	options: {
		allowDbFilesMkdir: boolean;
	},
) {
	const HOME = "/home/cloud-usr";
	const appMountPath = `${HOME}/w`;
	const currentWorkspacePath = `${appMountPath}/${ctxData.organizationName}/${ctxData.workspaceName}`;
	return tool({
		description: dedent`\
			Run a non-interactive shell command in the user's cloud file environment. Familiar Bash command names are available; /tmp has the safe Just Bash native-style scratch command surface, while app files are db-backed and do not have full POSIX/GNU filesystem semantics.
			Bash starts in the current workspace path at ~/w/${ctxData.organizationName}/${ctxData.workspaceName} (${currentWorkspacePath}). ~ is ${HOME}, the app mount is ${appMountPath}, and /tmp is durable scratch scoped to this chat thread.
			A read-only app file or folder can still be read, searched, downloaded, shared, and copied OUT to a writable destination. cp may read a read-only source, but its destination and any replaced item must be writable. If a write, mkdir, mv, rm, cp destination, redirect, tee, or edit_file call says an app path is read-only, do not retry that path with another write tool; it cannot change until the user makes it writable.
			/tmp persists across Bash calls in this chat and reloads from Convex if the warm backend runtime cache is gone. It is not shared with new chats and is not app file storage; use app file tools for durable user-visible files.
			Do not call /tmp ephemeral or temporary in a way that implies same-chat data loss. If a fresh chat cannot read a /tmp path created in another chat, that is expected evidence of per-chat isolation, not a global Bash failure.
			Bash cwd persists across tool calls in the same chat. If the previous Bash output already shows the desired cwd, use bare or relative commands instead of repeating cd.
			App-mount limitations apply only to paths under ${currentWorkspacePath} or ${appMountPath}. Do not describe them as global Bash limitations. If a command touches only /tmp or stdin, use normal scratch commands; if it touches the app mount, use the app-aware command forms below.
			Agent-only read-only external source mounts live under ${bash_EXTERNAL_MOUNTS_ROOT} (for example ${bash_EXTERNAL_MOUNTS_ROOT}/<name>). They are a backend mirror of an external repository for Bash reads, not the user's app files: they never appear in the Files sidebar, public file API, or app file tools. Browse and read them with the same app-aware commands (ls, find, tree, cat, head, tail, wc, stat, grep, textgrep, sed). Bare ls ${bash_EXTERNAL_MOUNTS_ROOT} lists the available mount names; pick a mount with ${bash_EXTERNAL_MOUNTS_ROOT}/<name> before reading files. All writes are rejected: no file writes (redirects, touch, tee, edit_file), rm, mv, or cp into ${bash_EXTERNAL_MOUNTS_ROOT}. App files and read-only mount files cannot be loaded as shell code through bash, sh, eval, source, ., nested command reads, or xargs calling source or .; explicit /tmp scripts remain available. cp ${bash_EXTERNAL_MOUNTS_ROOT}/<name>/<file> /tmp/<name> is allowed to copy mount content into scratch. search, tree, and find at ${bash_EXTERNAL_MOUNTS_ROOT} fan out across every mount in name order (search results are per-mount relevance, concatenated);
			scope to one mount with ${bash_EXTERNAL_MOUNTS_ROOT}/<name> when you already know the mount. meta search still requires a single mount scope via --path ${bash_EXTERNAL_MOUNTS_ROOT}/<name>. If the mount listing changes between pages, the continuation reports "listing changed"; rerun without --cursor.
			Read-only sources of plugins installed in the current workspace live under ${bash_PLUGINS_MOUNT_ROOT}/<pluginName>. A plugin's source appears there only while that plugin is installed in this workspace; ${bash_PLUGINS_MOUNT_ROOT} does not exist when no plugin is installed, and a missing ${bash_PLUGINS_MOUNT_ROOT}/<pluginName> means that plugin is not installed here. Browse and read them with the same app-aware commands as ${bash_EXTERNAL_MOUNTS_ROOT}; bare ls ${bash_PLUGINS_MOUNT_ROOT} lists installed plugin names. All writes are rejected, plugin source follows the same shell-code rule as other read-only mounts, and cp ${bash_PLUGINS_MOUNT_ROOT}/<pluginName>/<file> /tmp/<name> is allowed for scratch copies. search, tree, and find at ${bash_PLUGINS_MOUNT_ROOT} fan out across every installed plugin in plugin-name order (search results are per-plugin relevance, concatenated); scope to one plugin with ${bash_PLUGINS_MOUNT_ROOT}/<pluginName> when you already know the plugin. meta search still requires a single plugin scope via --path ${bash_PLUGINS_MOUNT_ROOT}/<pluginName>. If the installed plugin listing changes between pages, the continuation reports "listing changed"; rerun without --cursor.
			Native-style /tmp commands use Just Bash's own argument parsing and include safe text/file utilities such as du, diff, rg, jq, base64, sha256sum, nl, rev, and tac; the Unix file command is intentionally unavailable.
			If file fails or the user asks for it, do not stop after reporting that it is unavailable; run supported recovery commands such as stat, wc, head, or cat on the same /tmp path when that answers the request.
			/tmp native commands are Just Bash browser commands, not host GNU coreutils. Prefer simple portable forms such as du file; if a /tmp option fails but the command is useful, retry once with simpler native syntax.
			When retrying a /tmp command option, prefer doing related scratch work in one call when convenient, but previous /tmp files are available in later calls in the same chat.
			When a user names an app-root path like /docs, run it as ${currentWorkspacePath}/docs or cd ${currentWorkspacePath} and use docs; do not treat /docs as a host-root path.
			Supported app-file inspection commands include pwd, cd, ls, find, search, cat, head, tail, wc, stat, single-file grep, and tree.
			When reporting Bash results, treat app-only flags such as --limit, --cursor, --path-query, and --extension as supported app Bash syntax; do not warn that a successful app command is non-standard.
			Printed Next page commands use short cursor ids without an @ prefix; run the exact printed command to continue. If the user asks for exactly one continuation, one continuation, or one next page, run only the first printed continuation and then stop even if that page prints another Next page command. If the user asked for continuations from multiple commands, continue each requested command before summarizing.
			If a failed Bash command prints a Try: command that directly matches the user's request, run that Try: command next instead of only reporting the failure.
			When using bash -c or sh -c to compare /tmp and app-mount behavior, use separate nested invocations in one outer Bash call so a blocked app redirect cannot hide earlier /tmp stdout.
			For xargs path checks, print pathnames into xargs such as printf '%s\n' <path> | xargs cat; do not pipe file content to xargs when the input is meant to be a pathname. When feeding many pathnames such as find ... | xargs cat, add xargs -n 10 so each reader invocation stays within the 10-file per-command cap.
			Shell pathname expansion works for /tmp scratch paths. General app-file and mount glob operands such as src/**/*.ts, foo?.txt, and [abc].md are unsupported; simple find patterns like *.md are converted to indexed extension search.
			ls --limit and find --limit are app-file pagination commands. Relative paths resolve against the current working directory.
			Content-vs-path rule: use search for text inside files, and use find only for path/name discovery. Plain requests like "search for X with limit N" mean content search, so run search --limit N X. If the user says "search for the X file", "find the X file", "file named X", or "path/name contains X", use find. If the user says "search inside <folder> for X", "where does X appear", or "files mention X", run search --path <folder> X or search X; do not substitute find --path-query.
			Use meta search --where '{"eq":["frontmatter.from","alice@example.com"]}' to search indexed Markdown YAML frontmatter. Prefer meta search/meta get over reading raw file text when answering which files have a frontmatter field or value. Fields must be qualified frontmatter.* names; one positive predicate per command is supported: exists, eq, prefix, or range. range works on numeric fields and on date-like string fields: strings shaped like ISO dates (e.g. 2026-07-29 or 2026-07-29T14:30:36.264Z) are also indexed as a second maybe_date value, and meta get marks those lines with (maybe_date), so a field is date-filterable only when meta get shows a maybe_date line for it. range takes a bounds object, e.g. {"range":["frontmatter.estimate",{"gte":5,"lte":120}]} or {"range":["frontmatter.realStartTime",{"gte":"2026-07-27","lt":"2026-08-02"}]} (any of gte/gt/lte/lt; bounds must be all numbers or all ISO date strings). The bound type picks which indexed values are scanned: number bounds scan number values, ISO date string bounds scan maybe_date values, so querying a numeric field with date bounds (or the reverse) returns an empty result instead of an error — check the field's kind with meta get first. Write a full YYYY-MM-DD; partial bounds such as 2026-07 are rejected. A date-only bound means midnight UTC, so for a whole day or month use an exclusive upper bound such as {"gte":"2026-07-29","lt":"2026-07-30"} rather than lte on the same day, which would drop that day's later timestamps. Default output is paths; use --format json for metadata details and cursors. Combine multiple predicates outside meta with shell tools over path output. There is no not/neq: to find where a field is NOT a value, first run exists <field> to list every file that has the field, then remove the eq <field> <value> matches (e.g. comm -23 or grep -vxF) — the eq matches are only a subset, so never infer the complement from an eq result alone. Use meta get <file> to inspect one file's indexed metadata. If field names are unclear, read nearby README.md files because folders may document frontmatter conventions.
			For search --path and meta search --path, the same app-root path rule applies: pass ${currentWorkspacePath}/folder or relative folder, never raw /folder.
			When a content-search request already names a folder, do not run ls first to verify that folder; run search --path <folder> <content terms> directly and let search report missing or invalid scopes.
			For recursive grep requests over an app folder, the first Bash command should be search --path <folder> <content terms>; do not run ls, native rg, or multi-file grep first.
			When listing the current directory, prefer ls --limit N over ls --limit N <current-cwd>. Do not restate the current cwd as a path argument just for certainty.
			Use ls [-1aApFdlrRt] [--limit N] [--cursor CURSOR] [PATH ...] for app listings. Bare ls --limit N lists the current directory. --cursor continues one listing target only; when asked to continue, run the printed Next page command as the next Bash call and do not invent --next-page. Listings are paginated in small pages; raising --limit past its cap (20 for ls/find) returns no more items — page through with the printed Next page command instead. ls -t (newest first) and ls -rt (oldest first) without PATH list the whole workspace ordered by update time; with PATH they list that directory's immediate children by update time. For recent immediate children after cd into a folder, use ls -t --limit N .; bare ls -t is still workspace-wide. ls -Rt PATH is unsupported.
			ls -R lists a paginated subtree as full app shell paths; when the user asks for tree-shaped output, use tree, not ls -R. ls -d lists the target entry itself and wins over -R; ls -l uses app metadata, not POSIX permissions, owners, groups, inodes, blocks, symlinks, or real sizes; stat reports the same app metadata, so its Access/owner/group fields are placeholders, not real POSIX values. ls -l does not report file size; stat size is the current user's pending proposal content size when present, otherwise the committed asset size, so stat matches what cat/head/tail/wc serve. Unsupported sort/filter flags still fail.
			Use find -name QUERY or find --path-query QUERY only for indexed app-file path/name word search; find -name is case-insensitive like -iname. Prefer --path-query QUERY for natural "path/name contains QUERY" requests; pass a plain token such as readme, not *readme*. For regex path requests against app files, say regex is unsupported and use token search when a plain token is obvious; do not summarize successful --path-query output as native glob/regex syntax. Use find <dir> -maxdepth 1 -name QUERY for indexed immediate-child app-file path search under one directory. Use find <path> --extension md -type f for exact indexed extension search; simple find -name '*.md' and find <dir>/*.md are accepted as extension-search recovery, not general glob support. Use find <path> --limit N [--cursor CURSOR] for subtree pages, and find --prefix <prefix> --limit N [--cursor CURSOR] for a folder-boundary subtree scan that does not require the prefix to resolve to an existing folder first; sibling-prefix paths such as /docs-archive are excluded from /docs. find searches app paths/names only, not file content. When asked for app files under a folder, include -type f; when asked for folders, include -type d. find -maxdepth N and find -mindepth N filter non-search app subtree results by depth. find -type f and find -type d restrict app results to files or folders. General glob/regex patterns and GNU find extensions such as -printf, -mtime, -newer, -exec, and -ok are not supported for app paths; omit them there. Native find syntax can be used for /tmp paths.
			Use search [--limit N] [--cursor CURSOR] <content terms...> for full-text content search across Markdown/text content. Pass one distinctive word or a few plain terms that should appear in the document body; the text index splits on whitespace/punctuation, ignores case, relevance-ranks matches, and prefix-matches the final term. It overlays the current user's pending unstaged file proposals before returning results. It is implemented with db full-text search, but it is not regex, glob, path/name search, or exact grep. For requests like "where does X appear" or "which files mention X", run search first; do not substitute find, which only searches paths/names. For recursive grep, grep -R, or rg wording over an app folder, do not try native rg or multi-file grep first; run search --path <folder> <content terms> directly. Scope to one folder with search --path <folder> <content terms...> when useful, but broad folder scopes with common terms can be heavier. Raising --limit past 100 has no effect; page with the printed Next page command. If cwd is inside the app tree, bare search scopes to that cwd; pass a folder via --path, not as a positional operand, and do not use search as a pipeline filter.
			Use exact app paths with cat [-n] [--] [FILE...], head, tail, wc, and stat; these readers fetch at most 10 app files per command — to READ specific known files, cat them in batches of 10 or fewer across multiple commands; to FIND which files mention something, use search (it returns matching snippets, not whole files). The 10-file cap is a per-command batch limit, not a total ceiling. cat unreadable-file advisories are stderr, not file content, so do not parse them as content. Large files are not read inline: a single cat shows a bounded first page (with a footer telling you how to page on), and a multi-file cat refuses when any file is too large to inline. Read a large file in bounded pages with head -n N (first lines; prints the next sed -n page command to continue), sed -n 'A,Bp' (any line range), or tail -n N (last lines) — up to ${files_READ_RANGE_MAX_LINES} lines per read; wc reports line/word/byte/character counts (use wc -m for characters) so you know its size first (line/word/character counts are lower bounds for files beyond the scan window); wc accepts multiple files (per-file counts plus a total) and does not refuse a large member. Use search to find content across files. Pipelines with sed/awk/sort/uniq/cut/grep/head process already emitted text, but direct app-aware grep/head path operands are preferred for app files.
			Uploaded source files do not alias to generated Markdown outputs. If an unreadable-source advisory suggests generated output paths such as <source>.pdf.md, read the exact generated output path when the user wants converted text; do not expect the original source path to auto-read that sibling.
			To search content across files use search (or search --path <folder> for one folder); to find lines in a SINGLE file use grep [-n] [-i] [-F] PATTERN <file> over the file's stored text chunks. Normal single-file grep uses regex matching; -F/--fixed-strings uses literal substring matching; -n prints lineNumber:line, and without -n it prints raw matching lines; also -c count, -l list-if-matched, -v invert, and -A/-B/-C N context. For rendered plain-text chunk scans, use textgrep [-i] [-F] [-v] [-c] [-l] PATTERN <file> for one app file (regex by default; -F/--fixed-strings uses literal substring matching; -v inverts; -c counts; -l prints the path if matched), or textgrep -R PATTERN <folder> for a recursive folder scan via indexed full-text search (not exact recursive regex/fixed-string grep). Single-file textgrep has no line numbers or context flags; use grep for -n or -A/-B/-C context. Simple grep -R PATTERN <app-folder> is recovered through indexed full-text search, but complex or multi-file grep forms are not exact recursive grep; prefer search --path. Use tree [PATH] [--limit N] [--cursor CURSOR] for paginated app tree shape; unsupported native tree flags fail for app paths.
			Keep commands simple: avoid strict-mode boilerplate such as set -euo pipefail because pipefail is unsupported, comments in command strings, and process substitution. For multi-command inspection or eval checks, do not use set -e or hide stderr with 2>/dev/null; later commands and visible stderr should still be observed. Only summarize actual Bash stdout/stderr; the blank line between the shell prompt and output is transcript formatting, not file content. If stdout is empty or a command failed, say that instead of inferring likely filesystem contents. Do not work around app read-only write or delete requests by copying app files to /tmp unless the user asked for a scratch copy.
			App file tree mkdir is available only when this tool is configured for Agent mode; /tmp scratch does not create app file tree folders.
			In Agent mode, shell writes under ${currentWorkspacePath} create pending proposals the user reviews in Files, exactly like edit_file: create or overwrite a file with a quoted heredoc (cat > '<path>' <<'EOF' ... EOF) or a redirect, append with >>, tee writes each app target as a proposal, and touch on a new path creates an empty-file proposal (touch on an existing app file changes nothing). Writable file types: Markdown (.md) keeps rich text and serves back its rendered Markdown text, while these plain text extensions store bytes exactly as written: ${ai_chat_PLAIN_TEXT_EXTENSIONS_LIST}. An extensionless new file name becomes <name>.md, any other extension is refused with the supported list, and copies or renames cannot cross between Markdown and plain text (cp notes.md data.json is refused; cp data.json data.yaml is fine). Your own reads (bash and the file tools) see your pending proposals as if applied, while other users and the Files UI see the committed tree until the user accepts (a brand-new file appears to everyone right away as an empty placeholder). In Ask mode app files are read-only. rm <app-path> proposes a pending delete: accepting archives the file, and rm -r <app-folder> archives the folder with everything inside. Your own reads see a pending-deleted path as gone; rm on your own not-yet-accepted new file usually removes it immediately (stdout prints removed '<path>'; when it cannot be removed safely it becomes a normal pending delete). ln is not available for app files. mv <app-path> <app-path> proposes a pending move/rename (one source only); accepting a move onto an occupied path replaces that file. Plain mv never overwrites an existing destination; mv -f <app-file> <existing-app-file> proposes a replace: the destination file keeps its identity and gets the source's content as a pending content replacement, and accepting saves that as a new version of the destination and archives the source file (mv -f replaces files only; a plain folder move can replace an empty folder, and folders never replace files or the reverse). cp <app-file> <app-path> proposes a pending copy (one source only): a new destination file appears immediately with the copied content pending review, your reads at the destination show that pending content, accepting publishes it, and discarding removes the destination file. When the cp destination file already exists, the copy becomes a pending content replacement on that file, and discarding keeps the destination file with its committed content. Use cp -n or cp --no-clobber to leave an existing final destination unchanged without creating a replacement proposal. cp <app-file> /tmp/<name> stays an immediate durable per-thread scratch copy. Targeted edits to existing text files belong in edit_file with app paths such as /docs/readme.md or /data/config.json; the edit_file description states how to convert a bash path to an app path. If a user asks to delete a file, run rm on it; the delete still waits for their accept in Files.`,
		inputSchema: z.object({
			command: z
				.string()
				.min(1)
				.max(20_000)
				.describe(
					`Shell command to run. Omit PATH to inspect the current app directory; use ${currentWorkspacePath} only when cwd is outside the app tree or when targeting that absolute path intentionally.`,
				),
		}),
		execute: async (args) => {
			const threadId = ctxData.getThreadId();
			if (!threadId) {
				throw new Error("Cannot run bash before the chat thread has been created.");
			}

			return await ctx.runAction(internal.bash.run, {
				organizationId: ctxData.organizationId,
				workspaceId: ctxData.workspaceId,
				threadId,
				userId: ctxData.userId,
				command: args.command,
				organizationName: ctxData.organizationName,
				workspaceName: ctxData.workspaceName,
				allowDbFilesMkdir: options.allowDbFilesMkdir,
			});
		},
	});
}

type ai_chat_tool_create_bash_Tool = ReturnType<typeof ai_chat_tool_create_bash>;
export type ai_chat_tool_create_bash_ToolInput = InferToolInput<ai_chat_tool_create_bash_Tool>;
export type ai_chat_tool_create_bash_ToolOutput = InferToolOutput<ai_chat_tool_create_bash_Tool>;
// #endregion bash

// Tools that mutate file content. Ask mode also disables bash app-file-tree mkdir and writes
// through the bash tool options because file/folder creation is intentionally a shell workflow.
export const ai_chat_WRITE_TOOL_NAMES = ["edit_file"] as const;
export type ai_chat_WriteToolName = (typeof ai_chat_WRITE_TOOL_NAMES)[number];

// #region edit file
/**
 * Inspired by `opencode/packages/opencode/src/tool/edit.ts`
 *
 * Tool for proposing a search-and-replace edit on a file (no direct apply).
 * It mirrors OpenCode's edit semantics (unique match vs. replaceAll), operates on files files,
 * and stores a pending update for human-in-the-loop review.
 */
export function ai_chat_tool_create_edit_file(
	ctx: ActionCtx,
	ctxData: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		getThreadId: () => Id<"ai_chat_threads"> | null;
	},
) {
	return tool({
		description: dedent`\
			Edits an existing file by replacing text and returns a preview diff.

			Usage:
			- The path must refer to an existing editable text file (absolute, starting with "/"): Markdown (.md), or a plain text file with one of these extensions: ${ai_chat_PLAIN_TEXT_EXTENSIONS_LIST}. Any other file type is refused.
			- By default, replaces a single unique occurrence of oldString; fails if not found or ambiguous.
			- Set replaceAll=true to replace every occurrence.
			- If copying from numbered output such as cat -n, do NOT include the line-number prefix.
			- If copying a path from bash, remove the /home/cloud-usr/w/<organization>/<workspace> current workspace path prefix before passing it here.
			- Preserve the full remaining suffix after that prefix; /home/cloud-usr/w/personal/home/folder/README.md becomes /folder/README.md, never /README.md.
			- A read-only refusal is terminal for this edit. Do not retry the path with bash redirects, tee, cp, mv, or another write tool; it cannot change until the user makes it writable.
			- For a .md file the text must be valid GitHub Flavored Markdown; preserve valid Markdown structure (headings, code fences, lists). For any other text file, match the file's own format exactly (for example valid JSON in a .json file) and do not reformat the rest of the file.
			- This tool does not apply changes directly; it saves a pending update for human review.`,

		inputSchema: z.object({
			path: z
				.string()
				.describe('Absolute path to the file (must start with "/"): a .md file or a supported plain text file.'),
			oldString: z.string().describe("The exact text to replace"),
			newString: z.string().describe("The replacement text"),
			replaceAll: z.boolean().optional().default(false),
			pendingUpdateId: z
				.string()
				.optional()
				.describe("Optional pending update id returned by a prior file read or edit result"),
		}),

		execute: async (args) => {
			const normalizedPath = server_path_normalize(args.path);
			const pendingUpdateId = args.pendingUpdateId as Id<"files_pending_updates"> | undefined;
			if (!normalizedPath.startsWith("/") || normalizedPath === "/") {
				throw new Error(`Invalid path: ${normalizedPath}. Path must be absolute and not root.`);
			}
			if (bash_is_path_under(bash_EXTERNAL_MOUNTS_ROOT, normalizedPath)) {
				throw new Error(
					`Invalid path: ${normalizedPath}. The ${bash_EXTERNAL_MOUNTS_ROOT} tree is a read-only mount of an external source and cannot be edited.`,
				);
			}
			if (bash_is_path_under(bash_PLUGINS_MOUNT_ROOT, normalizedPath)) {
				throw new Error(
					`Invalid path: ${normalizedPath}. The ${bash_PLUGINS_MOUNT_ROOT} tree is a read-only mount of installed plugin sources and cannot be edited.`,
				);
			}
			// Cross-class refusal that names the class, not the path: without it a .png or .exe
			// path falls through to the read below and answers "File not found", and the model
			// loops on a wrong retry hint instead of learning the rule.
			const editedFileName = path_name_of(normalizedPath);
			if (files_get_editable_text_content_type(editedFileName) === null) {
				throw new Error(`Cannot edit ${normalizedPath}: ${files_editable_text_refusal_message(editedFileName)}`);
			}

			const currentFileContent = await ctx.runAction(
				internal.files_nodes_content.get_file_last_available_text_content_by_path,
				{
					organizationId: ctxData.organizationId,
					workspaceId: ctxData.workspaceId,
					userId: ctxData.userId,
					path: normalizedPath,
					pendingUpdateId,
					overlayUserId: ctxData.userId,
				},
			);
			if (!currentFileContent) {
				throw new Error(`File not found: ${normalizedPath}`);
			}

			const oldString = files_normalize_lf_newlines(args.oldString);
			const newString = files_normalize_lf_newlines(args.newString);

			const {
				content: modifiedTextRaw,
				matches,
				matcher,
			} = replace_once_or_all(currentFileContent.content, oldString, newString, {
				replaceAll: args.replaceAll,
				mode: "auto",
			});
			const modifiedText = files_normalize_ai_edit_content(modifiedTextRaw, currentFileContent.content);
			const diff = createPatch(normalizedPath, currentFileContent.content, modifiedText);

			const nodeId = currentFileContent.nodeId;

			const upserted = await files_agent_upsert_file_pending_update(ctx, {
				organizationId: ctxData.organizationId,
				workspaceId: ctxData.workspaceId,
				userId: ctxData.userId,
				nodeId,
				pendingUpdateId: currentFileContent.pendingUpdateId ?? undefined,
				unstagedText: modifiedText,
				threadId: ctxData.getThreadId() ?? undefined,
			});
			// The node can be archived or deleted between the read above and this upsert;
			// reporting success would let the model believe the proposal exists.
			if (upserted._nay) {
				if (upserted._nay.name === "read_only") {
					throw new Error(
						`Cannot edit ${normalizedPath}: ${upserted._nay.message} Do not retry this path with another write tool.`,
						{ cause: upserted._nay },
					);
				}
				throw new Error(
					`Cannot edit ${normalizedPath}: the file is gone or archived, so the proposal was not recorded. Re-check the path and try again.`,
					{ cause: upserted._nay },
				);
			}
			const nextPendingUpdate = await ctx.runQuery(internal.files_pending_updates.get_file_pending_update_internal, {
				organizationId: ctxData.organizationId,
				workspaceId: ctxData.workspaceId,
				userId: ctxData.userId,
				nodeId,
				pendingUpdateId: currentFileContent.pendingUpdateId ?? undefined,
			});

			return {
				title: normalizedPath,
				metadata: {
					nodeId: currentFileContent.displayNodeId,
					contentNodeId: nodeId,
					pendingUpdateId: nextPendingUpdate?._id ?? null,
					path: normalizedPath,
					matches,
					matcher,
					diff,
					modifiedContent: modifiedText,
				},
				output: args.replaceAll ? `Replaced ${matches} occurrences` : "Replaced 1 occurrence",
			};
		},
	});
}

type ai_chat_tool_create_edit_file_Tool = ReturnType<typeof ai_chat_tool_create_edit_file>;
export type ai_chat_tool_create_edit_file_ToolInput = InferToolInput<ai_chat_tool_create_edit_file_Tool>;
export type ai_chat_tool_create_edit_file_ToolOutput = InferToolOutput<ai_chat_tool_create_edit_file_Tool>;
// #endregion edit file

// #region web search
type ai_chat_tool_web_search_ExaItem = {
	title: string | null;
	url: string | null;
	highlights: string[];
};

type ai_chat_tool_web_search_ContentsOptions = {
	highlights: {
		maxCharacters: number;
	};
};

function ai_chat_tool_web_search_map_sdk_results(result: SearchResponse<ai_chat_tool_web_search_ContentsOptions>): {
	requestId: string | undefined;
	results: ai_chat_tool_web_search_ExaItem[];
} {
	const results: ai_chat_tool_web_search_ExaItem[] = [];

	for (const entry of result.results) {
		const highlights = Array.isArray(entry.highlights)
			? entry.highlights.filter((h): h is string => typeof h === "string")
			: [];

		results.push({
			title: entry.title,
			url: entry.url,
			highlights,
		});
	}

	return { requestId: result.requestId, results };
}

function ai_chat_tool_web_search_format_output(results: ai_chat_tool_web_search_ExaItem[]) {
	const blocks: string[] = [];

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const headline = r.title?.trim() || "(untitled)";
		const link = r.url?.trim() || "";

		blocks.push(`${i + 1}. ${headline}`);

		if (link) {
			blocks.push(`   ${link}`);
		}

		for (const h of r.highlights.slice(0, 3)) {
			const snippet = h.replace(/\s+/g, " ").trim().slice(0, 500);
			if (snippet) {
				blocks.push(`   — ${snippet}`);
			}
		}

		blocks.push("");
	}

	return blocks.join("\n").replace(/\n+$/u, "");
}

/**
 * Public web search via Exa (`exa-js`).
 *
 * Keep `EXA_API_KEY` on the server only; never expose it to the browser.
 */
export function ai_chat_tool_create_web_search() {
	return tool({
		description: dedent`\
			Search the public web for current facts, documentation, release notes, news, and other information outside this organization. \
			Returns compact highlight snippets plus titles and URLs — summarize these in your own words instead of dumping the raw tool output. \
			Prefer organization file tools first when the answer should come from the user's docs.`,

		inputSchema: z.object({
			query: z.string().describe("Natural language search query"),
			numResults: z.number().int().gte(1).lte(20).describe("Number of results to return (1-20)").optional(),
			includeDomains: z.array(z.string()).describe("Only include results from these domains").optional(),
			excludeDomains: z.array(z.string()).describe("Exclude results from these domains").optional(),
		}),

		execute: async (args) => {
			const apiKey = process.env.EXA_API_KEY?.trim();
			if (!apiKey) {
				throw new Error("Web search is unavailable.");
			}

			const numResults = Math.min(20, Math.max(1, args.numResults ?? 10));

			const searchOptions: RegularSearchOptions & { contents: ai_chat_tool_web_search_ContentsOptions } = {
				type: "fast",
				numResults,
				contents: {
					highlights: {
						maxCharacters: 4000,
					},
				},
			};

			if (args.includeDomains?.length) {
				searchOptions.includeDomains = args.includeDomains;
			}

			if (args.excludeDomains?.length) {
				searchOptions.excludeDomains = args.excludeDomains;
			}

			const exa = new Exa(apiKey);

			let sdkResult: SearchResponse<ai_chat_tool_web_search_ContentsOptions>;
			try {
				sdkResult = await exa.search(args.query, searchOptions);
			} catch (error) {
				if (error instanceof ExaError) {
					throw new Error(`Web search request failed: ${error.message}`);
				}

				throw error;
			}

			const { requestId, results } = ai_chat_tool_web_search_map_sdk_results(sdkResult);
			const output = ai_chat_tool_web_search_format_output(results);

			return {
				title: "Web search",
				metadata: {
					query: args.query,
					resultCount: results.length,
					requestId: requestId ?? null,
				},
				output:
					output.length > 0
						? output
						: "No web results returned for this query. Try different keywords or broader phrasing.",
			};
		},
	});
}

type ai_chat_tool_create_web_search_Tool = ReturnType<typeof ai_chat_tool_create_web_search>;
export type ai_chat_tool_create_web_search_ToolInput = InferToolInput<ai_chat_tool_create_web_search_Tool>;
export type ai_chat_tool_create_web_search_ToolOutput = InferToolOutput<ai_chat_tool_create_web_search_Tool>;
// #endregion web search

// #region execute code
const ai_chat_tool_execute_code_CODE_MAX_BYTES = 20_000;
const ai_chat_tool_execute_code_INPUT_MAX_BYTES = 32_000;
const ai_chat_tool_execute_code_TEXT_ENCODER = new TextEncoder();

type ai_chat_tool_execute_code_RunnerResult = {
	executionId: string;
	status: "succeeded" | "errored" | "timed_out";
	codeHash: string;
	elapsedMs: number;
	result: unknown;
	resultTruncated: boolean;
	logs: string[];
	logsTruncated: boolean;
	error: { name: string; message: string } | null;
};

const ai_chat_tool_execute_code_runner_result_schema = z.object({
	executionId: z.string(),
	status: z.enum(["succeeded", "errored", "timed_out"]),
	codeHash: z.string(),
	elapsedMs: z.number(),
	result: z.unknown(),
	resultTruncated: z.boolean(),
	logs: z.array(z.string()),
	logsTruncated: z.boolean(),
	error: z.object({ name: z.string(), message: z.string() }).nullable(),
});

const ai_chat_tool_execute_code_runner_error_schema = z.object({
	error: z.object({ message: z.string().optional() }).optional(),
});

function ai_chat_tool_execute_code_app_origin() {
	const origin = process.env.VITE_CONVEX_HTTP_URL?.trim() || process.env.CONVEX_SITE_URL?.trim();
	if (!origin) {
		throw new Error("Code execution app access is unavailable.");
	}

	try {
		const url = new URL(origin);
		if (url.protocol !== "https:") {
			throw new Error("Expected HTTPS app origin.");
		}
		return url.origin;
	} catch {
		throw new Error("Code execution app access is unavailable.");
	}
}

function ai_chat_tool_execute_code_format_output(result: ai_chat_tool_execute_code_RunnerResult): string {
	const blocks: string[] = [];

	if (result.status === "succeeded") {
		const resultText = result.resultTruncated
			? "(result omitted: it exceeded the size limit)"
			: (JSON.stringify(result.result) ?? "null");
		blocks.push(`Result: ${resultText}`);
	} else if (result.status === "timed_out") {
		blocks.push("Execution timed out before completing.");
	} else {
		const name = result.error?.name ?? "Error";
		const message = result.error?.message ?? "Unknown error";
		blocks.push(`Error: ${name}: ${message}`);
	}

	if (result.logs.length > 0) {
		blocks.push("");
		blocks.push("Logs:");
		for (const line of result.logs) {
			blocks.push(`  ${line}`);
		}
		if (result.logsTruncated) {
			blocks.push("  … (logs truncated)");
		}
	}

	return blocks.join("\n");
}

/**
 * Run a short, untrusted JavaScript snippet in the isolated Dynamic Worker
 * sandbox (`bonobo-senate-code-execution-runner`) and return its value plus logs.
 *
 * Keep `CODE_EXECUTION_RUNNER_URL` / `CODE_EXECUTION_RUNNER_SECRET` on the server
 * only. The runner receives a short-lived public API grant token for
 * gateway-side file API authorization; the snippet sees only the app origin.
 */
export function ai_chat_tool_create_execute_code(
	ctx: ActionCtx,
	ctxData: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		organizationName: string;
		workspaceName: string;
		userId: Id<"users">;
		getThreadId?: () => Id<"ai_chat_threads"> | null;
	},
) {
	return tool({
		description: dedent`\
			Run a short snippet of JavaScript in a secure sandbox and get back the returned value plus console output. \
			Use this for precise calculations, JSON transformation, parsing, public HTTPS fetches, and algorithmic logic that is error-prone to do by hand. \
			The snippet is the body of an async function: use \`return\` to produce a JSON-serializable result, and read the optional \`input\` argument as the variable \`input\`. \
			Modern JavaScript, JSON, and \`fetch\` are available. The snippet has \`process.env.T3_APP_ORIGIN\`; the runner gateway adds file API authorization. \
			To read app files, fetch \`${"${process.env.T3_APP_ORIGIN}"}/api/v1/files/list\` for paths, then \`${"${process.env.T3_APP_ORIGIN}"}/api/v1/files/read-many\` for contents; follow \`cursor\` until \`isDone\`, check \`errors\` and \`truncated\`, and use \`/api/v1/files/read\` only for one known file. \
			Do not pass app file paths or contents through \`input\`; keep \`input\` for ordinary JSON parameters, run file API fetches inside the snippet, and return a compact aggregate instead of raw file contents. \
			Keep snippets small and deterministic: execution is time-limited and both the result and the logs are size-limited.`,

		inputSchema: z
			.object({
				code: z
					.string()
					.min(1)
					.max(ai_chat_tool_execute_code_CODE_MAX_BYTES)
					.describe(
						"JavaScript to run as the body of an async function. Use `return` to produce a JSON-serializable result.",
					),
				input: z
					.unknown()
					.describe("Optional JSON-serializable value passed to the snippet as the `input` variable.")
					.optional(),
			})
			.strict(),

		execute: async (args) => {
			const baseUrl = process.env.CODE_EXECUTION_RUNNER_URL?.trim();
			const secret = process.env.CODE_EXECUTION_RUNNER_SECRET?.trim();
			if (!baseUrl || !secret) {
				throw new Error("Code execution is unavailable.");
			}

			// Reject oversized tool payloads before the runner request; the runner
			// still enforces its own request limits.
			if (ai_chat_tool_execute_code_TEXT_ENCODER.encode(args.code).length > ai_chat_tool_execute_code_CODE_MAX_BYTES) {
				throw new Error("`code` is too large.");
			}

			let inputJson: string;
			try {
				inputJson = args.input === undefined ? "null" : (JSON.stringify(args.input) ?? "null");
			} catch {
				throw new Error("`input` must be JSON-serializable.");
			}
			if (ai_chat_tool_execute_code_TEXT_ENCODER.encode(inputJson).length > ai_chat_tool_execute_code_INPUT_MAX_BYTES) {
				throw new Error("`input` is too large.");
			}

			const url = `${baseUrl.replace(/\/$/u, "")}/internal/execute-code`;
			const appOrigin = ai_chat_tool_execute_code_app_origin();
			const executionId = crypto.randomUUID();
			const publicApiGrantToken = crypto_random_hex(32);
			await ctx.runMutation(internal.public_api.create_grant, {
				organizationId: ctxData.organizationId,
				workspaceId: ctxData.workspaceId,
				userId: ctxData.userId,
				threadId: ctxData.getThreadId?.() ?? null,
				principalKey: executionId,
				tokenHash: await crypto_sha256_hex(publicApiGrantToken),
				scopes: ["files:list", "files:read"] satisfies public_api_Scope[],
				pathPrefix: null,
				now: Date.now(),
			});

			let response: Response;
			try {
				response = await fetch(url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${secret}`,
					},
					body: JSON.stringify({
						executionId,
						code: args.code,
						input: args.input ?? null,
						network: { mode: "public_http" },
						app: {
							origin: appOrigin,
							token: publicApiGrantToken,
						},
					}),
				});
			} catch (error) {
				throw new Error(`Code execution request failed: ${error instanceof Error ? error.message : String(error)}`);
			}

			if (!response.ok) {
				let message = `Code execution request failed (${response.status}).`;
				try {
					const body = ai_chat_tool_execute_code_runner_error_schema.parse(await response.json());
					if (body.error?.message) {
						message = body.error.message;
					}
				} catch {
					// Keep the status-code fallback message.
				}
				throw new Error(message);
			}

			let result: ai_chat_tool_execute_code_RunnerResult;
			try {
				result = ai_chat_tool_execute_code_runner_result_schema.parse(await response.json());
			} catch {
				throw new Error("Code execution returned an invalid response.");
			}
			const output = ai_chat_tool_execute_code_format_output(result);

			return {
				title: "Execute code",
				metadata: {
					executionId: result.executionId,
					status: result.status,
					elapsedMs: result.elapsedMs,
					resultTruncated: result.resultTruncated,
					logsTruncated: result.logsTruncated,
				},
				output,
			};
		},
	});
}

type ai_chat_tool_create_execute_code_Tool = ReturnType<typeof ai_chat_tool_create_execute_code>;
export type ai_chat_tool_create_execute_code_ToolInput = InferToolInput<ai_chat_tool_create_execute_code_Tool>;
export type ai_chat_tool_create_execute_code_ToolOutput = InferToolOutput<ai_chat_tool_create_execute_code_Tool>;
// #endregion execute code
