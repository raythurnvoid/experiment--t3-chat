import { defineCommand } from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { files_nodes_get_by_path_Result } from "../convex/files_nodes.ts";
import type { files_metadata_get_by_path_Result, files_metadata_search_Result } from "../convex/files_metadata.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import type { files_metadata_SearchPlan } from "../shared/files-metadata.ts";
import {
	bash_app_file_node_path_to_current_project_path,
	bash_current_project_path_to_app_file_node_path,
	bash_cursor_id_create,
	bash_cursor_id_resolve,
	bash_parse_limit,
	bash_read_option_value,
	bash_resolve_path,
	bash_shell_arg_quote,
	type bash_WorkspaceFs,
} from "./bash-utils.ts";

const COMMAND_EXIT_FAILURE = 1;
const COMMAND_EXIT_USAGE = 2;
const FIELD_SEGMENT_REGEX = /^[A-Za-z0-9_-]+$/u;
const SUPPORTED_METADATA_KINDS = new Set(["frontmatter"]);

type MetaCommandSearchFormat = "paths" | "json";
type MetaCommandGetFormat = "text" | "json";

function is_record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parse_qualified_field(value: unknown) {
	if (typeof value !== "string") {
		return Result({ _nay: { message: "meta search fields must be strings." } });
	}
	const dotIndex = value.indexOf(".");
	if (dotIndex <= 0 || dotIndex === value.length - 1) {
		return Result({
			_nay: {
				message: "meta search fields must be qualified, for example frontmatter.from or system.createdAt.",
			},
		});
	}
	const kind = value.slice(0, dotIndex);
	if (!SUPPORTED_METADATA_KINDS.has(kind)) {
		return Result({
			_nay: {
				message: `Unsupported metadata kind "${kind}". Supported kinds: frontmatter.`,
			},
		});
	}
	const segments = value.slice(dotIndex + 1).split(".");
	if (segments.some((segment) => !FIELD_SEGMENT_REGEX.test(segment))) {
		return Result({
			_nay: {
				message: "meta search field segments may contain only letters, numbers, underscores, and hyphens.",
			},
		});
	}
	return Result({ _yay: value });
}

function parse_eq_value(value: unknown) {
	if (typeof value === "string" || typeof value === "boolean") {
		return Result({ _yay: value });
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return Result({ _yay: value });
	}
	return Result({
		_nay: {
			message: "eq supports string, number, and boolean values. Null, arrays, and objects are not searchable values.",
		},
	});
}

function parse_binary_args(value: unknown, operator: string) {
	if (!Array.isArray(value) || value.length !== 2) {
		return Result({ _nay: { message: `${operator} must be an array like ["frontmatter.field", value].` } });
	}
	const qualifiedField = parse_qualified_field(value[0]);
	if (qualifiedField._nay) {
		return qualifiedField;
	}
	return Result({ _yay: { qualifiedField: qualifiedField._yay, value: value[1] } });
}

function parse_range_bound(value: unknown, key: string) {
	if (value === undefined) {
		return Result({ _yay: undefined });
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return Result({ _yay: value });
	}
	return Result({ _nay: { message: `range.${key} supports number values only.` } });
}

function parse_search_where_json(whereJson: string) {
	let parsed: unknown;
	try {
		parsed = JSON.parse(whereJson);
	} catch {
		return Result({ _nay: { message: "meta search --where must be valid JSON." } });
	}
	if (!is_record(parsed)) {
		return Result({ _nay: { message: "meta search --where must be a JSON object." } });
	}

	if ("and" in parsed || "or" in parsed) {
		return Result({
			_nay: {
				message:
					"meta search supports one indexed field predicate per command. Run multiple meta search commands and combine path output in the shell for AND, OR, or multi-value matching.",
			},
		});
	}
	if ("not" in parsed || "neq" in parsed || "missing" in parsed || "without" in parsed) {
		return Result({
			_nay: { message: "meta search only supports positive predicates: exists, eq, prefix, and range." },
		});
	}

	// Exactly one predicate key is allowed. Extra keys (e.g. a second `eq`, or a stray `eq2`)
	// must be rejected rather than silently dropped, so a caller cannot believe a combined
	// AND query ran when only the first matched key was applied.
	if (Object.keys(parsed).length > 1) {
		return Result({
			_nay: {
				message:
					"meta search supports one indexed field predicate per command. Run multiple meta search commands and combine path output in the shell for AND, OR, or multi-value matching.",
			},
		});
	}

	if ("exists" in parsed) {
		const qualifiedField = parse_qualified_field(parsed.exists);
		if (qualifiedField._nay) {
			return qualifiedField;
		}
		return Result({ _yay: { op: "exists", qualifiedField: qualifiedField._yay } satisfies files_metadata_SearchPlan });
	}

	if ("eq" in parsed) {
		const args = parse_binary_args(parsed.eq, "eq");
		if (args._nay) {
			return args;
		}
		const value = parse_eq_value(args._yay.value);
		if (value._nay) {
			return value;
		}
		return Result({
			_yay: {
				op: "eq",
				qualifiedField: args._yay.qualifiedField,
				value: value._yay,
			} satisfies files_metadata_SearchPlan,
		});
	}

	if ("prefix" in parsed) {
		const args = parse_binary_args(parsed.prefix, "prefix");
		if (args._nay) {
			return args;
		}
		if (typeof args._yay.value !== "string") {
			return Result({ _nay: { message: "prefix supports string values only." } });
		}
		return Result({
			_yay: {
				op: "prefix",
				qualifiedField: args._yay.qualifiedField,
				value: args._yay.value,
			} satisfies files_metadata_SearchPlan,
		});
	}

	if ("range" in parsed) {
		// range's second element is a bounds OBJECT, not a scalar — agents reliably send
		// [field, min, max] or [field, n] and then loop on the generic array message. Surface the
		// exact shape with an example for both structural failures so the next attempt is correct.
		const rangeShapeMessage =
			'range takes a field and a bounds object, e.g. {"range":["frontmatter.estimate",{"gte":5,"lte":120}]} (use any of gte, gt, lte, lt).';
		const args = parse_binary_args(parsed.range, "range");
		if (args._nay) {
			return Result({ _nay: { message: rangeShapeMessage } });
		}
		if (!is_record(args._yay.value)) {
			return Result({ _nay: { message: rangeShapeMessage } });
		}
		const gte = parse_range_bound(args._yay.value.gte, "gte");
		const gt = parse_range_bound(args._yay.value.gt, "gt");
		const lte = parse_range_bound(args._yay.value.lte, "lte");
		const lt = parse_range_bound(args._yay.value.lt, "lt");
		for (const bound of [gte, gt, lte, lt]) {
			if (bound._nay) {
				return bound;
			}
		}
		if (gte._yay === undefined && gt._yay === undefined && lte._yay === undefined && lt._yay === undefined) {
			return Result({ _nay: { message: "range requires at least one numeric bound: gte, gt, lte, or lt." } });
		}
		return Result({
			_yay: {
				op: "range",
				qualifiedField: args._yay.qualifiedField,
				...(gte._yay === undefined ? {} : { gte: gte._yay }),
				...(gt._yay === undefined ? {} : { gt: gt._yay }),
				...(lte._yay === undefined ? {} : { lte: lte._yay }),
				...(lt._yay === undefined ? {} : { lt: lt._yay }),
			} satisfies files_metadata_SearchPlan,
		});
	}

	return Result({
		_nay: { message: "meta search only supports positive predicates: exists, eq, prefix, and range." },
	});
}

function parse_search_args(args: string[], options: { currentProjectPath: string; cwd: string }) {
	let limitValue: string | undefined;
	let cursor: string | null = null;
	let pathValue: string | undefined;
	let whereJson: string | undefined;
	let format: MetaCommandSearchFormat = "paths";

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--limit") {
			const value = bash_read_option_value("meta search", args, index, "--limit");
			if (value._nay) return value;
			limitValue = value._yay.value;
			index++;
			continue;
		}
		if (arg.startsWith("--limit=")) {
			limitValue = arg.slice("--limit=".length);
			continue;
		}
		if (arg === "--cursor") {
			const value = bash_read_option_value("meta search", args, index, "--cursor");
			if (value._nay) return value;
			cursor = value._yay.value.trim();
			index++;
			continue;
		}
		if (arg.startsWith("--cursor=")) {
			cursor = arg.slice("--cursor=".length).trim();
			continue;
		}
		if (arg === "--path") {
			const value = bash_read_option_value("meta search", args, index, "--path");
			if (value._nay) return value;
			pathValue = value._yay.value.trim();
			index++;
			continue;
		}
		if (arg.startsWith("--path=")) {
			pathValue = arg.slice("--path=".length).trim();
			continue;
		}
		if (arg === "--where") {
			const value = bash_read_option_value("meta search", args, index, "--where");
			if (value._nay) return value;
			whereJson = value._yay.value;
			index++;
			continue;
		}
		if (arg.startsWith("--where=")) {
			whereJson = arg.slice("--where=".length);
			continue;
		}
		if (arg === "--format") {
			const value = bash_read_option_value("meta search", args, index, "--format");
			if (value._nay) return value;
			if (value._yay.value !== "paths" && value._yay.value !== "json") {
				return Result({ _nay: { message: "meta search: --format must be paths or json" } });
			}
			format = value._yay.value;
			index++;
			continue;
		}
		if (arg.startsWith("--format=")) {
			const value = arg.slice("--format=".length);
			if (value !== "paths" && value !== "json") {
				return Result({ _nay: { message: "meta search: --format must be paths or json" } });
			}
			format = value;
			continue;
		}
		return Result({ _nay: { message: `meta search: unsupported argument ${arg}` } });
	}

	if (whereJson == null || whereJson.trim() === "") {
		return Result({ _nay: { message: "meta search: missing --where JSON expression" } });
	}
	const plan = parse_search_where_json(whereJson);
	if (plan._nay) {
		return plan;
	}
	const limit = bash_parse_limit("meta search", limitValue, 20, 100);
	if (limit._nay) {
		return limit;
	}

	let path: string | undefined;
	if (pathValue != null) {
		if (pathValue === "") {
			return Result({ _nay: { message: "meta search: --path requires a non-empty folder path" } });
		}
		const appFileNodePath = bash_current_project_path_to_app_file_node_path(
			options.currentProjectPath,
			bash_resolve_path(options.cwd, pathValue),
		);
		if (appFileNodePath == null) {
			return Result({
				_nay: {
					message:
						`meta search: --path must be a folder under the app file tree: ${pathValue}\n` +
						`Use a path under ${options.currentProjectPath}.`,
				},
			});
		}
		path = appFileNodePath;
	}

	return Result({ _yay: { plan: plan._yay, whereJson, limit: limit._yay, cursor, path, format } });
}

function parse_get_args(args: string[], options: { currentProjectPath: string; cwd: string }) {
	let format: MetaCommandGetFormat = "text";
	let pathValue: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--format") {
			const value = bash_read_option_value("meta get", args, index, "--format");
			if (value._nay) return value;
			if (value._yay.value !== "text" && value._yay.value !== "json") {
				return Result({ _nay: { message: "meta get: --format must be text or json" } });
			}
			format = value._yay.value;
			index++;
			continue;
		}
		if (arg.startsWith("--format=")) {
			const value = arg.slice("--format=".length);
			if (value !== "text" && value !== "json") {
				return Result({ _nay: { message: "meta get: --format must be text or json" } });
			}
			format = value;
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") {
			return Result({ _nay: { message: `meta get: unsupported option ${arg}` } });
		}
		if (pathValue != null) {
			return Result({ _nay: { message: "meta get: expected exactly one file path" } });
		}
		pathValue = arg;
	}

	if (pathValue == null || pathValue === "") {
		return Result({ _nay: { message: "meta get: missing file path" } });
	}
	const path = bash_current_project_path_to_app_file_node_path(
		options.currentProjectPath,
		bash_resolve_path(options.cwd, pathValue),
	);
	if (path == null) {
		return Result({
			_nay: {
				message: `meta get: path must be under the app file tree: ${pathValue}\nUse a path under ${options.currentProjectPath}.`,
			},
		});
	}
	return Result({ _yay: { path, format } });
}

function build_search_continuation(args: {
	currentProjectPath: string;
	path: string | undefined;
	limit: number;
	cursor: string;
	whereJson: string;
	format: MetaCommandSearchFormat;
}) {
	const parts = ["Next page:", "meta", "search"];
	if (args.path != null) {
		parts.push(
			"--path",
			bash_shell_arg_quote(bash_app_file_node_path_to_current_project_path(args.currentProjectPath, args.path)),
		);
	}
	if (args.format !== "paths") {
		parts.push("--format", args.format);
	}
	parts.push(
		"--limit",
		String(args.limit),
		"--cursor",
		bash_shell_arg_quote(args.cursor),
		"--where",
		bash_shell_arg_quote(args.whereJson),
	);
	return parts.join(" ");
}

function search_result_value(result: files_metadata_search_Result["items"][number]) {
	switch (result.valueKind) {
		case "string":
			return result.stringValue;
		case "number":
			return result.numberValue;
		case "boolean":
			return result.booleanValue;
		case "none":
			return undefined;
	}
}

function get_value(value: NonNullable<files_metadata_get_by_path_Result>["values"][number]) {
	switch (value.valueKind) {
		case "string":
			return value.stringValue;
		case "number":
			return value.numberValue;
		case "boolean":
			return value.booleanValue;
	}
}

export function bash_meta_command_create(ctx: ActionCtx, workspaceFs: bash_WorkspaceFs, currentProjectPath: string) {
	return defineCommand("meta", async (args, commandCtx) => {
		const subcommand = args[0];
		if (subcommand !== "search" && subcommand !== "get") {
			return {
				stdout: "",
				stderr:
					"meta: expected subcommand search or get\n" +
					"Usage: meta search --where '<json>' [--format paths|json] [--path <folder>] [--limit N] [--cursor CURSOR]\n" +
					"Usage: meta get <file> [--format text|json]\n",
				exitCode: COMMAND_EXIT_USAGE,
			};
		}

		if (subcommand === "get") {
			const parsed = parse_get_args(args.slice(1), { currentProjectPath, cwd: commandCtx.cwd });
			if (parsed._nay) {
				return {
					stdout: "",
					stderr: `${parsed._nay.message}\nUsage: meta get <file> [--format text|json]\n`,
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
			const result = (await ctx.runQuery(internal.files_metadata.get_by_path, {
				workspaceId: workspaceFs.ctxData.workspaceId,
				projectId: workspaceFs.ctxData.projectId,
				userId: workspaceFs.ctxData.userId,
				path: parsed._yay.path,
			})) as files_metadata_get_by_path_Result;
			if (!result) {
				return {
					stdout: "",
					stderr: `meta get: file not found: ${bash_app_file_node_path_to_current_project_path(currentProjectPath, parsed._yay.path)}\n`,
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
			if (parsed._yay.format === "json") {
				return {
					stdout: `${JSON.stringify(
						{
							path: bash_app_file_node_path_to_current_project_path(currentProjectPath, result.path),
							nodeId: result.nodeId,
							sourceKind: result.sourceKind,
							fields: result.fields,
							values: result.values.map((value) => ({
								field: value.qualifiedField,
								valueKind: value.valueKind,
								value: get_value(value),
							})),
						},
						null,
						2,
					)}\n`,
					stderr: "",
					exitCode: 0,
				};
			}
			const lines = [`source: ${result.sourceKind}`];
			for (const field of result.fields) {
				lines.push(field);
			}
			for (const value of result.values) {
				lines.push(`${value.qualifiedField} = ${JSON.stringify(get_value(value))}`);
			}
			return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
		}

		const parsed = parse_search_args(args.slice(1), { currentProjectPath, cwd: commandCtx.cwd });
		if (parsed._nay) {
			return {
				stdout: "",
				stderr:
					`${parsed._nay.message}\n` +
					"Usage: meta search --where '<json>' [--format paths|json] [--path <folder>] [--limit N] [--cursor CURSOR]\n",
				exitCode: COMMAND_EXIT_USAGE,
			};
		}

		let cursor: string | null = null;
		if (parsed._yay.cursor != null) {
			const resolvedCursor = await bash_cursor_id_resolve(ctx, parsed._yay.cursor);
			if (resolvedCursor._nay) {
				return { stdout: "", stderr: `${resolvedCursor._nay.message}\n`, exitCode: COMMAND_EXIT_FAILURE };
			}
			cursor = resolvedCursor._yay;
		}

		if (parsed._yay.path != null && parsed._yay.path !== "/") {
			const scopedFolder = (await ctx.runQuery(internal.files_nodes.get_by_path, {
				workspaceId: workspaceFs.ctxData.workspaceId,
				projectId: workspaceFs.ctxData.projectId,
				path: parsed._yay.path,
			})) as files_nodes_get_by_path_Result;
			const scopedShellPath = bash_app_file_node_path_to_current_project_path(currentProjectPath, parsed._yay.path);
			if (!scopedFolder) {
				return {
					stdout: "",
					stderr: `meta search: --path folder does not exist: ${scopedShellPath}\n`,
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
			if (scopedFolder.kind !== "folder") {
				return {
					stdout: "",
					stderr: `meta search: --path must be a folder: ${scopedShellPath}\n`,
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
		}

		// Without --path, meta search follows cwd when it is inside currentProjectPath.
		const cwdAppFileNodePath = bash_current_project_path_to_app_file_node_path(currentProjectPath, commandCtx.cwd);
		const path =
			parsed._yay.path ?? (cwdAppFileNodePath != null && cwdAppFileNodePath !== "/" ? cwdAppFileNodePath : undefined);
		const result = (await ctx.runQuery(internal.files_metadata.search, {
			workspaceId: workspaceFs.ctxData.workspaceId,
			projectId: workspaceFs.ctxData.projectId,
			userId: workspaceFs.ctxData.userId,
			plan: parsed._yay.plan,
			numItems: parsed._yay.limit,
			cursor,
			pathPrefix: path,
		})) as files_metadata_search_Result;

		// A file can match through multiple metadata values; command output lists each path once.
		const dedupedItems = [...new Map(result.items.map((item) => [item.nodeId, item])).values()];
		const nextCursor = result.isDone ? null : await bash_cursor_id_create(ctx, result.continueCursor);
		if (parsed._yay.format === "json") {
			return {
				stdout: `${JSON.stringify(
					{
						results: dedupedItems.map((item) => ({
							path: bash_app_file_node_path_to_current_project_path(currentProjectPath, item.path),
							nodeId: item.nodeId,
							field: item.qualifiedField,
							valueKind: item.valueKind,
							matchedValue: search_result_value(item),
							metadataKind: item.metadataKind,
							sourceKind: item.sourceKind,
						})),
						nextCursor,
					},
					null,
					2,
				)}\n`,
				stderr: "",
				exitCode: 0,
			};
		}

		const stdout =
			dedupedItems.length === 0
				? ""
				: `${dedupedItems
						.map((item) => bash_app_file_node_path_to_current_project_path(currentProjectPath, item.path))
						.join("\n")}\n`;
		const stderr =
			nextCursor == null
				? ""
				: `${build_search_continuation({
						currentProjectPath,
						path,
						limit: parsed._yay.limit,
						cursor: nextCursor,
						whereJson: parsed._yay.whereJson,
						format: parsed._yay.format,
					})}\n`;
		return { stdout, stderr, exitCode: 0 };
	});
}
