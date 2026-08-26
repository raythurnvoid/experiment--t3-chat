import { compareValues, v } from "convex/values";
import {
	internalAction,
	internalMutation,
	internalQuery,
	type ActionCtx,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel";
import { Result } from "common/errors-as-values-utils.ts";
import { files_get_utf8_byte_size, files_normalize_markdown_name } from "../shared/files.ts";
import { plugins_data_MAX_LIST_PAGE_SIZE } from "../shared/plugins.ts";
import { v_result } from "../server/convex-utils.ts";
import {
	plugins_PROJECTION_CHANGE_TIE_EXTRA,
	plugins_projections_next_cursor,
	plugins_projections_skip_already_applied,
} from "./plugins_projections_cursor.ts";
import { plugins_projections_is_registered } from "./plugins_projections_registry.ts";

/**
 * Copied from the Chitchat plugin. Do not import the plugin package from the host:
 * the plugin repo must not change for this feature, and the host must not depend on it.
 */
const REACTION_EMOJI: Record<string, string> = {
	thumbs_up: "👍",
	heart: "❤️",
	laugh: "😂",
	wow: "😮",
	sad: "😢",
	party: "🎉",
	rocket: "🚀",
	eyes: "👀",
};

const PRIVATE_KEY_PREFIX = "p/";
const MISSING_NAME = "Someone with no name yet";
const ROOT_FOLDER_PATH = "/chitchat";
const README_CHANNEL_KEY = "__readme__";
const README_FILE_NAME = "README.md";
const ROLLOVER_MAX_BYTES = 600_000;
const CHANNELS_PER_SYNC = 3;
const CHANGE_COLLECTIONS = ["channels", "messages", "replies", "reactions"] as const;

type ChannelValue = {
	name: string;
	archivedAt: number | null;
	topic?: string;
};

type MessageValue = {
	text: string;
	attachments: { name: string }[];
	editedAt: number | null;
	deletedAt: number | null;
};

type ProjectionMessage = {
	key: string;
	createdAt: number;
	createdBy: string;
	value: MessageValue;
};

type ProjectionReaction = {
	targetKey: string;
	token: string;
	removed: boolean;
};

type ChannelProjectionInput = {
	channelKey: string;
	channelName: string;
	topic: string | null;
	messages: ProjectionMessage[];
	repliesByRootKey: Map<string, ProjectionMessage[]>;
	reactionsByTargetKey: Map<string, ProjectionReaction[]>;
	displayNames: Map<string, string | null>;
};

function is_private_key(key: string) {
	return key.startsWith(PRIVATE_KEY_PREFIX);
}

/**
 * Public channel key of a store document. Channel docs use the channel key as `key`.
 * Messages, replies, and reactions put the channel key before the first `:`.
 */
export function plugins_projections_chitchat_channel_key(collection: string, key: string) {
	if (is_private_key(key)) {
		return null;
	}

	if (collection === "channels") {
		return key.includes(":") ? null : key;
	}

	const channelKey = key.split(":")[0];
	if (!channelKey || is_private_key(channelKey)) {
		return null;
	}

	return channelKey;
}

function pad2(value: number) {
	return String(value).padStart(2, "0");
}

function format_utc(ms: number) {
	const date = new Date(ms);
	return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())} UTC`;
}

function author_label(userId: string, displayNames: Map<string, string | null>) {
	const name = displayNames.get(userId);
	if (name !== undefined && name !== null && name !== "") {
		return name;
	}

	return MISSING_NAME;
}

function slug_channel_name(channelName: string) {
	const normalized = files_normalize_markdown_name(`${channelName}.md`);
	if (normalized._nay) {
		return "channel";
	}

	const fileName = normalized._yay;
	const baseName = fileName.endsWith(".md") ? fileName.slice(0, -3) : fileName;
	return baseName || "channel";
}

function collision_slug(channelName: string, channelKey: string) {
	const base = slug_channel_name(channelName);
	const suffix = channelKey.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "channel";
	const normalized = files_normalize_markdown_name(`${base}-${suffix}.md`);
	if (normalized._nay) {
		return `${base}-channel`;
	}

	const fileName = normalized._yay;
	return fileName.endsWith(".md") ? fileName.slice(0, -3) : fileName;
}

function format_reaction_line(reactions: ProjectionReaction[]) {
	const counts = new Map<string, number>();
	for (const reaction of reactions) {
		if (reaction.removed) {
			continue;
		}

		counts.set(reaction.token, (counts.get(reaction.token) ?? 0) + 1);
	}

	const parts: string[] = [];
	for (const [token, count] of counts) {
		const emoji = REACTION_EMOJI[token] ?? token;
		parts.push(`${emoji} ${count}`);
	}

	if (parts.length === 0) {
		return null;
	}

	return `reactions: ${parts.join(", ")}`;
}

function format_message_block(args: {
	message: ProjectionMessage;
	indent: string;
	displayNames: Map<string, string | null>;
	reactions: ProjectionReaction[];
}) {
	const { message, indent, displayNames, reactions } = args;
	const edited = message.value.editedAt !== null;
	const deleted = message.value.deletedAt !== null;
	const flags = [edited ? "(edited)" : null, deleted ? "(message deleted)" : null].filter(
		(flag): flag is string => flag !== null,
	);
	const flagText = flags.length > 0 ? ` ${flags.join(" ")}` : "";
	const lines = [
		`${indent}<!-- chitchat:msg:${message.key} -->`,
		`${indent}**${author_label(message.createdBy, displayNames)}** · ${format_utc(message.createdAt)}${flagText}`,
	];

	if (!deleted) {
		for (const textLine of message.value.text.split("\n")) {
			lines.push(`${indent}${textLine}`);
		}

		if (message.value.attachments.length > 0) {
			lines.push(`${indent}attachments: ${message.value.attachments.map((attachment) => attachment.name).join(", ")}`);
		}
	}

	const reactionLine = format_reaction_line(reactions);
	if (reactionLine !== null) {
		lines.push(`${indent}${reactionLine}`);
	}

	return lines.join("\n");
}

function sort_messages(messages: ProjectionMessage[]) {
	return [...messages].sort((left, right) => {
		if (left.createdAt !== right.createdAt) {
			return left.createdAt - right.createdAt;
		}

		return compareValues(left.key, right.key);
	});
}

function channel_header(channelName: string, topic: string | null) {
	const lines = [
		`# ${channelName}`,
		"",
		"Public Chitchat channel. This file is a derived copy. Edit chat in the Chitchat page, not here.",
	];
	if (topic !== null && topic !== "") {
		lines.push("", topic);
	}

	return lines.join("\n");
}

/**
 * Build one channel's markdown as message blocks. Oldest first. Replies sit under their root
 * with a two-space indent. Rebuilds always come from store docs, never from parsing comments.
 */
export function plugins_projections_chitchat_build_markdown(input: ChannelProjectionInput) {
	const header = channel_header(input.channelName, input.topic);
	const blocks: string[] = [];

	for (const message of sort_messages(input.messages)) {
		blocks.push(
			format_message_block({
				message,
				indent: "",
				displayNames: input.displayNames,
				reactions: input.reactionsByTargetKey.get(message.key) ?? [],
			}),
		);

		const replies = sort_messages(input.repliesByRootKey.get(message.key) ?? []);
		for (const reply of replies) {
			blocks.push(
				format_message_block({
					message: reply,
					indent: "  ",
					displayNames: input.displayNames,
					reactions: input.reactionsByTargetKey.get(reply.key) ?? [],
				}),
			);
		}
	}

	return { header, blocks, markdown: [header, ...blocks].join("\n\n") };
}

/**
 * Split on message-block boundaries so a rollover file never cuts a comment in half.
 * `files[0]` is the oldest (`slug.001.md`). The last file is the newest main (`slug.md`).
 */
export function plugins_projections_chitchat_split_rollover(args: {
	header: string;
	blocks: string[];
	maxBytes: number;
}) {
	const { header, blocks, maxBytes } = args;
	if (blocks.length === 0) {
		return [header];
	}

	const files: string[][] = [[]];
	let current = files[0]!;
	let currentIsMain = true;

	const push_block = (block: string) => {
		const candidate = currentIsMain
			? [header, ...current, block].join("\n\n")
			: [...current, block].join("\n\n");
		if (current.length > 0 && files_get_utf8_byte_size(candidate) > maxBytes) {
			files.push([]);
			current = files[files.length - 1]!;
			currentIsMain = false;
			current.push(block);
			return;
		}

		current.push(block);
	};

	// Pack newest blocks into the main file first, then spill older blocks into older files.
	for (const block of [...blocks].reverse()) {
		push_block(block);
	}

	const rendered = files.map((fileBlocks, index) => {
		// Packing walked newest-first so the newest tail stays in the main file.
		// Reverse each file so messages inside it are oldest first.
		const ordered = [...fileBlocks].reverse();
		if (index === 0) {
			return [header, ...ordered].join("\n\n");
		}

		return ordered.join("\n\n");
	});

	// `files[0]` was filled with newest-first packing, so reverse to oldest-first files.
	return rendered.reverse();
}

function rollover_path(folderPath: string, slug: string, rolloverIndex: number) {
	if (rolloverIndex === 0) {
		return `${folderPath}/${slug}.md`;
	}

	return `${folderPath}/${slug}.${String(rolloverIndex).padStart(3, "0")}.md`;
}

function readme_markdown() {
	return [
		"# Chitchat",
		"",
		"These files are a derived copy of public Chitchat channels in this workspace.",
		"",
		"- Edit chat in the Chitchat page, not in these files.",
		"- Private channels never appear here.",
		"- Author names are a snapshot. A rename shows up the next time a channel file is rebuilt.",
		"- The folder is read-only. The workspace agent can read these files with bash.",
	].join("\n");
}

function as_channel_value(value: Record<string, unknown>): ChannelValue | null {
	const name = value.name;
	if (typeof name !== "string" || name.length === 0) {
		return null;
	}

	const archivedAt = value.archivedAt;
	if (archivedAt !== null && typeof archivedAt !== "number") {
		return null;
	}

	const topic = value.topic;
	if (topic !== undefined && typeof topic !== "string") {
		return null;
	}

	return {
		name,
		archivedAt: archivedAt === null || typeof archivedAt === "number" ? archivedAt : null,
		...(typeof topic === "string" ? { topic } : {}),
	};
}

function as_message_value(value: Record<string, unknown>): MessageValue | null {
	if (typeof value.text !== "string") {
		return null;
	}

	const attachmentsRaw = value.attachments;
	const attachments: { name: string }[] = [];
	if (Array.isArray(attachmentsRaw)) {
		for (const item of attachmentsRaw) {
			if (item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string") {
				attachments.push({ name: (item as { name: string }).name });
			}
		}
	}

	const editedAt = value.editedAt === undefined ? null : value.editedAt;
	const deletedAt = value.deletedAt === undefined ? null : value.deletedAt;
	if (editedAt !== null && typeof editedAt !== "number") {
		return null;
	}
	if (deletedAt !== null && typeof deletedAt !== "number") {
		return null;
	}

	return {
		text: value.text,
		attachments,
		editedAt,
		deletedAt,
	};
}

function as_reaction_removed(value: Record<string, unknown>) {
	return value.removed === true;
}

function reaction_target_and_token(key: string) {
	const parts = key.split(":");
	if (parts.length < 4) {
		return null;
	}

	const token = parts[parts.length - 2];
	if (!token || REACTION_EMOJI[token] === undefined) {
		return null;
	}

	return { targetKey: parts.slice(0, -2).join(":"), token };
}

function reply_root_key(key: string) {
	const parts = key.split(":");
	if (parts.length < 5) {
		return null;
	}

	return parts.slice(0, -2).join(":");
}

if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, expect, test } = import.meta.vitest;

	const names = new Map<string, string | null>([
		["user_alice", "Alice"],
		["user_bob", "Bob"],
		["user_anon", null],
	]);

	describe("plugins_projections_chitchat_channel_key", () => {
		test("skips private keys", () => {
			expect(plugins_projections_chitchat_channel_key("channels", "p/secret")).toBeNull();
			expect(plugins_projections_chitchat_channel_key("messages", "p/secret:1:abcd")).toBeNull();
		});

		test("reads the first key segment for messages", () => {
			expect(plugins_projections_chitchat_channel_key("messages", "general-id:1:abcd")).toBe("general-id");
		});
	});

	describe("plugins_projections_chitchat_build_markdown", () => {
		test("formats a message with edit, attachments, reactions, and a nested reply", () => {
			const built = plugins_projections_chitchat_build_markdown({
				channelKey: "chan-1",
				channelName: "general",
				topic: null,
				messages: [
					{
						key: "chan-1:msg1",
						createdAt: Date.UTC(2026, 7, 26, 12, 0),
						createdBy: "user_alice",
						value: {
							text: "hello world",
							attachments: [{ name: "notes.md" }],
							editedAt: Date.UTC(2026, 7, 26, 12, 5),
							deletedAt: null,
						},
					},
				],
				repliesByRootKey: new Map([
					[
						"chan-1:msg1",
						[
							{
								key: "chan-1:msg1:reply1",
								createdAt: Date.UTC(2026, 7, 26, 12, 1),
								createdBy: "user_bob",
								value: { text: "hi", attachments: [], editedAt: null, deletedAt: null },
							},
						],
					],
				]),
				reactionsByTargetKey: new Map([
					[
						"chan-1:msg1",
						[
							{ targetKey: "chan-1:msg1", token: "thumbs_up", removed: false },
							{ targetKey: "chan-1:msg1", token: "thumbs_up", removed: false },
							{ targetKey: "chan-1:msg1", token: "heart", removed: false },
							{ targetKey: "chan-1:msg1", token: "laugh", removed: true },
						],
					],
				]),
				displayNames: names,
			});

			expect(built.markdown).toContain("# general");
			expect(built.markdown).toContain("<!-- chitchat:msg:chan-1:msg1 -->");
			expect(built.markdown).toContain("**Alice** · 2026-08-26 12:00 UTC (edited)");
			expect(built.markdown).toContain("hello world");
			expect(built.markdown).toContain("attachments: notes.md");
			expect(built.markdown).toContain("reactions: 👍 2, ❤️ 1");
			expect(built.markdown).not.toContain("😂");
			expect(built.markdown).toContain("  <!-- chitchat:msg:chan-1:msg1:reply1 -->");
			expect(built.markdown).toContain("  **Bob** · 2026-08-26 12:01 UTC");
			expect(built.markdown).toContain("  hi");
		});

		test("keeps a deleted message as a tombstone and uses the missing-name label", () => {
			const built = plugins_projections_chitchat_build_markdown({
				channelKey: "chan-1",
				channelName: "general",
				topic: null,
				messages: [
					{
						key: "chan-1:msg1",
						createdAt: Date.UTC(2026, 7, 26, 12, 0),
						createdBy: "user_anon",
						value: { text: "secret", attachments: [], editedAt: null, deletedAt: Date.UTC(2026, 7, 26, 12, 2) },
					},
				],
				repliesByRootKey: new Map(),
				reactionsByTargetKey: new Map(),
				displayNames: names,
			});

			expect(built.markdown).toContain("**Someone with no name yet**");
			expect(built.markdown).toContain("(message deleted)");
			expect(built.markdown).not.toContain("secret");
		});

		test("rebuilds the same markdown twice from the same store docs", () => {
			const input: ChannelProjectionInput = {
				channelKey: "chan-1",
				channelName: "general",
				topic: null,
				messages: [
					{
						key: "chan-1:msg1",
						createdAt: 1,
						createdBy: "user_alice",
						value: { text: "hello", attachments: [], editedAt: null, deletedAt: null },
					},
				],
				repliesByRootKey: new Map(),
				reactionsByTargetKey: new Map(),
				displayNames: names,
			};

			expect(plugins_projections_chitchat_build_markdown(input).markdown).toBe(
				plugins_projections_chitchat_build_markdown(input).markdown,
			);
		});
	});

	describe("plugins_projections_chitchat_split_rollover", () => {
		test("puts oldest messages in slug.001 and the newest tail in the main file", () => {
			const blocks = ["<!-- chitchat:msg:old -->\nold", "<!-- chitchat:msg:new -->\nnew"];
			const files = plugins_projections_chitchat_split_rollover({
				header: "# general",
				blocks,
				maxBytes: files_get_utf8_byte_size("# general\n\n<!-- chitchat:msg:new -->\nnew"),
			});

			expect(files).toHaveLength(2);
			expect(files[0]).toContain("<!-- chitchat:msg:old -->");
			expect(files[0]).not.toContain("# general");
			expect(files[1]).toContain("# general");
			expect(files[1]).toContain("<!-- chitchat:msg:new -->");
			expect(files[1]).not.toContain("<!-- chitchat:msg:old -->");
		});

		test("keeps oldest-first order inside a single file", () => {
			const blocks = ["<!-- chitchat:msg:old -->\nold", "<!-- chitchat:msg:new -->\nnew"];
			const files = plugins_projections_chitchat_split_rollover({
				header: "# general",
				blocks,
				maxBytes: 900_000,
			});

			expect(files).toHaveLength(1);
			expect(files[0]!.indexOf("<!-- chitchat:msg:old -->")).toBeLessThan(
				files[0]!.indexOf("<!-- chitchat:msg:new -->"),
			);
		});

		test("keeps a stable block id across a rebuild that only adds a later message", () => {
			const first = plugins_projections_chitchat_build_markdown({
				channelKey: "chan-1",
				channelName: "general",
				topic: null,
				messages: [
					{
						key: "chan-1:msg1",
						createdAt: 1,
						createdBy: "user_alice",
						value: { text: "hello", attachments: [], editedAt: null, deletedAt: null },
					},
				],
				repliesByRootKey: new Map(),
				reactionsByTargetKey: new Map(),
				displayNames: names,
			});
			const second = plugins_projections_chitchat_build_markdown({
				channelKey: "chan-1",
				channelName: "general",
				topic: null,
				messages: [
					{
						key: "chan-1:msg1",
						createdAt: 1,
						createdBy: "user_alice",
						value: { text: "hello", attachments: [], editedAt: null, deletedAt: null },
					},
					{
						key: "chan-1:msg2",
						createdAt: 2,
						createdBy: "user_bob",
						value: { text: "later", attachments: [], editedAt: null, deletedAt: null },
					},
				],
				repliesByRootKey: new Map(),
				reactionsByTargetKey: new Map(),
				displayNames: names,
			});

			expect(first.markdown).toContain("<!-- chitchat:msg:chan-1:msg1 -->");
			expect(second.markdown).toContain("<!-- chitchat:msg:chan-1:msg1 -->");
			expect(second.markdown).toContain("<!-- chitchat:msg:chan-1:msg2 -->");
		});
	});
}

const CHANGE_COLLECTIONS_VALIDATOR = v.union(
	v.literal("channels"),
	v.literal("messages"),
	v.literal("replies"),
	v.literal("reactions"),
);

export const sync = internalAction({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await run_chitchat_sync(ctx, args);
		return null;
	},
});

async function run_chitchat_sync(
	ctx: ActionCtx,
	args: { installationId: Id<"plugins_workspace_installations">; syncGeneration: number },
) {
	const prepared = (await ctx.runMutation(internal.plugins_projections_chitchat.prepare_sync, {
		installationId: args.installationId,
		syncGeneration: args.syncGeneration,
	})) as { _yay?: null; _nay?: { message: string } };
	if (prepared._nay) {
		return;
	}

	const root = (await ctx.runMutation(internal.plugins_projections.ensure_projection_root, {
		installationId: args.installationId,
	})) as { _yay?: { folderPath: string }; _nay?: { message: string } };
	if (root._nay || !root._yay) {
		return;
	}

	const folderPath = root._yay.folderPath;

	await ctx.runAction(internal.plugins_projections.write_projection_markdown, {
		installationId: args.installationId,
		path: `${folderPath}/${README_FILE_NAME}`,
		text: readme_markdown(),
		channelKey: README_CHANNEL_KEY,
		rolloverIndex: 0,
	});

	for (const collection of CHANGE_COLLECTIONS) {
		let more = true;
		while (more) {
			const page = (await ctx.runMutation(internal.plugins_projections_chitchat.advance_collection_cursor, {
				installationId: args.installationId,
				collection,
			})) as { _yay?: { truncated: boolean }; _nay?: { message: string } };
			const pageYay = page._yay;
			if (page._nay || pageYay === undefined) {
				return;
			}

			more = pageYay.truncated;
		}
	}

	await ctx.runMutation(internal.plugins_projections_chitchat.reconcile_public_channels, {
		installationId: args.installationId,
	});

	let processed = 0;
	while (processed < CHANNELS_PER_SYNC) {
		const channel = (await ctx.runQuery(internal.plugins_projections_chitchat.peek_dirty_channel, {
			installationId: args.installationId,
		})) as { channelKey: string } | null;
		if (channel === null) {
			break;
		}

		const built = (await ctx.runQuery(internal.plugins_projections_chitchat.load_channel_projection, {
			installationId: args.installationId,
			channelKey: channel.channelKey,
		})) as { header: string; blocks: string[]; slug: string } | null;
		if (built === null) {
			await ctx.runMutation(internal.plugins_projections.archive_projection_channel, {
				installationId: args.installationId,
				channelKey: channel.channelKey,
			});
			await ctx.runMutation(internal.plugins_projections_chitchat.complete_dirty_channel, {
				installationId: args.installationId,
				channelKey: channel.channelKey,
			});
			processed += 1;
			continue;
		}

		const files = plugins_projections_chitchat_split_rollover({
			header: built.header,
			blocks: built.blocks,
			maxBytes: ROLLOVER_MAX_BYTES,
		});
		const written = await ctx.runAction(internal.plugins_projections.write_projection_channel_files, {
			installationId: args.installationId,
			channelKey: channel.channelKey,
			slug: built.slug,
			folderPath,
			texts: files,
		});
		if (written._nay) {
			console.error("Failed to write projection channel files", {
				message: written._nay.message,
				installationId: args.installationId,
				channelKey: channel.channelKey,
			});
			await ctx.runMutation(internal.plugins_projections.finish_sync, {
				installationId: args.installationId,
				syncGeneration: args.syncGeneration,
				continueImmediately: false,
			});
			return;
		}

		await ctx.runMutation(internal.plugins_projections_chitchat.complete_dirty_channel, {
			installationId: args.installationId,
			channelKey: channel.channelKey,
		});
		processed += 1;
	}

	const moreDirty = (await ctx.runQuery(internal.plugins_projections_chitchat.peek_dirty_channel, {
		installationId: args.installationId,
	})) as { channelKey: string } | null;

	await ctx.runMutation(internal.plugins_projections.finish_sync, {
		installationId: args.installationId,
		syncGeneration: args.syncGeneration,
		continueImmediately: moreDirty !== null,
	});
}

export const prepare_sync = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		if (!installation || installation.status === "disabled") {
			await drain_projection_tables(ctx, args.installationId);
			return Result({ _nay: { message: "Installation gone" } });
		}
		if (!plugins_projections_is_registered(installation.pluginName)) {
			return Result({ _nay: { message: "Not a projecting plugin" } });
		}

		const state = await db_get_projection_state(ctx, args.installationId);
		if (!state) {
			return Result({ _nay: { message: "Missing projection state" } });
		}
		if (state.syncGeneration !== args.syncGeneration) {
			return Result({ _nay: { message: "Stale sync generation" } });
		}

		return Result({ _yay: null });
	},
});

export const advance_collection_cursor = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		collection: CHANGE_COLLECTIONS_VALIDATOR,
		pageSize: v.optional(v.number()),
	},
	returns: v_result({ _yay: v.object({ truncated: v.boolean() }) }),
	handler: async (ctx, args) => {
		const state = await db_get_projection_state(ctx, args.installationId);
		if (!state) {
			return Result({ _nay: { message: "Missing projection state" } });
		}

		const cursor = state.cursors[args.collection] ?? null;
		const pageSize = args.pageSize ?? plugins_data_MAX_LIST_PAGE_SIZE;
		const takeSize = pageSize + plugins_PROJECTION_CHANGE_TIE_EXTRA + 1;
		const raw = await ctx.db
			.query("plugins_data")
			.withIndex("by_installation_collection_scope_updatedAt", (q) => {
				const base = q
					.eq("installationId", args.installationId)
					.eq("collection", args.collection)
					.eq("scopeId", undefined);
				return cursor === null ? base : base.gte("updatedAt", cursor.updatedAt);
			})
			.order("asc")
			.take(takeSize);

		const fresh = plugins_projections_skip_already_applied(raw, cursor);
		const page = fresh.slice(0, pageSize);
		if (fresh.length === 0) {
			if (raw.length > 0) {
				const lastRaw = raw[raw.length - 1];
				const alreadyAtFence =
					cursor !== null && lastRaw !== undefined && lastRaw._id === cursor.lastId && lastRaw.updatedAt === cursor.updatedAt;
				if (lastRaw !== undefined && !alreadyAtFence) {
					await ctx.db.patch("plugins_data_projection_states", state._id, {
						cursors: {
							...state.cursors,
							[args.collection]: { updatedAt: lastRaw.updatedAt, lastId: lastRaw._id },
						},
						updatedAt: Date.now(),
					});
				}
			}

			return Result({ _yay: { truncated: false } });
		}

		const truncated = fresh.length > pageSize || raw.length === takeSize;

		for (const doc of page) {
			const channelKey = plugins_projections_chitchat_channel_key(args.collection, doc.key);
			if (channelKey === null) {
				continue;
			}

			await db_mark_channel_dirty(ctx, {
				organizationId: state.organizationId,
				workspaceId: state.workspaceId,
				installationId: args.installationId,
				channelKey,
			});
		}

		const lastApplied = page[page.length - 1] ?? null;
		const next = plugins_projections_next_cursor(lastApplied, cursor);
		// An empty page must not write `lastApplied!._id`. Keep the previous fence so a later
		// retry does not restart the collection, and so a null last-applied cannot throw.
		if (next !== null && lastApplied !== null) {
			await ctx.db.patch("plugins_data_projection_states", state._id, {
				cursors: {
					...state.cursors,
					[args.collection]: { updatedAt: next.updatedAt, lastId: next.lastId as Id<"plugins_data"> },
				},
				updatedAt: Date.now(),
			});
		}

		return Result({ _yay: { truncated } });
	},
});

export const reconcile_public_channels = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await db_get_projection_state(ctx, args.installationId);
		if (!state) {
			return null;
		}

		const liveKeys = new Set<string>();
		let keyStartExclusive: string | undefined;
		for (;;) {
			const page = await ctx.db
				.query("plugins_data")
				.withIndex("by_installation_collection_scope_key", (q) => {
					const base = q
						.eq("installationId", args.installationId)
						.eq("collection", "channels")
						.eq("scopeId", undefined);
					return keyStartExclusive === undefined ? base : base.gt("key", keyStartExclusive);
				})
				.take(plugins_data_MAX_LIST_PAGE_SIZE);
			if (page.length === 0) {
				break;
			}

			for (const doc of page) {
				if (is_private_key(doc.key)) {
					continue;
				}

				const value = as_channel_value(doc.value);
				if (value === null) {
					continue;
				}

				if (value.archivedAt !== null) {
					continue;
				}

				liveKeys.add(doc.key);
			}

			keyStartExclusive = page[page.length - 1]?.key;
			if (page.length < plugins_data_MAX_LIST_PAGE_SIZE) {
				break;
			}
		}

		const mapped = await ctx.db
			.query("plugins_data_projection_files")
			.withIndex("by_organization_workspace_installation", (q) =>
				q
					.eq("organizationId", state.organizationId)
					.eq("workspaceId", state.workspaceId)
					.eq("installationId", args.installationId),
			)
			.collect();
		const mappedKeys = new Set(mapped.map((doc) => doc.channelKey));
		for (const channelKey of mappedKeys) {
			if (channelKey === README_CHANNEL_KEY) {
				continue;
			}

			if (!liveKeys.has(channelKey)) {
				await ctx.scheduler.runAfter(0, internal.plugins_projections.archive_projection_channel, {
					installationId: args.installationId,
					channelKey,
				});
			}
		}

		return null;
	},
});

export const peek_dirty_channel = internalQuery({
	args: {
		installationId: v.id("plugins_workspace_installations"),
	},
	returns: v.union(v.object({ channelKey: v.string() }), v.null()),
	handler: async (ctx, args) => {
		const dirty = await ctx.db
			.query("plugins_data_projection_dirty_channels")
			.withIndex("by_installation_channelKey", (q) => q.eq("installationId", args.installationId))
			.first();
		if (!dirty) {
			return null;
		}

		return { channelKey: dirty.channelKey };
	},
});

export const complete_dirty_channel = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		channelKey: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const dirty = await ctx.db
			.query("plugins_data_projection_dirty_channels")
			.withIndex("by_installation_channelKey", (q) =>
				q.eq("installationId", args.installationId).eq("channelKey", args.channelKey),
			)
			.first();
		if (dirty) {
			await ctx.db.delete("plugins_data_projection_dirty_channels", dirty._id);
		}

		return null;
	},
});

export const load_channel_projection = internalQuery({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		channelKey: v.string(),
	},
	returns: v.union(
		v.object({
			header: v.string(),
			blocks: v.array(v.string()),
			slug: v.string(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		if (is_private_key(args.channelKey)) {
			return null;
		}

		const channelDoc = await ctx.db
			.query("plugins_data")
			.withIndex("by_installation_collection_key", (q) =>
				q.eq("installationId", args.installationId).eq("collection", "channels").eq("key", args.channelKey),
			)
			.first();
		if (!channelDoc || channelDoc.scopeId !== undefined) {
			return null;
		}

		const channelValue = as_channel_value(channelDoc.value);
		if (channelValue === null || channelValue.archivedAt !== null) {
			return null;
		}

		const prefix = `${args.channelKey}:`;
		const messages: ProjectionMessage[] = [];
		const repliesByRootKey = new Map<string, ProjectionMessage[]>();
		const reactionsByTargetKey = new Map<string, ProjectionReaction[]>();
		const userIds = new Set<string>();

		const messageDocs = await db_list_public_prefix(ctx, {
			installationId: args.installationId,
			collection: "messages",
			keyPrefix: prefix,
		});
		for (const doc of messageDocs) {
			const value = as_message_value(doc.value);
			if (value === null) {
				continue;
			}

			userIds.add(doc.createdBy);
			messages.push({
				key: doc.key,
				createdAt: doc._creationTime,
				createdBy: doc.createdBy,
				value,
			});
		}

		const replyDocs = await db_list_public_prefix(ctx, {
			installationId: args.installationId,
			collection: "replies",
			keyPrefix: prefix,
		});
		for (const doc of replyDocs) {
			const value = as_message_value(doc.value);
			const rootKey = reply_root_key(doc.key);
			if (value === null || rootKey === null) {
				continue;
			}

			userIds.add(doc.createdBy);
			const list = repliesByRootKey.get(rootKey) ?? [];
			list.push({
				key: doc.key,
				createdAt: doc._creationTime,
				createdBy: doc.createdBy,
				value,
			});
			repliesByRootKey.set(rootKey, list);
		}

		const reactionDocs = await db_list_public_prefix(ctx, {
			installationId: args.installationId,
			collection: "reactions",
			keyPrefix: prefix,
		});
		for (const doc of reactionDocs) {
			const parsed = reaction_target_and_token(doc.key);
			if (parsed === null) {
				continue;
			}

			const list = reactionsByTargetKey.get(parsed.targetKey) ?? [];
			list.push({
				targetKey: parsed.targetKey,
				token: parsed.token,
				removed: as_reaction_removed(doc.value),
			});
			reactionsByTargetKey.set(parsed.targetKey, list);
		}

		const displayNames = new Map<string, string | null>();
		for (const userId of userIds) {
			const user = await ctx.db.get("users", userId as Id<"users">);
			if (!user?.anagraphic) {
				displayNames.set(userId, null);
				continue;
			}

			const anagraphic = await ctx.db.get("users_anagraphics", user.anagraphic);
			displayNames.set(userId, anagraphic?.displayName ?? null);
		}

		const built = plugins_projections_chitchat_build_markdown({
			channelKey: args.channelKey,
			channelName: channelValue.name,
			topic: channelValue.topic ?? null,
			messages,
			repliesByRootKey,
			reactionsByTargetKey,
			displayNames,
		});

		const mapped = await ctx.db
			.query("plugins_data_projection_files")
			.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
				q.eq("installationId", args.installationId).eq("channelKey", args.channelKey).eq("rolloverIndex", 0),
			)
			.first();
		const defaultSlug = slug_channel_name(channelValue.name);
		let slug = defaultSlug;
		if (mapped) {
			const fileName = mapped.path.slice(mapped.path.lastIndexOf("/") + 1);
			if (fileName.endsWith(".md")) {
				slug = fileName.slice(0, -3).replace(/\.\d{3}$/, "") || defaultSlug;
			}
		}

		return {
			header: built.header,
			blocks: built.blocks,
			slug,
		};
	},
});

async function db_list_public_prefix(
	ctx: QueryCtx | MutationCtx,
	args: {
		installationId: Id<"plugins_workspace_installations">;
		collection: string;
		keyPrefix: string;
	},
) {
	const docs: Doc<"plugins_data">[] = [];
	let keyStartExclusive: string | undefined;
	const upper = key_prefix_upper_bound(args.keyPrefix);
	for (;;) {
		const page = await ctx.db
			.query("plugins_data")
			.withIndex("by_installation_collection_scope_key", (q) => {
				const scoped = q
					.eq("installationId", args.installationId)
					.eq("collection", args.collection)
					.eq("scopeId", undefined);
				if (keyStartExclusive === undefined) {
					return scoped.gte("key", args.keyPrefix).lt("key", upper);
				}

				return scoped.gt("key", keyStartExclusive).lt("key", upper);
			})
			.take(plugins_data_MAX_LIST_PAGE_SIZE);
		if (page.length === 0) {
			break;
		}

		docs.push(...page);
		keyStartExclusive = page[page.length - 1]?.key;
		if (page.length < plugins_data_MAX_LIST_PAGE_SIZE) {
			break;
		}
	}

	return docs;
}

function key_prefix_upper_bound(keyPrefix: string) {
	const lastCharCode = keyPrefix.charCodeAt(keyPrefix.length - 1);
	return keyPrefix.slice(0, -1) + String.fromCharCode(lastCharCode + 1);
}

async function db_get_projection_state(ctx: MutationCtx, installationId: Id<"plugins_workspace_installations">) {
	return await ctx.db
		.query("plugins_data_projection_states")
		.withIndex("by_installation", (q) => q.eq("installationId", installationId))
		.first();
}

async function db_mark_channel_dirty(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		installationId: Id<"plugins_workspace_installations">;
		channelKey: string;
	},
) {
	const existing = await ctx.db
		.query("plugins_data_projection_dirty_channels")
		.withIndex("by_installation_channelKey", (q) =>
			q.eq("installationId", args.installationId).eq("channelKey", args.channelKey),
		)
		.first();
	if (existing) {
		await ctx.db.patch("plugins_data_projection_dirty_channels", existing._id, { updatedAt: Date.now() });
		return;
	}

	await ctx.db.insert("plugins_data_projection_dirty_channels", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		installationId: args.installationId,
		channelKey: args.channelKey,
		updatedAt: Date.now(),
	});
}

async function drain_projection_tables(ctx: MutationCtx, installationId: Id<"plugins_workspace_installations">) {
	for (;;) {
		const dirty = await ctx.db
			.query("plugins_data_projection_dirty_channels")
			.withIndex("by_installation_channelKey", (q) => q.eq("installationId", installationId))
			.take(32);
		if (dirty.length === 0) {
			break;
		}

		await Promise.all(dirty.map((doc) => ctx.db.delete("plugins_data_projection_dirty_channels", doc._id)));
	}

	for (;;) {
		const files = await ctx.db
			.query("plugins_data_projection_files")
			.withIndex("by_installation_channelKey_rolloverIndex", (q) => q.eq("installationId", installationId))
			.take(32);
		if (files.length === 0) {
			break;
		}

		await Promise.all(files.map((doc) => ctx.db.delete("plugins_data_projection_files", doc._id)));
	}

	const state = await db_get_projection_state(ctx, installationId);
	if (state) {
		await ctx.db.delete("plugins_data_projection_states", state._id);
	}
}

export { ROOT_FOLDER_PATH, README_CHANNEL_KEY, collision_slug, rollover_path, slug_channel_name };
