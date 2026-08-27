import { v } from "convex/values";
import {
	internalAction,
	internalMutation,
	internalQuery,
	type ActionCtx,
	type MutationCtx,
} from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel";
import { Result } from "common/errors-as-values-utils.ts";
import { files_normalize_name } from "../shared/files.ts";
import { plugins_data_MAX_LIST_PAGE_SIZE } from "../shared/plugins.ts";
import { v_result } from "../server/convex-utils.ts";
import {
	plugins_PROJECTION_CHANGE_TIE_EXTRA,
	plugins_projections_next_cursor,
	plugins_projections_skip_already_applied,
} from "./plugins_projections_cursor.ts";
import { plugins_projections_is_registered } from "./plugins_projections_registry.ts";

const PRIVATE_KEY_PREFIX = "p/";
const ROOT_FOLDER_PATH = "/meetings";
const MEETING_FILE_NAME = "meeting.md";
const MEETINGS_COLLECTION = "meetings";
const MEETINGS_PER_SYNC = 3;

type MeetingArtifact = {
	kind: string;
	fileName: string;
};

type MeetingValue = {
	meetingId: string;
	title: string;
	status: string;
	createdAt: number | null;
	openedAt: number | null;
	closedAt: number | null;
	deadlineAt: number | null;
	participantCount: number | null;
	recordingWarning: string | null;
	artifacts: MeetingArtifact[];
};

function is_private_key(key: string) {
	return key.startsWith(PRIVATE_KEY_PREFIX);
}

function pad2(value: number) {
	return String(value).padStart(2, "0");
}

function format_utc(ms: number) {
	const date = new Date(ms);
	return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())} UTC`;
}

function meeting_folder_name(meetingId: string) {
	const normalized = files_normalize_name("folder", meetingId);
	if (normalized._nay) {
		return "meeting";
	}

	return normalized._yay || "meeting";
}

function collision_file_name(meetingId: string) {
	const suffix = meetingId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "meeting";
	return `meeting-${suffix}.md`;
}

function as_optional_number(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function as_meeting_artifacts(value: unknown): MeetingArtifact[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const artifacts: MeetingArtifact[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			continue;
		}

		const record = item as Record<string, unknown>;
		if (typeof record.kind !== "string" || typeof record.fileName !== "string") {
			continue;
		}

		if (record.kind.length === 0 || record.fileName.length === 0) {
			continue;
		}

		artifacts.push({ kind: record.kind, fileName: record.fileName });
	}

	return artifacts;
}

function as_meeting_value(value: Record<string, unknown>): MeetingValue | null {
	const meetingId = value.meetingId;
	const title = value.title;
	const status = value.status;
	if (typeof meetingId !== "string" || meetingId.length === 0) {
		return null;
	}

	if (typeof title !== "string" || title.length === 0) {
		return null;
	}

	if (typeof status !== "string" || status.length === 0) {
		return null;
	}

	return {
		meetingId,
		title,
		status,
		createdAt: as_optional_number(value.createdAt),
		openedAt: as_optional_number(value.openedAt),
		closedAt: as_optional_number(value.closedAt),
		deadlineAt: as_optional_number(value.deadlineAt),
		participantCount: as_optional_number(value.participantCount),
		recordingWarning: typeof value.recordingWarning === "string" ? value.recordingWarning : null,
		artifacts: as_meeting_artifacts(value.artifacts),
	};
}

/**
 * Build the derived meeting note. The plugin store stays the source of truth.
 * This file never holds a join code, guest secret, or host ticket.
 */
export function plugins_projections_council_build_markdown(value: MeetingValue) {
	const lines = [
		`# ${value.title}`,
		"",
		"This file is a derived copy of a Council meeting. Edit the meeting in the Council page, not here.",
		"",
		`- Status: ${value.status}`,
		`- Meeting id: ${value.meetingId}`,
	];

	if (value.createdAt !== null) {
		lines.push(`- Created: ${format_utc(value.createdAt)}`);
	}

	if (value.openedAt !== null) {
		lines.push(`- Opened: ${format_utc(value.openedAt)}`);
	}

	if (value.closedAt !== null) {
		lines.push(`- Closed: ${format_utc(value.closedAt)}`);
	}

	if (value.deadlineAt !== null) {
		lines.push(`- Deadline: ${format_utc(value.deadlineAt)}`);
	}

	if (value.participantCount !== null) {
		lines.push(`- Participants: ${value.participantCount}`);
	}

	if (value.recordingWarning !== null) {
		lines.push("");
		lines.push(value.recordingWarning);
	}

	lines.push("");
	if (value.artifacts.length === 0) {
		lines.push("Council stored no recording files for this meeting.");
	} else {
		lines.push("## Saved files");
		lines.push("");
		for (const artifact of value.artifacts) {
			lines.push(`- ${artifact.fileName}`);
		}
	}

	return lines.join("\n");
}

if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, expect, test } = import.meta.vitest;

	describe("plugins_projections_council_build_markdown", () => {
		test("writes title, status, times, and a no-recording note", () => {
			const markdown = plugins_projections_council_build_markdown({
				meetingId: "af26438a-1234-4147-aeac-4abea4eb0495",
				title: "Colleague test 26 Aug",
				status: "ready",
				createdAt: Date.UTC(2026, 7, 26, 12, 0),
				openedAt: Date.UTC(2026, 7, 26, 12, 5),
				closedAt: Date.UTC(2026, 7, 26, 12, 10),
				deadlineAt: null,
				participantCount: 1,
				recordingWarning: null,
				artifacts: [],
			});

			expect(markdown).toContain("# Colleague test 26 Aug");
			expect(markdown).toContain("- Status: ready");
			expect(markdown).toContain("- Meeting id: af26438a-1234-4147-aeac-4abea4eb0495");
			expect(markdown).toContain("- Created: 2026-08-26 12:00 UTC");
			expect(markdown).toContain("- Participants: 1");
			expect(markdown).toContain("Council stored no recording files for this meeting.");
			expect(markdown).not.toContain("join");
			expect(markdown).not.toContain("ticket");
		});

		test("lists finalized artifact file names", () => {
			const markdown = plugins_projections_council_build_markdown({
				meetingId: "meeting-1",
				title: "Recorded",
				status: "ready",
				createdAt: null,
				openedAt: null,
				closedAt: null,
				deadlineAt: null,
				participantCount: null,
				recordingWarning: null,
				artifacts: [
					{ kind: "track_audio", fileName: "alice.webm" },
					{ kind: "transcript_markdown", fileName: "transcript.md" },
				],
			});

			expect(markdown).toContain("## Saved files");
			expect(markdown).toContain("- alice.webm");
			expect(markdown).toContain("- transcript.md");
			expect(markdown).not.toContain("Council stored no recording files");
		});

		test("writes the over-cap recording warning above the saved-file list", () => {
			const markdown = plugins_projections_council_build_markdown({
				meetingId: "meeting-1",
				title: "Long call",
				status: "ready",
				createdAt: null,
				openedAt: null,
				closedAt: null,
				deadlineAt: null,
				participantCount: null,
				recordingWarning:
					"Council could not store the video recording. The file was larger than the workspace can accept. Audio, transcript, and summary were still saved.",
				artifacts: [
					{ kind: "track_audio", fileName: "recording-audio.m4a" },
					{ kind: "transcript_markdown", fileName: "transcript.md" },
				],
			});

			expect(markdown).toContain(
				"Council could not store the video recording. The file was larger than the workspace can accept. Audio, transcript, and summary were still saved.",
			);
			expect(markdown).toContain("- recording-audio.m4a");
			expect(markdown).toContain("- transcript.md");
		});
	});
}

export const sync = internalAction({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await run_council_sync(ctx, args);
		return null;
	},
});

async function run_council_sync(
	ctx: ActionCtx,
	args: { installationId: Id<"plugins_workspace_installations">; syncGeneration: number },
) {
	const prepared = (await ctx.runMutation(internal.plugins_projections_council.prepare_sync, {
		installationId: args.installationId,
		syncGeneration: args.syncGeneration,
	})) as { _yay?: null; _nay?: { message: string } };
	if (prepared._nay) {
		return;
	}

	const root = (await ctx.runMutation(internal.plugins_projections.ensure_writable_projection_root, {
		installationId: args.installationId,
		preferredPath: ROOT_FOLDER_PATH,
	})) as { _yay?: { folderPath: string }; _nay?: { message: string } };
	if (root._nay || !root._yay) {
		return;
	}

	const folderPath = root._yay.folderPath;

	let more = true;
	while (more) {
		const page = (await ctx.runMutation(internal.plugins_projections_council.advance_collection_cursor, {
			installationId: args.installationId,
		})) as { _yay?: { truncated: boolean }; _nay?: { message: string } };
		const pageYay = page._yay;
		if (page._nay || pageYay === undefined) {
			return;
		}

		more = pageYay.truncated;
	}

	await ctx.runMutation(internal.plugins_projections_council.reconcile_meetings, {
		installationId: args.installationId,
	});

	let processed = 0;
	while (processed < MEETINGS_PER_SYNC) {
		const meeting = (await ctx.runQuery(internal.plugins_projections_council.peek_dirty_channel, {
			installationId: args.installationId,
		})) as { channelKey: string } | null;
		if (meeting === null) {
			break;
		}

		const built = (await ctx.runQuery(internal.plugins_projections_council.load_meeting_projection, {
			installationId: args.installationId,
			channelKey: meeting.channelKey,
			folderPath,
		})) as { path: string; text: string; meetingId: string } | null;
		if (built === null) {
			await ctx.runMutation(internal.plugins_projections.archive_projection_channel, {
				installationId: args.installationId,
				channelKey: meeting.channelKey,
			});
			await ctx.runMutation(internal.plugins_projections_council.complete_dirty_channel, {
				installationId: args.installationId,
				channelKey: meeting.channelKey,
			});
			processed += 1;
			continue;
		}

		let path = built.path;
		const preflight = (await ctx.runQuery(internal.plugins_projections.get_write_preflight, {
			installationId: args.installationId,
			path,
		})) as {
			_yay?: {
				occupant:
					| { mapped: false; adoptable: boolean }
					| { mapped: true; channelKey: string }
					| null;
			};
		};
		if (
			preflight._yay &&
			preflight._yay.occupant &&
			((preflight._yay.occupant.mapped === false && preflight._yay.occupant.adoptable !== true) ||
				(preflight._yay.occupant.mapped === true && preflight._yay.occupant.channelKey !== meeting.channelKey))
		) {
			path = `${folderPath}/${meeting_folder_name(built.meetingId)}/${collision_file_name(built.meetingId)}`;
		}

		const written = await ctx.runAction(internal.plugins_projections.write_projection_markdown, {
			installationId: args.installationId,
			path,
			text: built.text,
			channelKey: meeting.channelKey,
			rolloverIndex: 0,
		});
		if (written._nay) {
			console.error("Failed to write council meeting projection file", {
				message: written._nay.message,
				installationId: args.installationId,
				channelKey: meeting.channelKey,
			});
			await ctx.runMutation(internal.plugins_projections.finish_sync, {
				installationId: args.installationId,
				syncGeneration: args.syncGeneration,
				continueImmediately: false,
			});
			return;
		}

		await ctx.runMutation(internal.plugins_projections_council.complete_dirty_channel, {
			installationId: args.installationId,
			channelKey: meeting.channelKey,
		});
		processed += 1;
	}

	const moreDirty = (await ctx.runQuery(internal.plugins_projections_council.peek_dirty_channel, {
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
		pageSize: v.optional(v.number()),
	},
	returns: v_result({ _yay: v.object({ truncated: v.boolean() }) }),
	handler: async (ctx, args) => {
		const state = await db_get_projection_state(ctx, args.installationId);
		if (!state) {
			return Result({ _nay: { message: "Missing projection state" } });
		}

		const cursor = state.cursors[MEETINGS_COLLECTION] ?? null;
		const pageSize = args.pageSize ?? plugins_data_MAX_LIST_PAGE_SIZE;
		const takeSize = pageSize + plugins_PROJECTION_CHANGE_TIE_EXTRA + 1;
		const raw = await ctx.db
			.query("plugins_data")
			.withIndex("by_installation_collection_scope_updatedAt", (q) => {
				const base = q
					.eq("installationId", args.installationId)
					.eq("collection", MEETINGS_COLLECTION)
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
							[MEETINGS_COLLECTION]: { updatedAt: lastRaw.updatedAt, lastId: lastRaw._id },
						},
						updatedAt: Date.now(),
					});
				}
			}

			return Result({ _yay: { truncated: false } });
		}

		const truncated = fresh.length > pageSize || raw.length === takeSize;

		for (const doc of page) {
			if (is_private_key(doc.key)) {
				continue;
			}

			await db_mark_channel_dirty(ctx, {
				organizationId: state.organizationId,
				workspaceId: state.workspaceId,
				installationId: args.installationId,
				channelKey: doc.key,
			});
		}

		const lastApplied = page[page.length - 1] ?? null;
		const next = plugins_projections_next_cursor(lastApplied, cursor);
		if (next !== null && lastApplied !== null) {
			await ctx.db.patch("plugins_data_projection_states", state._id, {
				cursors: {
					...state.cursors,
					[MEETINGS_COLLECTION]: { updatedAt: next.updatedAt, lastId: next.lastId as Id<"plugins_data"> },
				},
				updatedAt: Date.now(),
			});
		}

		return Result({ _yay: { truncated } });
	},
});

export const reconcile_meetings = internalMutation({
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
						.eq("collection", MEETINGS_COLLECTION)
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

				const value = as_meeting_value(doc.value);
				if (value === null) {
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

export const load_meeting_projection = internalQuery({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		channelKey: v.string(),
		folderPath: v.string(),
	},
	returns: v.union(
		v.object({
			path: v.string(),
			text: v.string(),
			meetingId: v.string(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		if (is_private_key(args.channelKey)) {
			return null;
		}

		const meetingDoc = await ctx.db
			.query("plugins_data")
			.withIndex("by_installation_collection_key", (q) =>
				q.eq("installationId", args.installationId).eq("collection", MEETINGS_COLLECTION).eq("key", args.channelKey),
			)
			.first();
		if (!meetingDoc || meetingDoc.scopeId !== undefined) {
			return null;
		}

		const meetingValue = as_meeting_value(meetingDoc.value);
		if (meetingValue === null) {
			return null;
		}

		const mapped = await ctx.db
			.query("plugins_data_projection_files")
			.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
				q.eq("installationId", args.installationId).eq("channelKey", args.channelKey).eq("rolloverIndex", 0),
			)
			.first();
		const defaultPath = `${args.folderPath}/${meeting_folder_name(meetingValue.meetingId)}/${MEETING_FILE_NAME}`;

		return {
			path: mapped?.path ?? defaultPath,
			text: plugins_projections_council_build_markdown(meetingValue),
			meetingId: meetingValue.meetingId,
		};
	},
});

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

export { ROOT_FOLDER_PATH, MEETING_FILE_NAME };
