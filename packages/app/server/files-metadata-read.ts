import { z } from "zod";
import { Result } from "common/errors-as-values-utils.ts";
import type { FunctionArgs } from "convex/server";
import { internal } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { files_metadata_FullReadSource } from "../convex/files_metadata.ts";
import type { files_nodes_get_file_last_available_text_content_by_path_Result } from "../convex/files_nodes_content.ts";
import {
	files_metadata_extract_entries,
	files_metadata_extract_frontmatter,
	type files_metadata_Value,
} from "../shared/files-metadata.ts";
import { files_search_query_field_path_is_valid } from "../shared/files-search-query.ts";
import { files_get_utf8_byte_size, files_MAX_TEXT_CONTENT_BYTES, type files_PendingTarget } from "../shared/files.ts";
import { bash_cursor_id_create, bash_cursor_id_resolve, bash_shell_arg_quote } from "./bash-utils.ts";

const PAGE_BYTES = 64 * 1024;
const cursor_schema = z.object({
	kind: z.literal("full-metadata"),
	binding: z.string(),
	fieldIndex: z.number().int().nonnegative(),
	valueIndex: z.number().int().nonnegative(),
	valueOffset: z.number().int().nonnegative(),
});

type FullValue =
	| {
			valueIndex: number;
			field: string;
			valueKind: files_metadata_Value["valueKind"];
			value: string | number | boolean;
	  }
	| { valueIndex: number; field: string; valueKind: "string"; fragment: string; offset: number; totalLength: number };

type FullPage = {
	path: string;
	target: files_PendingTarget;
	sourceKind: "committed" | "pending";
	fields: string[];
	values: FullValue[];
	isDone: boolean;
	continueCursor: string | null;
};

function page_text(page: FullPage) {
	const lines = [`source: ${page.sourceKind}`, ...page.fields];
	for (const value of page.values) {
		if ("fragment" in value) {
			lines.push(
				`${value.field} [value ${value.valueIndex}, UTF-16 ${value.offset}:${value.offset + value.fragment.length}/${value.totalLength}] = ${JSON.stringify(value.fragment)}`,
			);
		} else {
			const suffix = value.valueKind === "maybe_date" ? " (maybe_date)" : "";
			lines.push(`${value.field} = ${JSON.stringify(value.value)}${suffix}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

function continuation(path: string, cursor: string | null, format: "text" | "json", field?: string) {
	if (cursor === null) return "";
	return `Next page: meta get ${bash_shell_arg_quote(path)} --format ${format}${field === undefined ? "" : ` --field ${bash_shell_arg_quote(field)}`} --cursor ${bash_shell_arg_quote(cursor)}\n`;
}

function pair_safe_end(value: string, end: number) {
	if (end > 0 && end < value.length) {
		const last = value.charCodeAt(end - 1);
		const next = value.charCodeAt(end);
		if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) return end - 1;
	}
	return end;
}

function build_page(args: {
	source: files_metadata_FullReadSource;
	path: string;
	fields: string[];
	values: files_metadata_Value[];
	position: { fieldIndex: number; valueIndex: number; valueOffset: number };
	format: "text" | "json";
	bytes: number;
}) {
	const position = { ...args.position };
	const page: FullPage = {
		path: args.path,
		target: args.source.target,
		sourceKind: args.source.sourceKind,
		fields: [],
		values: [],
		isDone: false,
		continueCursor: null,
	};
	const fits = () =>
		files_get_utf8_byte_size(JSON.stringify(page, null, 2) + "\n") <= args.bytes &&
		(args.format === "json" || files_get_utf8_byte_size(page_text(page)) <= args.bytes);
	while (position.fieldIndex < args.fields.length) {
		page.fields.push(args.fields[position.fieldIndex]!);
		if (!fits()) {
			page.fields.pop();
			break;
		}
		position.fieldIndex++;
	}
	if (position.fieldIndex === args.fields.length) {
		while (position.valueIndex < args.values.length) {
			const value = args.values[position.valueIndex]!;
			const normal: FullValue = {
				valueIndex: position.valueIndex,
				field: value.fieldPath,
				valueKind: value.valueKind,
				value: value.valueKind === "maybe_date" ? new Date(value.value).toISOString() : value.value,
			};
			if (position.valueOffset === 0) {
				page.values.push(normal);
				if (fits()) {
					position.valueIndex++;
					continue;
				}
				page.values.pop();
			}
			if (value.valueKind !== "string") break;
			const fragment: Extract<FullValue, { fragment: string }> = {
				valueIndex: position.valueIndex,
				field: value.fieldPath,
				valueKind: "string",
				fragment: "",
				offset: position.valueOffset,
				totalLength: value.value.length,
			};
			page.values.push(fragment);
			let low = position.valueOffset;
			let high = value.value.length;
			while (low < high) {
				const middle = Math.ceil((low + high) / 2);
				fragment.fragment = value.value.slice(position.valueOffset, middle);
				if (fits()) low = middle;
				else high = middle - 1;
			}
			const end = pair_safe_end(value.value, low);
			if (end === position.valueOffset) {
				page.values.pop();
				break;
			}
			fragment.fragment = value.value.slice(position.valueOffset, end);
			position.valueOffset = end;
			if (end === value.value.length) {
				position.valueOffset = 0;
				position.valueIndex++;
				continue;
			}
			break;
		}
	}
	page.isDone = position.fieldIndex === args.fields.length && position.valueIndex === args.values.length;
	return { page, position };
}

/**
 * Read one owned map and supported Markdown source. Pages pin the selected versions and access.
 * JSON preserves YAML escapes that decode to lone surrogates. Convex strings require valid Unicode.
 */
export async function files_metadata_read_full_page(
	ctx: ActionCtx,
	args: {
		caller:
			| { kind: "path"; args: FunctionArgs<typeof internal.files_metadata.get_read_source_by_path> }
			| { kind: "field"; membershipId: Id<"organizations_workspaces_users">; target: files_PendingTarget };
		field?: string;
		format: "text" | "json";
		cursor: string | null;
		renderPath?: (path: string) => string;
	},
): Promise<
	| Result<{ _yay: { json: string; stdout: string; stderr: string; cursor: string | null; isDone: boolean } }>
	| { _nay: { message: string }; _yay?: undefined }
> {
	if (args.field !== undefined && !files_search_query_field_path_is_valid(args.field))
		return Result({ _nay: { message: "Choose a valid metadata or frontmatter field." } });
	const metadataOnly = args.field?.startsWith("metadata.") ?? false;
	const read_source = async (): Promise<files_metadata_FullReadSource | null> =>
		args.caller.kind === "path"
			? await ctx.runQuery(internal.files_metadata.get_read_source_by_path, { ...args.caller.args, metadataOnly })
			: await ctx.runQuery(internal.files_metadata.get_field_read_source, {
					membershipId: args.caller.membershipId,
					target: args.caller.target,
					metadataOnly,
				});
	const source = await read_source();
	if (!source) return Result({ _nay: { message: "Not found" } });
	const path = args.renderPath?.(source.path) ?? source.path;
	// A new turn has a new run fence. Check it on reads, but bind pages to the same caller and chat.
	const caller =
		args.caller.kind === "path" && args.caller.args.agentSource
			? {
					...args.caller,
					args: {
						...args.caller.args,
						agentSource: { ...args.caller.args.agentSource, run: undefined },
					},
				}
			: args.caller;
	const binding = JSON.stringify([caller, source.userId, args.format, args.field ?? null, path, source.revision]);
	let position = { fieldIndex: 0, valueIndex: 0, valueOffset: 0 };
	if (args.cursor !== null) {
		const resolved = await bash_cursor_id_resolve(ctx, args.cursor);
		if (resolved._nay) return Result({ _nay: { message: "Read cursor expired or is invalid. Start a new read." } });
		let stored: unknown;
		try {
			stored = JSON.parse(resolved._yay);
		} catch {
			return Result({ _nay: { message: "Read cursor is invalid. Start a new read." } });
		}
		const parsed = cursor_schema.safeParse(stored);
		if (!parsed.success || parsed.data.binding !== binding)
			return Result({ _nay: { message: "File changed. Start a new read." } });
		position = {
			fieldIndex: parsed.data.fieldIndex,
			valueIndex: parsed.data.valueIndex,
			valueOffset: parsed.data.valueOffset,
		};
	}

	const metadata = files_metadata_extract_entries(source.metadata);
	let fields = metadata.fields;
	let values = metadata.values;
	if (source.textRead !== null && (args.field === undefined || args.field.startsWith("frontmatter."))) {
		const caller = args.caller.kind === "path" ? args.caller.args : null;
		const text = (await ctx.runAction(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			agentSource: caller?.agentSource,
			organizationId: source.organizationId,
			workspaceId: source.workspaceId,
			userId: source.userId,
			serviceAccountId: caller?.serviceAccountId,
			path: source.path,
			overlayUserId: caller?.overlayUserId,
			includePending: source.textRead.includePending,
			pendingUpdateId: source.textRead.pendingUpdateId ?? undefined,
			maxBytes: files_MAX_TEXT_CONTENT_BYTES,
		})) as files_nodes_get_file_last_available_text_content_by_path_Result;
		if (
			!text ||
			text.target.kind !== source.target.kind ||
			text.target.id !== source.target.id ||
			text.pendingUpdateId !== source.textRead.pendingUpdateId
		)
			return Result({ _nay: { message: "File changed or its text is unavailable. Start a new read." } });
		const frontmatter = files_metadata_extract_frontmatter(text.content);
		if (frontmatter._nay)
			return Result({ _nay: { message: "Frontmatter could not be read. Read the file text instead." } });
		fields = [...fields, ...frontmatter._yay.fields];
		values = [...values, ...frontmatter._yay.values];
	}
	if (args.field !== undefined) {
		fields = fields.filter((field) => field === args.field);
		values = values.filter((value) => value.fieldPath === args.field);
	}
	const after = await read_source();
	if (!after) return Result({ _nay: { message: "Not found" } });
	if (after.revision !== source.revision) return Result({ _nay: { message: "File changed. Start a new read." } });

	let bytes = PAGE_BYTES;
	for (;;) {
		const built = build_page({ source, path, fields, values, position, format: args.format, bytes });
		if (
			!built.page.isDone &&
			built.position.fieldIndex === position.fieldIndex &&
			built.position.valueIndex === position.valueIndex &&
			built.position.valueOffset === position.valueOffset
		)
			throw new Error("Full metadata page made no progress");
		const cursor = built.page.isDone
			? null
			: await bash_cursor_id_create(ctx, JSON.stringify({ kind: "full-metadata", binding, ...built.position }));
		built.page.continueCursor = cursor;
		const json = `${JSON.stringify(built.page, null, 2)}\n`;
		const stdout = args.format === "json" ? json : page_text(built.page);
		const stderr = continuation(path, cursor, args.format, args.field);
		const actualBytes = Math.max(files_get_utf8_byte_size(json), files_get_utf8_byte_size(stdout + stderr));
		if (actualBytes <= PAGE_BYTES) return Result({ _yay: { json, stdout, stderr, cursor, isDone: built.page.isDone } });
		if (cursor !== null) await ctx.runMutation(internal.value_store.remove, { id: cursor });
		bytes -= actualBytes - PAGE_BYTES;
	}
}
