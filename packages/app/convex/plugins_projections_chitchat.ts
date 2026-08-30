import { compareValues, v } from "convex/values";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
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
	plugins_projections_next_cursor,
	plugins_projections_skip_already_applied,
} from "./plugins_projections_cursor.ts";
import { plugins_projections_files_are_current } from "./plugins_projections.ts";
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
const PRIVATE_FOLDER_NAME = "private";
const README_CHANNEL_KEY = "__readme__";
const README_FILE_NAME = "README.md";
const ROLLOVER_MAX_BYTES = 600_000;
const CHANNELS_PER_SYNC = 3;
// Cap each collection at 25 pages. One hop can read 100 pages across all four feeds and then
// continues at 0 ms. Lowering this makes every continuation repay the sync setup work.
const CHANGE_PAGES_PER_SYNC = 25;
// Keep this under the transaction row and scheduled-function limits after rollover rows are read.
const RECONCILE_KEYS_PER_SYNC = 200;
const CHANGE_COLLECTIONS = ["channels", "messages", "replies", "reactions"] as const;
const CHANNEL_BUILD_DOCS_PER_HOP = 50;
// Resolve at most four profiles per render hop. Each profile can approach Convex's 1 MiB doc
// limit. Keep labels at 128 bytes so 100,000 store keys, 16 MiB of values, and fixed block text
// still fit inside the 128 rollover files below.
const CHANNEL_BUILD_NAMES_PER_HOP = 4;
const CHANNEL_BUILD_AUTHOR_NAME_MAX_BYTES = 128;
const CHANNEL_BUILD_BLOCKS_PER_HOP = 20;
const CHANNEL_BUILD_BYTES_PER_HOP = 400_000;
const CHANNEL_BUILD_FILES_PER_HOP = 2;
const CHANNEL_BUILD_CLEANUP_DOCS_PER_HOP = 50;
const CHANNEL_FILE_ARCHIVE_DOCS_PER_HOP = 8;
// This bound is safe only while the key, value, document-count, and author-label caps above hold.
const CHANNEL_BUILD_MAX_FILES = 128;
// Leave room for the largest rollover suffix (`.127.md`) inside a short file-system segment.
const COLLISION_SLUG_MAX_LENGTH = 120;

/**
 * Copied from the Chitchat plugin's `chat_PRIVATE_CHANNEL_DISCLOSURE`, same rule as
 * `REACTION_EMOJI` above: the host must not import the plugin package. The owner reads every
 * scope and every restricted file before any grant is consulted, so copy that says "private"
 * must say this too.
 */
const PRIVATE_DISCLOSURE =
	"Only the people in this channel can read this file — and the organization owner, who can read everything in this workspace.";

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
	isPrivate: boolean;
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

function bounded_author_name(name: string | null) {
	if (name === null) {
		return null;
	}
	const safeName = name
		.replace(/[\p{Cc}\p{Cf}]+/gu, " ")
		.replace(/\\/g, "\\\\")
		.replace(/\*/g, "\\*")
		.trim();
	if (safeName === "") {
		return null;
	}
	if (files_get_utf8_byte_size(safeName) <= CHANNEL_BUILD_AUTHOR_NAME_MAX_BYTES) {
		return safeName;
	}

	const bytes = new TextEncoder().encode(safeName).slice(0, CHANNEL_BUILD_AUTHOR_NAME_MAX_BYTES);
	return new TextDecoder().decode(bytes).replace(/\uFFFD$/, "");
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

function channel_key_digest(channelKey: string) {
	return bytesToHex(sha256(new TextEncoder().encode(channelKey)));
}

function collision_slug(channelName: string, channelKey: string) {
	const base = slug_channel_name(channelName);
	// Hash the full key. UUID prefixes collide at large channel counts, while this fixed digest keeps
	// public file names and private folder names stable and bounded.
	const suffix = channel_key_digest(channelKey);
	const boundedBase =
		base.slice(0, COLLISION_SLUG_MAX_LENGTH - suffix.length - 1).replace(/[._-]+$/u, "") || "channel";
	const normalized = files_normalize_markdown_name(`${boundedBase}-${suffix}.md`);
	if (normalized._nay) {
		return `channel-${suffix}`;
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

	return format_reaction_counts_line(counts);
}

function format_reaction_counts_line(counts: ReadonlyMap<string, number>) {
	const parts: string[] = [];
	for (const [token, count] of counts) {
		if (count <= 0) {
			continue;
		}
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
	reactions?: ProjectionReaction[];
	reactionCounts?: ReadonlyMap<string, number>;
}) {
	const { message, indent, displayNames } = args;
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

	const reactionLine = args.reactionCounts
		? format_reaction_counts_line(args.reactionCounts)
		: format_reaction_line(args.reactions ?? []);
	if (reactionLine !== null) {
		lines.push(`${indent}${reactionLine}`);
	}

	return lines.join("\n");
}

function format_staged_item_block(
	item: Doc<"plugins_data_projection_chitchat_items">,
	kind: "message" | "reply",
	authorName: string | null,
	counts: ReadonlyMap<string, number>,
) {
	return format_message_block({
		message: {
			key: item.key,
			createdAt: item.createdAt,
			createdBy: item.createdBy,
			value: {
				text: item.text,
				attachments: item.attachments,
				editedAt: item.editedAt,
				deletedAt: item.deletedAt,
			},
		},
		indent: kind === "reply" ? "  " : "",
		displayNames: new Map([[item.createdBy, authorName]]),
		reactionCounts: counts,
	});
}

function sort_messages(messages: ProjectionMessage[]) {
	return [...messages].sort((left, right) => {
		if (left.createdAt !== right.createdAt) {
			return left.createdAt - right.createdAt;
		}

		return compareValues(left.key, right.key);
	});
}

function channel_header(channelName: string, topic: string | null, isPrivate: boolean) {
	const lines = [
		`# ${channelName}`,
		"",
		isPrivate
			? `Private Chitchat channel. ${PRIVATE_DISCLOSURE} This file is a derived copy. Edit chat in the Chitchat page, not here.`
			: "Public Chitchat channel. This file is a derived copy. Edit chat in the Chitchat page, not here.",
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
	const header = channel_header(input.channelName, input.topic, input.isPrivate);
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
		const candidate = currentIsMain ? [header, ...current, block].join("\n\n") : [...current, block].join("\n\n");
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

function rollover_index_for_staged_file(outputFileIndex: number, stagedFileIndex: number) {
	if (stagedFileIndex === 0) {
		return 0;
	}

	// Rendering walks newest to oldest. Number archived files in the opposite direction so .001
	// is the oldest transcript and higher numbers move forward toward the main file.
	return outputFileIndex - stagedFileIndex + 1;
}

function readme_markdown() {
	return [
		"# Chitchat",
		"",
		"These files are a derived copy of Chitchat channels in this workspace.",
		"",
		"- Edit chat in the Chitchat page, not in these files.",
		`- Private channels appear under \`${PRIVATE_FOLDER_NAME}/\`. Each channel folder is visible only to the people in that channel — and the organization owner, who can read everything in this workspace.`,
		"- Do not share those folders by hand. The sync resets each folder's sharing to the channel's members.",
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
				isPrivate: false,
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
				isPrivate: false,
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
				isPrivate: false,
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
		test("the rollover bound covers the paid 100,000-document store shape", () => {
			// Store keys are 128 bytes. The capped author and the rest of one block add at most
			// another 256 bytes. Newline-heavy reply text can expand stored JSON by at most 1.5x.
			const maximumBlockOverhead = 100_000 * 384;
			const maximumRenderedValues = 16 * 1024 * 1024 * 1.5;
			const maximumReactionOverhead = 100_000 * 24;
			expect(CHANNEL_BUILD_MAX_FILES * ROLLOVER_MAX_BYTES).toBeGreaterThan(
				maximumBlockOverhead + maximumRenderedValues + maximumReactionOverhead,
			);
		});

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
				isPrivate: false,
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
				isPrivate: false,
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
	const runStartMs = Date.now();
	const prepared = (await ctx.runMutation(internal.plugins_projections_chitchat.prepare_sync, {
		installationId: args.installationId,
		syncGeneration: args.syncGeneration,
	})) as { _yay?: null; _nay?: { message: string } };
	if (prepared._nay) {
		return;
	}
	// Recover cleanup even when its dirty row was removed atomically before a scheduled cleanup failed.
	await ctx.runMutation(internal.plugins_projections_chitchat.cleanup_cancelled_builds, {
		installationId: args.installationId,
	});

	const root = (await ctx.runMutation(internal.plugins_projections.ensure_projection_root, {
		installationId: args.installationId,
		syncGeneration: args.syncGeneration,
	})) as { _yay?: { folderPath: string }; _nay?: { message: string } };
	if (root._nay || !root._yay) {
		return;
	}

	const folderPath = root._yay.folderPath;

	const dirtyAtHopStart = (await ctx.runQuery(internal.plugins_projections_chitchat.has_dirty_channel, {
		installationId: args.installationId,
	})) as boolean;
	const readme = await ctx.runAction(internal.plugins_projections.write_projection_markdown, {
		installationId: args.installationId,
		syncGeneration: args.syncGeneration,
		path: `${folderPath}/${README_FILE_NAME}`,
		text: readme_markdown(),
		channelKey: README_CHANNEL_KEY,
		rolloverIndex: 0,
	});

	let scanTruncated = false;
	for (const collection of CHANGE_COLLECTIONS) {
		let more = true;
		let pageCount = 0;
		while (more && pageCount < CHANGE_PAGES_PER_SYNC) {
			const page = (await ctx.runMutation(internal.plugins_projections_chitchat.advance_collection_cursor, {
				installationId: args.installationId,
				syncGeneration: args.syncGeneration,
				collection,
				runStartMs,
			})) as { _yay?: { truncated: boolean }; _nay?: { message: string } };
			const pageYay = page._yay;
			if (page._nay || pageYay === undefined) {
				return;
			}

			more = pageYay.truncated;
			pageCount += 1;
		}
		if (more) {
			scanTruncated = true;
		}
	}

	let reconcilePending = dirtyAtHopStart;
	if (!scanTruncated && !dirtyAtHopStart) {
		reconcilePending = (await ctx.runMutation(internal.plugins_projections_chitchat.reconcile_channels, {
			installationId: args.installationId,
			syncGeneration: args.syncGeneration,
		})) as boolean;
	}

	let processed = 0;
	while (processed < CHANNELS_PER_SYNC) {
		const channel = (await ctx.runMutation(internal.plugins_projections_chitchat.peek_dirty_channel, {
			installationId: args.installationId,
			syncGeneration: args.syncGeneration,
		})) as { channelKey: string; updatedAt: number } | null;
		if (channel === null) {
			break;
		}

		const step = (await ctx.runMutation(internal.plugins_projections_chitchat.advance_channel_build, {
			installationId: args.installationId,
			syncGeneration: args.syncGeneration,
			channelKey: channel.channelKey,
			dirtyUpdatedAt: channel.updatedAt,
		})) as ChannelBuildAdvance;
		if (step.kind === "archive") {
			const archived = (await ctx.runMutation(internal.plugins_projections_chitchat.advance_channel_file_cleanup, {
				installationId: args.installationId,
				syncGeneration: args.syncGeneration,
				expectedProjectionStateId: step.lifecycleStateId,
				channelKey: channel.channelKey,
				keepCount: 0,
				archiveFolder: true,
			})) as boolean;
			if (archived) {
				const finished = (await ctx.runMutation(internal.plugins_projections_chitchat.mark_archive_build_finished, {
					installationId: args.installationId,
					syncGeneration: args.syncGeneration,
					buildId: step.buildId,
				})) as boolean;
				if (finished) {
					await ctx.runMutation(internal.plugins_projections_chitchat.complete_dirty_channel, {
						installationId: args.installationId,
						syncGeneration: args.syncGeneration,
						expectedProjectionStateId: step.lifecycleStateId,
						channelKey: channel.channelKey,
						updatedAt: channel.updatedAt,
						files: [],
					});
				}
			}
			processed += 1;
			continue;
		}
		if (step.kind === "publish") {
			let channelFolderPath = step.channelFolderPath ?? folderPath;
			if (step.isPrivate) {
				const preferredPath = `${folderPath}/${PRIVATE_FOLDER_NAME}/${step.slug}`;
				const collisionPath = `${folderPath}/${PRIVATE_FOLDER_NAME}/${collision_slug(step.slug, channel.channelKey)}`;
				const ensured = (await ctx.runMutation(internal.plugins_projections.ensure_private_channel_folder, {
					installationId: args.installationId,
					syncGeneration: args.syncGeneration,
					expectedProjectionStateId: step.lifecycleStateId,
					channelKey: channel.channelKey,
					folderPath: preferredPath,
					collisionFolderPath: collisionPath,
				})) as { _yay?: { folderPath: string }; _nay?: { message: string } };
				if (ensured._nay || !ensured._yay) {
					console.error("Failed to ensure private channel folder", {
						message: ensured._nay?.message,
						installationId: args.installationId,
						channelKey: channel.channelKey,
					});
					await ctx.runMutation(internal.plugins_projections.finish_sync, {
						installationId: args.installationId,
						syncGeneration: args.syncGeneration,
						continueImmediately: false,
					});
					if (scanTruncated) {
						await ctx.runMutation(internal.plugins_projections.schedule_sync, {
							installationId: args.installationId,
							expectedSyncGeneration: args.syncGeneration,
						});
					}
					return;
				}

				channelFolderPath = ensured._yay.folderPath;
				const folderSaved = (await ctx.runMutation(internal.plugins_projections_chitchat.set_build_folder, {
					installationId: args.installationId,
					syncGeneration: args.syncGeneration,
					buildId: step.buildId,
					folderPath: channelFolderPath,
				})) as boolean;
				if (!folderSaved) {
					return;
				}
				await ctx.runMutation(internal.plugins_projections.reconcile_private_folder_grants, {
					installationId: args.installationId,
					syncGeneration: args.syncGeneration,
					expectedProjectionStateId: step.lifecycleStateId,
					channelKey: channel.channelKey,
					phase: "remove_extra",
				});
			}

			const resolvedSlug = await resolve_staged_projection_slug(ctx, {
				installationId: args.installationId,
				syncGeneration: args.syncGeneration,
				expectedProjectionStateId: step.lifecycleStateId,
				buildId: step.buildId,
				channelKey: channel.channelKey,
				folderPath: channelFolderPath,
			});
			if (resolvedSlug._nay) {
				console.error("Failed to resolve projection channel file name", {
					message: resolvedSlug._nay.message,
					installationId: args.installationId,
					channelKey: channel.channelKey,
				});
				await ctx.runMutation(internal.plugins_projections.finish_sync, {
					installationId: args.installationId,
					syncGeneration: args.syncGeneration,
					continueImmediately: false,
				});
				if (scanTruncated) {
					await ctx.runMutation(internal.plugins_projections.schedule_sync, {
						installationId: args.installationId,
						expectedSyncGeneration: args.syncGeneration,
					});
				}
				return;
			}

			const written = await write_staged_projection_file(ctx, {
				installationId: args.installationId,
				syncGeneration: args.syncGeneration,
				expectedProjectionStateId: step.lifecycleStateId,
				channelKey: channel.channelKey,
				slug: resolvedSlug._yay.slug,
				folderPath: channelFolderPath,
				rolloverIndex: step.rolloverIndex,
				text:
					step.rolloverIndex === 0 && step.body !== ""
						? `${step.header}\n\n${step.body}`
						: step.rolloverIndex === 0
							? step.header
							: step.body,
			});
			if (written._nay) {
				console.error("Failed to write projection channel file", {
					message: written._nay.message,
					installationId: args.installationId,
					channelKey: channel.channelKey,
				});
				await ctx.runMutation(internal.plugins_projections.finish_sync, {
					installationId: args.installationId,
					syncGeneration: args.syncGeneration,
					continueImmediately: false,
				});
				if (scanTruncated) {
					await ctx.runMutation(internal.plugins_projections.schedule_sync, {
						installationId: args.installationId,
						expectedSyncGeneration: args.syncGeneration,
					});
				}
				return;
			}

			const finishedPublishing = (await ctx.runMutation(
				internal.plugins_projections_chitchat.mark_build_file_published,
				{
					installationId: args.installationId,
					syncGeneration: args.syncGeneration,
					buildId: step.buildId,
					fileIndex: step.fileIndex,
					path: written._yay.path,
				},
			)) as boolean;
			if (finishedPublishing) {
				await finalize_channel_build(ctx, {
					installationId: args.installationId,
					syncGeneration: args.syncGeneration,
					buildId: step.buildId,
				});
			}
		} else if (step.kind === "finalize") {
			await finalize_channel_build(ctx, {
				installationId: args.installationId,
				syncGeneration: args.syncGeneration,
				buildId: step.buildId,
			});
		}
		processed += 1;
	}

	const moreDirty = (await ctx.runQuery(internal.plugins_projections_chitchat.has_dirty_channel, {
		installationId: args.installationId,
	})) as boolean;

	await ctx.runMutation(internal.plugins_projections.finish_sync, {
		installationId: args.installationId,
		syncGeneration: args.syncGeneration,
		continueImmediately: moreDirty || scanTruncated || reconcilePending,
		continueIfDirty: true,
		keepDirty: readme._nay !== undefined || readme._yay === undefined,
		...(readme._yay
			? {
					expectedFiles: {
						channelKey: README_CHANNEL_KEY,
						files: [{ rolloverIndex: 0, path: readme._yay.path }],
					},
				}
			: {}),
	});
}

type StagedWritePreflight = {
	_yay?: {
		occupant:
			| { mapped: true; channelKey: string; rolloverIndex: number }
			| { mapped: false; adoptable: boolean }
			| null;
	};
	_nay?: { message: string };
};

function staged_write_path_conflicts(
	occupant: NonNullable<NonNullable<StagedWritePreflight["_yay"]>["occupant"]> | null,
	channelKey: string,
	rolloverIndex: number,
) {
	return (
		occupant !== null &&
		((occupant.mapped === false && occupant.adoptable !== true) ||
			(occupant.mapped === true &&
				(occupant.channelKey !== channelKey || occupant.rolloverIndex !== rolloverIndex)))
	);
}

async function resolve_staged_projection_slug(
	ctx: ActionCtx,
	args: {
		installationId: Id<"plugins_workspace_installations">;
		syncGeneration: number;
		expectedProjectionStateId: Id<"plugins_data_projection_states">;
		buildId: Id<"plugins_data_projection_chitchat_builds">;
		channelKey: string;
		folderPath: string;
	},
) {
	const resolution = (await ctx.runQuery(internal.plugins_projections_chitchat.get_build_slug_resolution, {
		installationId: args.installationId,
		syncGeneration: args.syncGeneration,
		expectedProjectionStateId: args.expectedProjectionStateId,
		buildId: args.buildId,
	})) as { slug: string; outputFileIndex: number; hasPublishedFiles: boolean; updatedAt: number } | null;
	if (!resolution) {
		return Result({ _nay: { message: "Projection build is no longer current" } });
	}
	if (resolution.hasPublishedFiles) {
		return Result({ _yay: { slug: resolution.slug } });
	}

	let slug = resolution.slug;
	let resolved = false;
	for (let candidateIndex = 0; candidateIndex < 2; candidateIndex += 1) {
		let conflicts = false;
		let ownsPath = false;
		// Keep the 128-file family check out of one large Convex transaction.
		for (let rolloverIndex = 0; rolloverIndex <= resolution.outputFileIndex; rolloverIndex += 1) {
			const preflight = (await ctx.runQuery(internal.plugins_projections.get_write_preflight, {
				installationId: args.installationId,
				syncGeneration: args.syncGeneration,
				expectedProjectionStateId: args.expectedProjectionStateId,
				path: rollover_path(args.folderPath, slug, rolloverIndex),
			})) as StagedWritePreflight;
			if (preflight._nay || !preflight._yay) {
				return Result({ _nay: preflight._nay ?? { message: "Projection slug check failed" } });
			}
			const occupant = preflight._yay.occupant;
			ownsPath ||=
				occupant?.mapped === true &&
				occupant.channelKey === args.channelKey &&
				occupant.rolloverIndex === rolloverIndex;
			conflicts ||= staged_write_path_conflicts(occupant, args.channelKey, rolloverIndex);
		}
		if (!conflicts) {
			resolved = true;
			break;
		}
		// Keep an existing channel family stable. A new conflicting rollover must not move its main file.
		if (candidateIndex === 0 && !ownsPath) {
			slug = collision_slug(slug, args.channelKey);
			continue;
		}
		break;
	}
	if (!resolved) {
		return Result({ _nay: { message: "Projection channel file names are occupied" } });
	}

	// Save one name before the oldest rollover is written. Every later file must use this name.
	const savedSlug = (await ctx.runMutation(internal.plugins_projections_chitchat.set_build_slug, {
		installationId: args.installationId,
		syncGeneration: args.syncGeneration,
		expectedProjectionStateId: args.expectedProjectionStateId,
		buildId: args.buildId,
		expectedUpdatedAt: resolution.updatedAt,
		slug,
	})) as string | null;
	if (savedSlug === null) {
		return Result({ _nay: { message: "Projection build is no longer current" } });
	}
	return Result({ _yay: { slug: savedSlug } });
}

async function write_staged_projection_file(
	ctx: ActionCtx,
	args: {
		installationId: Id<"plugins_workspace_installations">;
		syncGeneration: number;
		expectedProjectionStateId: Id<"plugins_data_projection_states">;
		channelKey: string;
		slug: string;
		folderPath: string;
		rolloverIndex: number;
		text: string;
	},
) {
	let written: { _yay?: { nodeId: Id<"files_nodes">; path: string }; _nay?: { message: string } };
	try {
		written = (await ctx.runAction(internal.plugins_projections.write_projection_markdown, {
			installationId: args.installationId,
			syncGeneration: args.syncGeneration,
			expectedProjectionStateId: args.expectedProjectionStateId,
			path: rollover_path(args.folderPath, args.slug, args.rolloverIndex),
			text: args.text,
			channelKey: args.channelKey,
			rolloverIndex: args.rolloverIndex,
		})) as { _yay?: { nodeId: Id<"files_nodes">; path: string }; _nay?: { message: string } };
	} catch {
		// Keep capped change scans moving after an uncertain storage failure.
		return Result({ _nay: { message: "Projection write threw" } });
	}
	if (written._nay) {
		return Result({ _nay: written._nay });
	}
	if (!written._yay) {
		return Result({ _nay: { message: "Projection write failed" } });
	}
	return Result({ _yay: written._yay });
}

async function finalize_channel_build(
	ctx: ActionCtx,
	args: {
		installationId: Id<"plugins_workspace_installations">;
		syncGeneration: number;
		buildId: Id<"plugins_data_projection_chitchat_builds">;
	},
) {
	const ready = (await ctx.runQuery(internal.plugins_projections_chitchat.get_build_finalize, args)) as {
		channelKey: string;
		dirtyUpdatedAt: number;
		isPrivate: boolean;
		channelFolderPath?: string;
		lifecycleStateId: Id<"plugins_data_projection_states">;
		files: { rolloverIndex: number; path: string }[];
	} | null;
	if (!ready) {
		return false;
	}

	const trimmed = (await ctx.runMutation(internal.plugins_projections_chitchat.advance_channel_file_cleanup, {
		installationId: args.installationId,
		syncGeneration: args.syncGeneration,
		expectedProjectionStateId: ready.lifecycleStateId,
		channelKey: ready.channelKey,
		keepCount: ready.files.length,
		archiveFolder: false,
	})) as boolean;
	if (!trimmed) {
		return false;
	}
	if (ready.isPrivate) {
		await ctx.runMutation(internal.plugins_projections.reconcile_private_folder_grants, {
			installationId: args.installationId,
			syncGeneration: args.syncGeneration,
			expectedProjectionStateId: ready.lifecycleStateId,
			channelKey: ready.channelKey,
			phase: "add_missing",
		});
	}
	return (await ctx.runMutation(internal.plugins_projections_chitchat.mark_build_finalized, args)) as boolean;
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
			await ctx.scheduler.runAfter(0, internal.plugins_projections_chitchat.cleanup_cancelled_builds, {
				installationId: args.installationId,
			});
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
		syncGeneration: v.number(),
		collection: CHANGE_COLLECTIONS_VALIDATOR,
		runStartMs: v.number(),
		pageSize: v.optional(v.number()),
	},
	returns: v_result({ _yay: v.object({ truncated: v.boolean() }) }),
	handler: async (ctx, args) => {
		const state = await db_get_projection_state(ctx, args.installationId);
		if (!state) {
			return Result({ _nay: { message: "Missing projection state" } });
		}
		if (state.syncGeneration !== args.syncGeneration) {
			return Result({ _nay: { message: "Stale sync generation" } });
		}

		const cursor = state.cursors[args.collection] ?? null;
		const scanCursors = state.scanCursors ?? {};
		const activeScan = scanCursors[args.collection];
		const fromUpdatedAt = activeScan ? activeScan.fromUpdatedAt : cursor?.updatedAt;
		const throughUpdatedAt = activeScan?.throughUpdatedAt ?? args.runStartMs;
		const pageSize = args.pageSize ?? plugins_data_MAX_LIST_PAGE_SIZE;
		// Use Convex's opaque cursor inside one frozen upper bound. A custom `updatedAt` fence cannot
		// move past an arbitrarily large tie without rereading the whole tie in one transaction.
		const rawPage = await ctx.db
			.query("plugins_data")
			.withIndex("by_installation_collection_updatedAt", (q) => {
				const base = q.eq("installationId", args.installationId).eq("collection", args.collection);
				return fromUpdatedAt === undefined
					? base.lte("updatedAt", throughUpdatedAt)
					: base.gte("updatedAt", fromUpdatedAt).lte("updatedAt", throughUpdatedAt);
			})
			.order("asc")
			.paginate({ cursor: activeScan?.cursor ?? null, numItems: pageSize });
		const page = plugins_projections_skip_already_applied(rawPage.page, cursor);

		for (const doc of page) {
			let channelKey: string | null;
			if (doc.scopeId === undefined) {
				channelKey = plugins_projections_chitchat_channel_key(args.collection, doc.key);
			} else if (args.collection === "channels" && doc.key !== doc.scopeId) {
				// The `channels` collection inside a scope also holds each member's private read
				// cursor, stored as `<channelKey>:read:<userId>`. That is not channel content, and
				// rebuilding the whole file every time somebody opens the channel is pure churn.
				channelKey = null;
			} else {
				// Otherwise no key parsing is needed inside a scope: the scope id is the channel key.
				channelKey = doc.scopeId;
			}
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
		const { [args.collection]: _finishedScan, ...otherScans } = scanCursors;
		const cursors =
			next !== null && lastApplied !== null
				? {
						...state.cursors,
						[args.collection]: {
							updatedAt: next.updatedAt,
							lastCreationTime: next.lastCreationTime,
							lastId: next.lastId as Id<"plugins_data">,
						},
					}
				: state.cursors;
		if (!rawPage.isDone) {
			await ctx.db.patch("plugins_data_projection_states", state._id, {
				cursors,
				scanCursors: {
					...otherScans,
					[args.collection]: {
						cursor: rawPage.continueCursor,
						...(fromUpdatedAt !== undefined ? { fromUpdatedAt } : {}),
						throughUpdatedAt,
					},
				},
				updatedAt: Date.now(),
			});
			return Result({ _yay: { truncated: true } });
		}

		await ctx.db.patch("plugins_data_projection_states", state._id, {
			cursors,
			scanCursors: otherScans,
			updatedAt: Date.now(),
		});
		// A newer sync may have inherited an older unfinished scan. Finish that frozen page set,
		// then start another scan through this run's own fence before declaring exhaustion.
		return Result({ _yay: { truncated: throughUpdatedAt < args.runStartMs } });
	},
});

/**
 * Page mapped channel keys and archive dead projections. This is garbage collection; interactive
 * scope deletion also marks its channel dirty, so the normal drain owns the user-visible update.
 */
export const reconcile_channels = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const state = await db_get_projection_state(ctx, args.installationId);
		if (!state || state.syncGeneration !== args.syncGeneration) {
			return false;
		}

		const mappedKeys = new Set<string>();
		let afterChannelKey = state.reconcileAfterChannelKey;
		let exhausted = false;
		while (mappedKeys.size < RECONCILE_KEYS_PER_SYNC) {
			const rows = await ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_installation_channelKey_rolloverIndex", (q) => {
					const base = q.eq("installationId", args.installationId);
					return afterChannelKey === undefined ? base : base.gt("channelKey", afterChannelKey);
				})
				.take(plugins_data_MAX_LIST_PAGE_SIZE);
			if (rows.length === 0) {
				exhausted = true;
				break;
			}

			let lastAddedChannelKey: string | undefined;
			for (const row of rows) {
				if (mappedKeys.size === RECONCILE_KEYS_PER_SYNC) {
					break;
				}
				mappedKeys.add(row.channelKey);
				lastAddedChannelKey = row.channelKey;
			}
			afterChannelKey =
				mappedKeys.size === RECONCILE_KEYS_PER_SYNC ? lastAddedChannelKey : rows[rows.length - 1]?.channelKey;
			if (mappedKeys.size === RECONCILE_KEYS_PER_SYNC) {
				break;
			}
			if (rows.length < plugins_data_MAX_LIST_PAGE_SIZE) {
				exhausted = true;
				break;
			}
		}

		for (const channelKey of mappedKeys) {
			if (channelKey === README_CHANNEL_KEY) {
				continue;
			}

			const isPrivate = is_private_key(channelKey);
			const scopeRow = isPrivate
				? await ctx.db
						.query("plugins_data_scopes")
						.withIndex("by_installation_scope", (q) =>
							q.eq("installationId", args.installationId).eq("scopeId", channelKey),
						)
						.first()
				: null;
			const channelDoc = await ctx.db
				.query("plugins_data")
				.withIndex("by_installation_collection_key", (q) =>
					q.eq("installationId", args.installationId).eq("collection", "channels").eq("key", channelKey),
				)
				.first();
			const channelValue =
				channelDoc !== null &&
				(isPrivate ? channelDoc.scopeId === channelKey : channelDoc.scopeId === undefined) &&
				(!isPrivate || scopeRow !== null)
					? as_channel_value(channelDoc.value)
					: null;
			const alive = channelValue !== null && channelValue.archivedAt === null;
			if (alive) {
				continue;
			}

			// Put dead mappings on the durable FIFO queue. A delayed archive tied to this generation
			// could be refused after the cursor moved past this key, leaving the mapping forever.
			await db_mark_channel_dirty(ctx, {
				organizationId: state.organizationId,
				workspaceId: state.workspaceId,
				installationId: args.installationId,
				channelKey,
			});
		}

		await ctx.db.patch("plugins_data_projection_states", state._id, {
			reconcileAfterChannelKey: exhausted ? undefined : afterChannelKey,
			updatedAt: Date.now(),
		});

		return !exhausted;
	},
});

/**
 * Claim the oldest row before the action attempts it. The claim writes because a failed or thrown
 * rebuild must move behind other channels.
 */
export const peek_dirty_channel = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
	},
	returns: v.union(v.object({ channelKey: v.string(), updatedAt: v.number() }), v.null()),
	handler: async (ctx, args) => {
		const state = await db_get_projection_state(ctx, args.installationId);
		if (!state || state.syncGeneration !== args.syncGeneration) {
			return null;
		}

		const dirty = await ctx.db
			.query("plugins_data_projection_dirty_channels")
			.withIndex("by_installation_queuedAt", (q) => q.eq("installationId", args.installationId))
			.first();
		if (!dirty) {
			return null;
		}

		await ctx.db.patch("plugins_data_projection_dirty_channels", dirty._id, {
			queuedAt: Math.max(Date.now(), (dirty.queuedAt ?? 0) + 1),
		});
		return { channelKey: dirty.channelKey, updatedAt: dirty.updatedAt };
	},
});

export const has_dirty_channel = internalQuery({
	args: {
		installationId: v.id("plugins_workspace_installations"),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const dirty = await ctx.db
			.query("plugins_data_projection_dirty_channels")
			.withIndex("by_installation_channelKey", (q) => q.eq("installationId", args.installationId))
			.first();
		return dirty !== null;
	},
});

/**
 * Drop the dirty row this run just rebuilt.
 *
 * `updatedAt` is the value the run saw when it picked the channel up. A scope membership change
 * writes no store document, so no cursor can find it again: the dirty row is the only record that
 * it happened. If one lands while the channel is being rebuilt it bumps `updatedAt`, and deleting
 * the row anyway would lose that change for good. Keep the row instead and let the next run take it.
 */
export const complete_dirty_channel = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		expectedProjectionStateId: v.optional(v.id("plugins_data_projection_states")),
		channelKey: v.string(),
		updatedAt: v.number(),
		files: v.array(v.object({ rolloverIndex: v.number(), path: v.string() })),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		const state = await db_get_projection_state(ctx, args.installationId);
		if (
			!installation ||
			installation.status === "disabled" ||
			!state ||
			state.syncGeneration !== args.syncGeneration ||
			(args.expectedProjectionStateId !== undefined && state._id !== args.expectedProjectionStateId)
		) {
			return null;
		}

		const dirty = await ctx.db
			.query("plugins_data_projection_dirty_channels")
			.withIndex("by_installation_channelKey", (q) =>
				q.eq("installationId", args.installationId).eq("channelKey", args.channelKey),
			)
			.first();
		const filesCurrent = await plugins_projections_files_are_current(ctx, {
			installationId: args.installationId,
			channelKey: args.channelKey,
			files: args.files,
			expectedProjectionStateId: args.expectedProjectionStateId,
		});
		if (dirty && dirty.updatedAt === args.updatedAt && filesCurrent) {
			await ctx.db.delete("plugins_data_projection_dirty_channels", dirty._id);
		}

		return null;
	},
});

export const get_channel_projection_metadata = internalQuery({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		channelKey: v.string(),
	},
	returns: v.union(
		v.object({
			channelName: v.string(),
			topic: v.union(v.string(), v.null()),
			isPrivate: v.boolean(),
			slug: v.string(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		if (!(await db_projection_loader_is_current(ctx, args.installationId, args.syncGeneration))) {
			return null;
		}

		return await db_get_channel_projection_metadata(ctx, args.installationId, args.channelKey);
	},
});

async function db_get_channel_projection_metadata(
	ctx: QueryCtx | MutationCtx,
	installationId: Id<"plugins_workspace_installations">,
	channelKey: string,
) {
	const liveChannel = await db_get_live_channel(ctx, installationId, channelKey);
	if (liveChannel === null) {
		return null;
	}
	const { channelValue, isPrivate } = liveChannel;

	const mapped = await ctx.db
		.query("plugins_data_projection_files")
		.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
			q.eq("installationId", installationId).eq("channelKey", channelKey).eq("rolloverIndex", 0),
		)
		.first();
	const defaultSlug = slug_channel_name(channelValue.name);
	let slug = defaultSlug;
	if (mapped) {
		const fileName = mapped.path.slice(mapped.path.lastIndexOf("/") + 1);
		if (fileName.endsWith(".md")) {
			// This map is rollover zero, so a numeric suffix belongs to the main file's real slug.
			slug = fileName.slice(0, -3) || defaultSlug;
		}
	}

	return { channelName: channelValue.name, topic: channelValue.topic ?? null, isPrivate, slug };
}

async function db_get_live_channel(
	ctx: QueryCtx | MutationCtx,
	installationId: Id<"plugins_workspace_installations">,
	channelKey: string,
) {
	const isPrivate = is_private_key(channelKey);
	const channelDoc = await ctx.db
		.query("plugins_data")
		.withIndex("by_installation_collection_key", (q) =>
			q.eq("installationId", installationId).eq("collection", "channels").eq("key", channelKey),
		)
		.first();
	if (!channelDoc || (isPrivate ? channelDoc.scopeId !== channelKey : channelDoc.scopeId !== undefined)) {
		return null;
	}

	// Released private documents stay stored. Only a live scope can still project them.
	if (isPrivate) {
		const scope = await ctx.db
			.query("plugins_data_scopes")
			.withIndex("by_installation_scope", (q) => q.eq("installationId", installationId).eq("scopeId", channelKey))
			.first();
		if (!scope) {
			return null;
		}
	}

	const channelValue = as_channel_value(channelDoc.value);
	if (channelValue === null || channelValue.archivedAt !== null) {
		return null;
	}

	return { channelValue, isPrivate };
}

// Read this inside file-write mutations so archive and scope-delete transactions conflict safely.
export async function plugins_projections_chitchat_db_channel_is_live(
	ctx: QueryCtx | MutationCtx,
	installationId: Id<"plugins_workspace_installations">,
	channelKey: string,
) {
	return (await db_get_live_channel(ctx, installationId, channelKey)) !== null;
}

type ChannelBuildAdvance =
	| { kind: "building" }
	| {
			kind: "archive";
			buildId: Id<"plugins_data_projection_chitchat_builds">;
			lifecycleStateId: Id<"plugins_data_projection_states">;
	  }
	| {
			kind: "publish";
			buildId: Id<"plugins_data_projection_chitchat_builds">;
			lifecycleStateId: Id<"plugins_data_projection_states">;
			isPrivate: boolean;
			slug: string;
			header: string;
			fileIndex: number;
			rolloverIndex: number;
			body: string;
			channelFolderPath?: string;
	  }
	| {
			kind: "finalize";
			buildId: Id<"plugins_data_projection_chitchat_builds">;
			lifecycleStateId: Id<"plugins_data_projection_states">;
	  }
	| { kind: "done" };

export const advance_channel_build = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		channelKey: v.string(),
		dirtyUpdatedAt: v.number(),
	},
	returns: v.union(
		v.object({ kind: v.literal("building") }),
		v.object({
			kind: v.literal("archive"),
			buildId: v.id("plugins_data_projection_chitchat_builds"),
			lifecycleStateId: v.id("plugins_data_projection_states"),
		}),
		v.object({
			kind: v.literal("publish"),
			buildId: v.id("plugins_data_projection_chitchat_builds"),
			lifecycleStateId: v.id("plugins_data_projection_states"),
			isPrivate: v.boolean(),
			slug: v.string(),
			header: v.string(),
			fileIndex: v.number(),
			rolloverIndex: v.number(),
			body: v.string(),
			channelFolderPath: v.optional(v.string()),
		}),
		v.object({
			kind: v.literal("finalize"),
			buildId: v.id("plugins_data_projection_chitchat_builds"),
			lifecycleStateId: v.id("plugins_data_projection_states"),
		}),
		v.object({ kind: v.literal("done") }),
	),
	handler: async (ctx, args): Promise<ChannelBuildAdvance> => {
		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		const state = await db_get_projection_state(ctx, args.installationId);
		if (!installation || installation.status === "disabled" || !state || state.syncGeneration !== args.syncGeneration) {
			return { kind: "done" };
		}

		let build = await ctx.db
			.query("plugins_data_projection_chitchat_builds")
			.withIndex("by_installation_channelKey", (q) =>
				q.eq("installationId", args.installationId).eq("channelKey", args.channelKey),
			)
			.first();
		if (build && build.lifecycleStateId !== state._id) {
			const cleaned = await cleanup_build_rows(ctx, build, CHANNEL_BUILD_CLEANUP_DOCS_PER_HOP);
			return { kind: cleaned ? "done" : "building" };
		}

		if (build && build.phase !== "cleanup") {
			const liveChannel = await db_get_live_channel(ctx, args.installationId, args.channelKey);
			if (build.phase === "archive" && liveChannel !== null) {
				// Cancel a stale archive. Keep the dirty row so a new build can replace this drained one.
				const updatedAt = Date.now();
				await ctx.db.patch("plugins_data_projection_chitchat_builds", build._id, {
					phase: "cleanup",
					updatedAt,
				});
				build = { ...build, phase: "cleanup", updatedAt };
			} else if (build.phase !== "archive" && liveChannel === null) {
				const updatedAt = Date.now();
				await ctx.db.patch("plugins_data_projection_chitchat_builds", build._id, {
					phase: "archive",
					updatedAt,
				});
				return { kind: "archive", buildId: build._id, lifecycleStateId: build.lifecycleStateId };
			}
		}

		if (!build) {
			const metadata = await db_get_channel_projection_metadata(ctx, args.installationId, args.channelKey);
			if (metadata === null) {
				const now = Date.now();
				const buildId = await ctx.db.insert("plugins_data_projection_chitchat_builds", {
					organizationId: state.organizationId,
					workspaceId: state.workspaceId,
					installationId: args.installationId,
					lifecycleStateId: state._id,
					channelKey: args.channelKey,
					dirtyUpdatedAt: args.dirtyUpdatedAt,
					channelName: "",
					topic: null,
					isPrivate: is_private_key(args.channelKey),
					slug: "",
					header: "",
					phase: "archive",
					outputFileIndex: 0,
					publishedFiles: [],
					createdAt: now,
					updatedAt: now,
				});
				return { kind: "archive", buildId, lifecycleStateId: state._id };
			}

			const now = Date.now();
			const buildId = await ctx.db.insert("plugins_data_projection_chitchat_builds", {
				organizationId: state.organizationId,
				workspaceId: state.workspaceId,
				installationId: args.installationId,
				lifecycleStateId: state._id,
				channelKey: args.channelKey,
				dirtyUpdatedAt: args.dirtyUpdatedAt,
				channelName: metadata.channelName,
				topic: metadata.topic,
				isPrivate: metadata.isPrivate,
				slug: metadata.slug,
				header: channel_header(metadata.channelName, metadata.topic, metadata.isPrivate),
				phase: "scan_messages",
				outputFileIndex: 0,
				publishedFiles: [],
				createdAt: now,
				updatedAt: now,
			});
			build = await ctx.db.get("plugins_data_projection_chitchat_builds", buildId);
			if (!build) {
				throw new Error("Chitchat projection build missing after insert");
			}
		}
		if (!build) {
			throw new Error("Chitchat projection build is missing");
		}
		const buildId = build._id;
		const buildOrganizationId = build.organizationId;
		const buildWorkspaceId = build.workspaceId;
		const buildInstallationId = build.installationId;

		if (build.phase === "archive") {
			return { kind: "archive", buildId: build._id, lifecycleStateId: build.lifecycleStateId };
		}
		if (build.phase === "cleanup") {
			const cleaned = await cleanup_build_rows(ctx, build, CHANNEL_BUILD_CLEANUP_DOCS_PER_HOP);
			return { kind: cleaned ? "done" : "building" };
		}
		if (build.phase === "finalize") {
			return { kind: "finalize", buildId: build._id, lifecycleStateId: build.lifecycleStateId };
		}
		if (build.phase === "publish") {
			const fileIndex = build.publishFileIndex;
			if (fileIndex === undefined) {
				return { kind: "finalize", buildId: build._id, lifecycleStateId: build.lifecycleStateId };
			}
			const file = await ctx.db
				.query("plugins_data_projection_chitchat_files")
				.withIndex("by_build_fileIndex", (q) => q.eq("buildId", buildId).eq("fileIndex", fileIndex))
				.first();
			if (!file) {
				throw new Error("Chitchat staged projection file is missing");
			}
			return {
				kind: "publish",
				buildId: build._id,
				lifecycleStateId: build.lifecycleStateId,
				isPrivate: build.isPrivate,
				slug: build.slug,
				header: build.header,
				fileIndex,
				rolloverIndex: rollover_index_for_staged_file(build.outputFileIndex, fileIndex),
				body: file.body,
				...(build.channelFolderPath ? { channelFolderPath: build.channelFolderPath } : {}),
			};
		}

		let docsRead = 0;
		let blocksEmitted = 0;
		let bytesEmitted = 0;
		let filesCreated = 0;
		let namesResolved = 0;
		let transitions = 0;
		while (docsRead < CHANNEL_BUILD_DOCS_PER_HOP && transitions < 200) {
			transitions += 1;
			if (build.phase === "scan_messages" || build.phase === "scan_replies" || build.phase === "scan_reactions") {
				const collection: "messages" | "replies" | "reactions" =
					build.phase === "scan_messages" ? "messages" : build.phase === "scan_replies" ? "replies" : "reactions";
				const pageSize = CHANNEL_BUILD_DOCS_PER_HOP - docsRead;
				const docs = await db_list_channel_prefix_page(ctx, {
					installationId: args.installationId,
					collection,
					keyPrefix: `${args.channelKey}:`,
					scopeId: build.isPrivate ? args.channelKey : undefined,
					afterKey: build.scanAfterKey,
					pageSize,
				});
				docsRead += docs.length;

				if (collection === "reactions") {
					await Promise.all(
						docs.flatMap((doc) => {
							const parsed = reaction_target_and_token(doc.key);
							return parsed === null
								? []
								: [
										ctx.db.insert("plugins_data_projection_chitchat_reactions", {
											organizationId: buildOrganizationId,
											workspaceId: buildWorkspaceId,
											installationId: buildInstallationId,
											buildId,
											key: doc.key,
											targetKey: parsed.targetKey,
											token: parsed.token,
											removed: as_reaction_removed(doc.value),
										}),
									];
						}),
					);
				} else {
					const parsed = docs.flatMap((doc) => {
						const value = as_message_value(doc.value);
						const rootKey = collection === "replies" ? reply_root_key(doc.key) : null;
						return value === null || (collection === "replies" && rootKey === null)
							? []
							: [{ doc, value, ...(rootKey !== null ? { rootKey } : {}) }];
					});
					await Promise.all(
						parsed.map((entry) =>
							ctx.db.insert("plugins_data_projection_chitchat_items", {
								organizationId: buildOrganizationId,
								workspaceId: buildWorkspaceId,
								installationId: buildInstallationId,
								buildId,
								collection,
								key: entry.doc.key,
								...(entry.rootKey !== undefined ? { rootKey: entry.rootKey } : {}),
								createdAt: entry.doc._creationTime,
								createdBy: entry.doc.createdBy,
								text: entry.value.text,
								attachments: entry.value.attachments,
								editedAt: entry.value.editedAt,
								deletedAt: entry.value.deletedAt,
							}),
						),
					);
				}

				if (docs.length === pageSize) {
					const scanAfterKey = docs[docs.length - 1]?.key;
					await ctx.db.patch("plugins_data_projection_chitchat_builds", build._id, {
						scanAfterKey,
						updatedAt: Date.now(),
					});
					return { kind: "building" };
				}

				const phase: Doc<"plugins_data_projection_chitchat_builds">["phase"] =
					collection === "messages"
						? "scan_replies"
						: collection === "replies"
							? "scan_reactions"
							: "render_select_message";
				await ctx.db.patch("plugins_data_projection_chitchat_builds", build._id, {
					phase,
					scanAfterKey: undefined,
					updatedAt: Date.now(),
				});
				build = { ...build, phase, scanAfterKey: undefined, updatedAt: Date.now() };
				continue;
			}

			if (build.phase === "render_select_message") {
				const page: {
					page: Doc<"plugins_data_projection_chitchat_items">[];
					isDone: boolean;
					continueCursor: string;
				} = await ctx.db
					.query("plugins_data_projection_chitchat_items")
					.withIndex("by_build_collection_createdAt_key", (q) => q.eq("buildId", buildId).eq("collection", "messages"))
					.order("desc")
					.paginate({ cursor: build.messageCursor ?? null, numItems: 1 });
				const message = page.page[0];
				if (!message) {
					let output = await ctx.db
						.query("plugins_data_projection_chitchat_files")
						.withIndex("by_build_fileIndex", (q) => q.eq("buildId", buildId).eq("fileIndex", 0))
						.first();
					if (!output) {
						const outputId = await ctx.db.insert("plugins_data_projection_chitchat_files", {
							organizationId: buildOrganizationId,
							workspaceId: buildWorkspaceId,
							installationId: buildInstallationId,
							buildId,
							fileIndex: 0,
							body: "",
							updatedAt: Date.now(),
						});
						output = await ctx.db.get("plugins_data_projection_chitchat_files", outputId);
					}
					await ctx.db.patch("plugins_data_projection_chitchat_builds", build._id, {
						phase: "publish",
						publishFileIndex: build.outputFileIndex,
						updatedAt: Date.now(),
					});
					return {
						kind: "publish",
						buildId: build._id,
						lifecycleStateId: build.lifecycleStateId,
						isPrivate: build.isPrivate,
						slug: build.slug,
						header: build.header,
						fileIndex: build.outputFileIndex,
						rolloverIndex: rollover_index_for_staged_file(build.outputFileIndex, build.outputFileIndex),
						body: output?.body ?? "",
						...(build.channelFolderPath ? { channelFolderPath: build.channelFolderPath } : {}),
					};
				}

				docsRead += 1;
				await ctx.db.patch("plugins_data_projection_chitchat_builds", build._id, {
					phase: "render_select_reply",
					messageCursor: page.continueCursor,
					currentRootKey: message.key,
					replyCursor: undefined,
					updatedAt: Date.now(),
				});
				build = {
					...build,
					phase: "render_select_reply",
					messageCursor: page.continueCursor,
					currentRootKey: message.key,
					replyCursor: undefined,
					updatedAt: Date.now(),
				};
				continue;
			}

			if (build.phase === "render_select_reply") {
				const rootKey: string | undefined = build.currentRootKey;
				if (!rootKey) {
					throw new Error("Chitchat projection build has no current root message");
				}
				const page: {
					page: Doc<"plugins_data_projection_chitchat_items">[];
					isDone: boolean;
					continueCursor: string;
				} = await ctx.db
					.query("plugins_data_projection_chitchat_items")
					.withIndex("by_build_root_createdAt_key", (q) => q.eq("buildId", buildId).eq("rootKey", rootKey))
					.order("desc")
					.paginate({ cursor: build.replyCursor ?? null, numItems: 1 });
				const reply: Doc<"plugins_data_projection_chitchat_items"> | undefined = page.page[0];
				docsRead += reply ? 1 : 0;
				const currentItemKey: string = reply?.key ?? rootKey;
				const currentItemKind = reply ? "reply" : "message";
				await ctx.db.patch("plugins_data_projection_chitchat_builds", build._id, {
					phase: "render_scan_reactions",
					...(reply ? { replyCursor: page.continueCursor } : {}),
					currentItemKey,
					currentItemKind,
					reactionCursor: undefined,
					reactionCounts: {},
					updatedAt: Date.now(),
				});
				build = {
					...build,
					phase: "render_scan_reactions",
					...(reply ? { replyCursor: page.continueCursor } : {}),
					currentItemKey,
					currentItemKind,
					reactionCursor: undefined,
					reactionCounts: {},
					updatedAt: Date.now(),
				};
				continue;
			}

			if (build.phase === "render_scan_reactions") {
				const itemKey: string | undefined = build.currentItemKey;
				if (!itemKey) {
					throw new Error("Chitchat projection build has no current item");
				}
				const page = await ctx.db
					.query("plugins_data_projection_chitchat_reactions")
					.withIndex("by_build_target_key", (q) => q.eq("buildId", buildId).eq("targetKey", itemKey))
					.order("asc")
					.paginate({
						cursor: build.reactionCursor ?? null,
						numItems: CHANNEL_BUILD_DOCS_PER_HOP - docsRead,
					});
				docsRead += page.page.length;
				const reactionCounts: Record<string, number> = { ...(build.reactionCounts ?? {}) };
				for (const reaction of page.page) {
					if (!reaction.removed) {
						reactionCounts[reaction.token] = (reactionCounts[reaction.token] ?? 0) + 1;
					}
				}
				const phase: Doc<"plugins_data_projection_chitchat_builds">["phase"] = page.isDone
					? "render_emit"
					: "render_scan_reactions";
				await ctx.db.patch("plugins_data_projection_chitchat_builds", build._id, {
					phase,
					reactionCursor: page.isDone ? undefined : page.continueCursor,
					reactionCounts,
					updatedAt: Date.now(),
				});
				build = {
					...build,
					phase,
					reactionCursor: page.isDone ? undefined : page.continueCursor,
					reactionCounts,
					updatedAt: Date.now(),
				};
				if (!page.isDone) {
					return { kind: "building" };
				}
				continue;
			}

			if (build.phase === "render_emit") {
				const itemKey = build.currentItemKey;
				const itemKind: "message" | "reply" | undefined = build.currentItemKind;
				if (!itemKey || !itemKind) {
					throw new Error("Chitchat projection build has no item to emit");
				}
				const collection = itemKind === "reply" ? "replies" : "messages";
				const item = await ctx.db
					.query("plugins_data_projection_chitchat_items")
					.withIndex("by_build_collection_key", (q) =>
						q.eq("buildId", buildId).eq("collection", collection).eq("key", itemKey),
					)
					.first();
				if (!item) {
					throw new Error("Chitchat staged projection item is missing");
				}
				const cachedAuthor = await ctx.db
					.query("plugins_data_projection_chitchat_authors")
					.withIndex("by_build_userId", (q) => q.eq("buildId", buildId).eq("userId", item.createdBy))
					.first();
				let authorName: string | null;
				if (cachedAuthor) {
					authorName = cachedAuthor.label;
				} else {
					if (namesResolved >= CHANNEL_BUILD_NAMES_PER_HOP) {
						return { kind: "building" };
					}
					const user = await ctx.db.get("users", item.createdBy as Id<"users">);
					const anagraphic = user?.anagraphic ? await ctx.db.get("users_anagraphics", user.anagraphic) : null;
					namesResolved += 1;
					authorName = bounded_author_name(anagraphic?.displayName ?? null);
					// Freeze one label per user. A long build must not mix names after a profile rename.
					await ctx.db.insert("plugins_data_projection_chitchat_authors", {
						organizationId: buildOrganizationId,
						workspaceId: buildWorkspaceId,
						installationId: buildInstallationId,
						buildId,
						userId: item.createdBy,
						label: authorName,
					});
				}
				const block = format_staged_item_block(
					item,
					itemKind,
					authorName,
					new Map(Object.entries(build.reactionCounts ?? {})),
				);
				const blockBytes = files_get_utf8_byte_size(block);
				if (
					blocksEmitted >= CHANNEL_BUILD_BLOCKS_PER_HOP ||
					(blocksEmitted > 0 && bytesEmitted + blockBytes > CHANNEL_BUILD_BYTES_PER_HOP)
				) {
					return { kind: "building" };
				}

				const appended = await append_staged_block(ctx, build, block, filesCreated);
				if (!appended.emitted) {
					return { kind: "building" };
				}
				filesCreated = appended.filesCreated;
				blocksEmitted += 1;
				bytesEmitted += blockBytes;
				const phase: Doc<"plugins_data_projection_chitchat_builds">["phase"] =
					itemKind === "reply" ? "render_select_reply" : "render_select_message";
				await ctx.db.patch("plugins_data_projection_chitchat_builds", build._id, {
					phase,
					outputFileIndex: appended.outputFileIndex,
					...(itemKind === "message" ? { currentRootKey: undefined, replyCursor: undefined } : {}),
					currentItemKey: undefined,
					currentItemKind: undefined,
					reactionCursor: undefined,
					reactionCounts: undefined,
					updatedAt: Date.now(),
				});
				build = {
					...build,
					phase,
					outputFileIndex: appended.outputFileIndex,
					...(itemKind === "message" ? { currentRootKey: undefined, replyCursor: undefined } : {}),
					currentItemKey: undefined,
					currentItemKind: undefined,
					reactionCursor: undefined,
					reactionCounts: undefined,
					updatedAt: Date.now(),
				};
				continue;
			}
		}

		return { kind: "building" };
	},
});

async function append_staged_block(
	ctx: MutationCtx,
	build: Doc<"plugins_data_projection_chitchat_builds">,
	block: string,
	filesCreated: number,
) {
	const current = await ctx.db
		.query("plugins_data_projection_chitchat_files")
		.withIndex("by_build_fileIndex", (q) => q.eq("buildId", build._id).eq("fileIndex", build.outputFileIndex))
		.first();
	const currentBody = current?.body ?? "";
	const candidateBody = currentBody === "" ? block : `${block}\n\n${currentBody}`;
	const candidateText = build.outputFileIndex === 0 ? `${build.header}\n\n${candidateBody}` : candidateBody;
	if (currentBody !== "" && files_get_utf8_byte_size(candidateText) > ROLLOVER_MAX_BYTES) {
		if (filesCreated >= CHANNEL_BUILD_FILES_PER_HOP) {
			return { emitted: false as const, filesCreated, outputFileIndex: build.outputFileIndex };
		}
		if (build.outputFileIndex + 1 >= CHANNEL_BUILD_MAX_FILES) {
			throw new Error("Chitchat projection build exceeded its bounded rollover file count");
		}

		const outputFileIndex = build.outputFileIndex + 1;
		await ctx.db.insert("plugins_data_projection_chitchat_files", {
			organizationId: build.organizationId,
			workspaceId: build.workspaceId,
			installationId: build.installationId,
			buildId: build._id,
			fileIndex: outputFileIndex,
			body: block,
			updatedAt: Date.now(),
		});
		return { emitted: true as const, filesCreated: filesCreated + 1, outputFileIndex };
	}

	if (current) {
		await ctx.db.patch("plugins_data_projection_chitchat_files", current._id, {
			body: candidateBody,
			updatedAt: Date.now(),
		});
		return { emitted: true as const, filesCreated, outputFileIndex: build.outputFileIndex };
	}

	if (filesCreated >= CHANNEL_BUILD_FILES_PER_HOP) {
		return { emitted: false as const, filesCreated, outputFileIndex: build.outputFileIndex };
	}
	await ctx.db.insert("plugins_data_projection_chitchat_files", {
		organizationId: build.organizationId,
		workspaceId: build.workspaceId,
		installationId: build.installationId,
		buildId: build._id,
		fileIndex: build.outputFileIndex,
		body: block,
		updatedAt: Date.now(),
	});
	return { emitted: true as const, filesCreated: filesCreated + 1, outputFileIndex: build.outputFileIndex };
}

async function cleanup_build_rows(
	ctx: MutationCtx,
	build: Doc<"plugins_data_projection_chitchat_builds">,
	limit: number,
) {
	let remaining = limit;
	const items = await ctx.db
		.query("plugins_data_projection_chitchat_items")
		.withIndex("by_build_collection_key", (q) => q.eq("buildId", build._id))
		.take(remaining);
	await Promise.all(items.map((item) => ctx.db.delete("plugins_data_projection_chitchat_items", item._id)));
	remaining -= items.length;
	if (remaining === 0) {
		return false;
	}

	const reactions = await ctx.db
		.query("plugins_data_projection_chitchat_reactions")
		.withIndex("by_build_key", (q) => q.eq("buildId", build._id))
		.take(remaining);
	await Promise.all(
		reactions.map((reaction) => ctx.db.delete("plugins_data_projection_chitchat_reactions", reaction._id)),
	);
	remaining -= reactions.length;
	if (remaining === 0) {
		return false;
	}

	const authors = await ctx.db
		.query("plugins_data_projection_chitchat_authors")
		.withIndex("by_build_userId", (q) => q.eq("buildId", build._id))
		.take(remaining);
	await Promise.all(authors.map((author) => ctx.db.delete("plugins_data_projection_chitchat_authors", author._id)));
	remaining -= authors.length;
	if (remaining === 0) {
		return false;
	}

	// A staged body can be close to the file limit. Never read two bodies in one cleanup mutation.
	const file = await ctx.db
		.query("plugins_data_projection_chitchat_files")
		.withIndex("by_build_fileIndex", (q) => q.eq("buildId", build._id))
		.first();
	if (file) {
		await ctx.db.delete("plugins_data_projection_chitchat_files", file._id);
		return false;
	}

	await ctx.db.delete("plugins_data_projection_chitchat_builds", build._id);
	return true;
}

export const cleanup_cancelled_builds = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		buildId: v.optional(v.id("plugins_data_projection_chitchat_builds")),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		// A build-specific cleanup owns only one completed build. Installation cleanup may remove
		// every build only after the installation is gone or disabled.
		const build = args.buildId
			? await ctx.db.get("plugins_data_projection_chitchat_builds", args.buildId)
			: !installation || installation.status === "disabled"
				? await ctx.db
						.query("plugins_data_projection_chitchat_builds")
						.withIndex("by_installation", (q) => q.eq("installationId", args.installationId))
						.first()
				: await ctx.db
						.query("plugins_data_projection_chitchat_builds")
						.withIndex("by_installation_phase", (q) =>
							q.eq("installationId", args.installationId).eq("phase", "cleanup"),
						)
						.first();
		if (!build) {
			return null;
		}
		if (
			build.installationId !== args.installationId ||
			(args.buildId !== undefined && build.phase !== "cleanup") ||
			(installation?.status === "enabled" && build.phase !== "cleanup")
		) {
			return null;
		}

		const done = await cleanup_build_rows(ctx, build, CHANNEL_BUILD_CLEANUP_DOCS_PER_HOP);
		const another = args.buildId
			? done
				? null
				: build
			: done
				? installation?.status === "enabled"
					? await ctx.db
							.query("plugins_data_projection_chitchat_builds")
							.withIndex("by_installation_phase", (q) =>
								q.eq("installationId", args.installationId).eq("phase", "cleanup"),
							)
							.first()
					: await ctx.db
							.query("plugins_data_projection_chitchat_builds")
							.withIndex("by_installation", (q) => q.eq("installationId", args.installationId))
							.first()
				: build;
		if (another) {
			await ctx.scheduler.runAfter(0, internal.plugins_projections_chitchat.cleanup_cancelled_builds, {
				installationId: args.installationId,
				...(args.buildId ? { buildId: args.buildId } : {}),
			});
		}
		return null;
	},
});

export const advance_channel_file_cleanup = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		expectedProjectionStateId: v.id("plugins_data_projection_states"),
		channelKey: v.string(),
		keepCount: v.number(),
		archiveFolder: v.boolean(),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		const state = await db_get_projection_state(ctx, args.installationId);
		if (
			!installation ||
			installation.status === "disabled" ||
			!plugins_projections_is_registered(installation.pluginName) ||
			!state ||
			state._id !== args.expectedProjectionStateId ||
			state.syncGeneration !== args.syncGeneration
		) {
			return false;
		}
		// Read the source in this transaction so a recreate or unarchive conflicts with file cleanup.
		if (args.archiveFolder && (await db_get_live_channel(ctx, args.installationId, args.channelKey)) !== null) {
			return false;
		}

		for (let cleanedMappings = 0; cleanedMappings < CHANNEL_FILE_ARCHIVE_DOCS_PER_HOP; cleanedMappings += 1) {
			let mapped = await ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
					q
						.eq("installationId", args.installationId)
						.eq("channelKey", args.channelKey)
						.gte("rolloverIndex", args.keepCount),
				)
				.first();
			if (!mapped && args.archiveFolder) {
				mapped = await ctx.db
					.query("plugins_data_projection_files")
					.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
						q.eq("installationId", args.installationId).eq("channelKey", args.channelKey).eq("rolloverIndex", -1),
					)
					.first();
			}
			if (!mapped) {
				return true;
			}

			// The private-folder map is the only durable pointer to its mirrored grants. Drain those
			// grants before removing a stale map too, or an archived channel could leave access behind.
			if (mapped.rolloverIndex === -1) {
				const grants = await ctx.db
					.query("access_control_permission_grants")
					.withIndex("by_organization_workspace_resource_user_permission", (q) =>
						q
							.eq("organizationId", state.organizationId)
							.eq("workspaceId", state.workspaceId)
							.eq("resourceKind", "file")
							.eq("resourceId", String(mapped.fileNodeId)),
					)
					.take(CHANNEL_FILE_ARCHIVE_DOCS_PER_HOP);
				if (grants.length > 0) {
					await Promise.all(grants.map((grant) => ctx.db.delete("access_control_permission_grants", grant._id)));
					return false;
				}
			}

			const node = await ctx.db.get("files_nodes", mapped.fileNodeId);
			const archiveOperationId = `chitchat-projection:${mapped._id}`;
			if (node?.archiveOperationId !== archiveOperationId) {
				const active = await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						q
							.eq("organizationId", state.organizationId)
							.eq("workspaceId", state.workspaceId)
							.eq("path", mapped.path)
							.eq("archiveOperationId", undefined),
					)
					.first();
				if (active?._id !== mapped.fileNodeId || node?.projectionPluginName !== installation.pluginName) {
					await ctx.db.delete("plugins_data_projection_files", mapped._id);
					continue;
				}

				// Archive the node first so a member cannot move it while its denormalized search docs drain.
				await ctx.db.patch("files_nodes", node._id, {
					archiveOperationId,
					updatedBy: state.writerUserId,
					updatedAt: Date.now(),
				});
				return false;
			}

			if (node.kind === "file") {
				const chunks = await ctx.db
					.query("files_plain_text_chunks")
					.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
						q
							.eq("organizationId", state.organizationId)
							.eq("workspaceId", state.workspaceId)
							.eq("fileNodeId", node._id),
					)
					.filter((q) => q.neq(q.field("archiveOperationId"), archiveOperationId))
					.take(CHANNEL_FILE_ARCHIVE_DOCS_PER_HOP);
				if (chunks.length > 0) {
					await Promise.all(
						chunks.map((chunk) => ctx.db.patch("files_plain_text_chunks", chunk._id, { archiveOperationId })),
					);
					return false;
				}

				const metadataDocs = await ctx.db
					.query("files_metadata_docs")
					.withIndex("by_organization_workspace_fileNode_qualifiedField", (q) =>
						q
							.eq("organizationId", state.organizationId)
							.eq("workspaceId", state.workspaceId)
							.eq("fileNodeId", node._id),
					)
					.filter((q) => q.neq(q.field("archiveOperationId"), archiveOperationId))
					.take(CHANNEL_FILE_ARCHIVE_DOCS_PER_HOP);
				if (metadataDocs.length > 0) {
					await Promise.all(
						metadataDocs.map((doc) => ctx.db.patch("files_metadata_docs", doc._id, { archiveOperationId })),
					);
					return false;
				}
			}

			await ctx.db.delete("plugins_data_projection_files", mapped._id);
		}
		return false;
	},
});

export const mark_archive_build_finished = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		buildId: v.id("plugins_data_projection_chitchat_builds"),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const state = await db_get_projection_state(ctx, args.installationId);
		const build = await ctx.db.get("plugins_data_projection_chitchat_builds", args.buildId);
		if (
			!state ||
			state.syncGeneration !== args.syncGeneration ||
			!build ||
			build.installationId !== args.installationId ||
			build.lifecycleStateId !== state._id ||
			build.phase !== "archive"
		) {
			return false;
		}

		// Start the bounded staging drain only after the archive phase hid every mapped file.
		await ctx.db.patch("plugins_data_projection_chitchat_builds", build._id, {
			phase: "cleanup",
			updatedAt: Date.now(),
		});
		await ctx.scheduler.runAfter(0, internal.plugins_projections_chitchat.cleanup_cancelled_builds, {
			installationId: args.installationId,
			buildId: build._id,
		});
		return true;
	},
});

export const set_build_folder = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		buildId: v.id("plugins_data_projection_chitchat_builds"),
		folderPath: v.string(),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		const state = await db_get_projection_state(ctx, args.installationId);
		const build = await ctx.db.get("plugins_data_projection_chitchat_builds", args.buildId);
		if (
			!installation ||
			installation.status === "disabled" ||
			!state ||
			state.syncGeneration !== args.syncGeneration ||
			!build ||
			build.installationId !== args.installationId ||
			build.lifecycleStateId !== state._id
		) {
			return false;
		}

		await ctx.db.patch("plugins_data_projection_chitchat_builds", build._id, {
			channelFolderPath: args.folderPath,
			updatedAt: Date.now(),
		});
		return true;
	},
});

export const get_build_slug_resolution = internalQuery({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		expectedProjectionStateId: v.id("plugins_data_projection_states"),
		buildId: v.id("plugins_data_projection_chitchat_builds"),
	},
	returns: v.union(
		v.object({
			slug: v.string(),
			outputFileIndex: v.number(),
			hasPublishedFiles: v.boolean(),
			updatedAt: v.number(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		if (!(await db_projection_loader_is_current(ctx, args.installationId, args.syncGeneration))) {
			return null;
		}
		const state = await ctx.db
			.query("plugins_data_projection_states")
			.withIndex("by_installation", (q) => q.eq("installationId", args.installationId))
			.first();
		const build = await ctx.db.get("plugins_data_projection_chitchat_builds", args.buildId);
		if (
			!state ||
			state._id !== args.expectedProjectionStateId ||
			!build ||
			build.installationId !== args.installationId ||
			build.lifecycleStateId !== state._id ||
			build.phase !== "publish"
		) {
			return null;
		}
		if ((await db_get_live_channel(ctx, args.installationId, build.channelKey)) === null) {
			return null;
		}

		return {
			slug: build.slug,
			outputFileIndex: build.outputFileIndex,
			hasPublishedFiles: build.publishedFiles.length > 0,
			updatedAt: build.updatedAt,
		};
	},
});

export const set_build_slug = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		expectedProjectionStateId: v.id("plugins_data_projection_states"),
		buildId: v.id("plugins_data_projection_chitchat_builds"),
		expectedUpdatedAt: v.number(),
		slug: v.string(),
	},
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		const state = await db_get_projection_state(ctx, args.installationId);
		const build = await ctx.db.get("plugins_data_projection_chitchat_builds", args.buildId);
		if (
			!installation ||
			installation.status === "disabled" ||
			!state ||
			state.syncGeneration !== args.syncGeneration ||
			state._id !== args.expectedProjectionStateId ||
			!build ||
			build.installationId !== args.installationId ||
			build.lifecycleStateId !== state._id ||
			build.phase !== "publish"
		) {
			return null;
		}
		// A concurrent publisher may have saved the first file after the name check. Never rename
		// the rest of that family after one path is visible.
		if (build.publishedFiles.length > 0 || build.updatedAt !== args.expectedUpdatedAt) {
			return build.slug;
		}

		await ctx.db.patch("plugins_data_projection_chitchat_builds", build._id, {
			slug: args.slug,
			updatedAt: Math.max(Date.now(), build.updatedAt + 1),
		});
		return args.slug;
	},
});

export const mark_build_file_published = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		buildId: v.id("plugins_data_projection_chitchat_builds"),
		fileIndex: v.number(),
		path: v.string(),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		const state = await db_get_projection_state(ctx, args.installationId);
		const build = await ctx.db.get("plugins_data_projection_chitchat_builds", args.buildId);
		if (
			!installation ||
			installation.status === "disabled" ||
			!state ||
			state.syncGeneration !== args.syncGeneration ||
			!build ||
			build.installationId !== args.installationId ||
			build.lifecycleStateId !== state._id ||
			build.phase !== "publish" ||
			build.publishFileIndex !== args.fileIndex
		) {
			return false;
		}
		// Keep publication bookkeeping in the same live-source transaction as the build check.
		if ((await db_get_live_channel(ctx, args.installationId, build.channelKey)) === null) {
			return false;
		}

		const file = await ctx.db
			.query("plugins_data_projection_chitchat_files")
			.withIndex("by_build_fileIndex", (q) => q.eq("buildId", build._id).eq("fileIndex", args.fileIndex))
			.first();
		if (!file) {
			return false;
		}
		const finished = args.fileIndex === 0;
		const rolloverIndex = rollover_index_for_staged_file(build.outputFileIndex, args.fileIndex);
		await ctx.db.patch("plugins_data_projection_chitchat_builds", build._id, {
			phase: finished ? "finalize" : "publish",
			publishFileIndex: finished ? undefined : args.fileIndex - 1,
			publishedFiles: [...build.publishedFiles, { rolloverIndex, path: args.path }],
			updatedAt: Date.now(),
		});
		return finished;
	},
});

export const get_build_finalize = internalQuery({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		buildId: v.id("plugins_data_projection_chitchat_builds"),
	},
	returns: v.union(
		v.object({
			channelKey: v.string(),
			dirtyUpdatedAt: v.number(),
			lifecycleStateId: v.id("plugins_data_projection_states"),
			isPrivate: v.boolean(),
			channelFolderPath: v.optional(v.string()),
			files: v.array(v.object({ rolloverIndex: v.number(), path: v.string() })),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		if (!(await db_projection_loader_is_current(ctx, args.installationId, args.syncGeneration))) {
			return null;
		}
		const state = await ctx.db
			.query("plugins_data_projection_states")
			.withIndex("by_installation", (q) => q.eq("installationId", args.installationId))
			.first();
		const build = await ctx.db.get("plugins_data_projection_chitchat_builds", args.buildId);
		if (
			!state ||
			!build ||
			build.installationId !== args.installationId ||
			build.lifecycleStateId !== state._id ||
			build.phase !== "finalize"
		) {
			return null;
		}

		const files = build.publishedFiles;
		if (files.length !== build.outputFileIndex + 1 || files.length > CHANNEL_BUILD_MAX_FILES) {
			return null;
		}
		const indexes = new Set(files.map((file) => file.rolloverIndex));
		for (let index = 0; index <= build.outputFileIndex; index += 1) {
			if (!indexes.has(index)) {
				return null;
			}
		}
		return {
			channelKey: build.channelKey,
			dirtyUpdatedAt: build.dirtyUpdatedAt,
			lifecycleStateId: build.lifecycleStateId,
			isPrivate: build.isPrivate,
			...(build.channelFolderPath ? { channelFolderPath: build.channelFolderPath } : {}),
			files,
		};
	},
});

export const mark_build_finalized = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		buildId: v.id("plugins_data_projection_chitchat_builds"),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		const state = await db_get_projection_state(ctx, args.installationId);
		const build = await ctx.db.get("plugins_data_projection_chitchat_builds", args.buildId);
		if (
			!installation ||
			installation.status === "disabled" ||
			!state ||
			state.syncGeneration !== args.syncGeneration ||
			!build ||
			build.installationId !== args.installationId ||
			build.lifecycleStateId !== state._id ||
			build.phase !== "finalize"
		) {
			return false;
		}

		const dirty = await ctx.db
			.query("plugins_data_projection_dirty_channels")
			.withIndex("by_installation_channelKey", (q) =>
				q.eq("installationId", args.installationId).eq("channelKey", build.channelKey),
			)
			.first();
		const filesCurrent = await plugins_projections_files_are_current(ctx, {
			installationId: args.installationId,
			channelKey: build.channelKey,
			files: build.publishedFiles,
			expectedProjectionStateId: build.lifecycleStateId,
		});
		// Delete this build's dirty version and close the build in one transaction. A crash can no
		// longer leave a finalizable build whose dirty row was already removed.
		if (dirty && dirty.updatedAt === build.dirtyUpdatedAt && filesCurrent) {
			await ctx.db.delete("plugins_data_projection_dirty_channels", dirty._id);
		}
		await ctx.db.patch("plugins_data_projection_chitchat_builds", build._id, {
			phase: "cleanup",
			updatedAt: Date.now(),
		});
		await ctx.scheduler.runAfter(0, internal.plugins_projections_chitchat.cleanup_cancelled_builds, {
			installationId: args.installationId,
			buildId: build._id,
		});
		return true;
	},
});

async function db_list_channel_prefix_page(
	ctx: QueryCtx | MutationCtx,
	args: {
		installationId: Id<"plugins_workspace_installations">;
		collection: string;
		keyPrefix: string;
		scopeId: string | undefined;
		afterKey: string | undefined;
		pageSize: number;
	},
) {
	const upper = key_prefix_upper_bound(args.keyPrefix);
	return await ctx.db
		.query("plugins_data")
		.withIndex("by_installation_collection_scope_key", (q) => {
			const scoped = q
				.eq("installationId", args.installationId)
				.eq("collection", args.collection)
				.eq("scopeId", args.scopeId);
			if (args.afterKey === undefined) {
				return scoped.gte("key", args.keyPrefix).lt("key", upper);
			}

			return scoped.gt("key", args.afterKey).lt("key", upper);
		})
		.take(args.pageSize);
}

async function db_projection_loader_is_current(
	ctx: QueryCtx,
	installationId: Id<"plugins_workspace_installations">,
	syncGeneration: number,
) {
	const installation = await ctx.db.get("plugins_workspace_installations", installationId);
	if (!installation || installation.status === "disabled") {
		return false;
	}

	const state = await ctx.db
		.query("plugins_data_projection_states")
		.withIndex("by_installation", (q) => q.eq("installationId", installationId))
		.first();
	return state?.syncGeneration === syncGeneration;
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
		// `complete_dirty_channel` compares this stamp to decide whether a change landed while the
		// channel was being rebuilt. Two mutations can share one `Date.now()`, so step past the
		// stored value instead of writing the clock, and every mark is visible to that check.
		await ctx.db.patch("plugins_data_projection_dirty_channels", existing._id, {
			updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
		});
		return;
	}

	await ctx.db.insert("plugins_data_projection_dirty_channels", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		installationId: args.installationId,
		channelKey: args.channelKey,
		queuedAt: Date.now(),
		updatedAt: Date.now(),
	});
}

export { ROOT_FOLDER_PATH, README_CHANNEL_KEY, collision_slug, rollover_path, slug_channel_name };
