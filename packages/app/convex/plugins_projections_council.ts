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
	plugins_projections_next_cursor,
	plugins_projections_skip_already_applied,
} from "./plugins_projections_cursor.ts";
import { plugins_projections_files_are_current } from "./plugins_projections.ts";
import { plugins_projections_is_registered } from "./plugins_projections_registry.ts";

const PRIVATE_KEY_PREFIX = "p/";
const ROOT_FOLDER_PATH = "/meetings";
const MEETING_FILE_NAME = "meeting.md";
const MEETINGS_COLLECTION = "meetings";
const MEETINGS_PER_SYNC = 3;
// Cap the feed work in one action hop. The saved opaque cursor lets the next hop resume at 0 ms.
const CHANGE_PAGES_PER_SYNC = 25;
// Keep the reconcile mutation under Convex's transaction limits for a full-size plugin store.
const RECONCILE_KEYS_PER_SYNC = 200;

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
					"Council could not store the video recording. The file was larger than the workspace can accept. The audio file was still saved.",
				artifacts: [
					{ kind: "track_audio", fileName: "recording-audio.m4a" },
					{ kind: "transcript_markdown", fileName: "transcript.md" },
				],
			});

			expect(markdown).toContain(
				"Council could not store the video recording. The file was larger than the workspace can accept. The audio file was still saved.",
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
	const runStartMs = Date.now();
	const prepared = (await ctx.runMutation(internal.plugins_projections_council.prepare_sync, {
		installationId: args.installationId,
		syncGeneration: args.syncGeneration,
	})) as { _yay?: null; _nay?: { message: string } };
	if (prepared._nay) {
		return;
	}

	const root = (await ctx.runMutation(internal.plugins_projections.ensure_writable_projection_root, {
		installationId: args.installationId,
		syncGeneration: args.syncGeneration,
		preferredPath: ROOT_FOLDER_PATH,
	})) as { _yay?: { folderPath: string }; _nay?: { message: string } };
	if (root._nay || !root._yay) {
		return;
	}

	const folderPath = root._yay.folderPath;

	const dirtyAtHopStart = (await ctx.runQuery(internal.plugins_projections_council.has_dirty_channel, {
		installationId: args.installationId,
	})) as boolean;
	let scanTruncated = false;
	let more = true;
	let pageCount = 0;
	while (more && pageCount < CHANGE_PAGES_PER_SYNC) {
		const page = (await ctx.runMutation(internal.plugins_projections_council.advance_collection_cursor, {
			installationId: args.installationId,
			syncGeneration: args.syncGeneration,
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

	let reconcilePending = dirtyAtHopStart;
	if (!scanTruncated && !dirtyAtHopStart) {
		reconcilePending = (await ctx.runMutation(internal.plugins_projections_council.reconcile_meetings, {
			installationId: args.installationId,
			syncGeneration: args.syncGeneration,
		})) as boolean;
	}

	let processed = 0;
	while (processed < MEETINGS_PER_SYNC) {
		const meeting = (await ctx.runMutation(internal.plugins_projections_council.peek_dirty_channel, {
			installationId: args.installationId,
			syncGeneration: args.syncGeneration,
		})) as { channelKey: string; updatedAt: number } | null;
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
				syncGeneration: args.syncGeneration,
				channelKey: meeting.channelKey,
			});
			await ctx.runMutation(internal.plugins_projections_council.complete_dirty_channel, {
				installationId: args.installationId,
				syncGeneration: args.syncGeneration,
				channelKey: meeting.channelKey,
				updatedAt: meeting.updatedAt,
				files: [],
			});
			processed += 1;
			continue;
		}

		let path = built.path;
		const preflight = (await ctx.runQuery(internal.plugins_projections.get_write_preflight, {
			installationId: args.installationId,
			syncGeneration: args.syncGeneration,
			path,
		})) as {
			_yay?: {
				occupant: { mapped: false; adoptable: boolean } | { mapped: true; channelKey: string } | null;
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

		const written = await ctx
			.runAction(internal.plugins_projections.write_projection_markdown, {
				installationId: args.installationId,
				syncGeneration: args.syncGeneration,
				path,
				text: built.text,
				channelKey: meeting.channelKey,
				rolloverIndex: 0,
			})
			.catch(() => Result({ _nay: { message: "Projection write threw" } }));
		if (written._nay || !written._yay) {
			console.error("Failed to write council meeting projection file", {
				message: written._nay?.message ?? "Projection write failed",
				installationId: args.installationId,
				channelKey: meeting.channelKey,
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

		await ctx.runMutation(internal.plugins_projections_council.complete_dirty_channel, {
			installationId: args.installationId,
			syncGeneration: args.syncGeneration,
			channelKey: meeting.channelKey,
			updatedAt: meeting.updatedAt,
			files: [{ rolloverIndex: 0, path: written._yay.path }],
		});
		processed += 1;
	}

	const moreDirty = (await ctx.runQuery(internal.plugins_projections_council.has_dirty_channel, {
		installationId: args.installationId,
	})) as boolean;

	await ctx.runMutation(internal.plugins_projections.finish_sync, {
		installationId: args.installationId,
		syncGeneration: args.syncGeneration,
		continueImmediately: moreDirty || scanTruncated || reconcilePending,
		continueIfDirty: true,
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
			// The bounded uninstall or hard-delete drain owns cleanup. A stale sync only stops here.
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

		const cursor = state.cursors[MEETINGS_COLLECTION] ?? null;
		const scanCursors = state.scanCursors ?? {};
		const activeScan = scanCursors[MEETINGS_COLLECTION];
		const fromUpdatedAt = activeScan ? activeScan.fromUpdatedAt : cursor?.updatedAt;
		const throughUpdatedAt = activeScan?.throughUpdatedAt ?? args.runStartMs;
		const pageSize = args.pageSize ?? plugins_data_MAX_LIST_PAGE_SIZE;
		// Use Convex's opaque cursor inside one frozen upper bound. A custom `updatedAt` fence cannot
		// move past an arbitrarily large tie without rereading the whole tie in one transaction.
		const rawPage = await ctx.db
			.query("plugins_data")
			.withIndex("by_installation_collection_scope_updatedAt", (q) => {
				const base = q
					.eq("installationId", args.installationId)
					.eq("collection", MEETINGS_COLLECTION)
					.eq("scopeId", undefined);
				return fromUpdatedAt === undefined
					? base.lte("updatedAt", throughUpdatedAt)
					: base.gte("updatedAt", fromUpdatedAt).lte("updatedAt", throughUpdatedAt);
			})
			.order("asc")
			.paginate({ cursor: activeScan?.cursor ?? null, numItems: pageSize });
		const page = plugins_projections_skip_already_applied(rawPage.page, cursor);

		await Promise.all(
			page
				.filter((doc) => !is_private_key(doc.key))
				.map((doc) =>
					db_mark_channel_dirty(ctx, {
						organizationId: state.organizationId,
						workspaceId: state.workspaceId,
						installationId: args.installationId,
						channelKey: doc.key,
					}),
				),
		);

		const lastApplied = page[page.length - 1] ?? null;
		const next = plugins_projections_next_cursor(lastApplied, cursor);
		const { [MEETINGS_COLLECTION]: _finishedScan, ...otherScans } = scanCursors;
		const cursors =
			next !== null && lastApplied !== null
				? {
						...state.cursors,
						[MEETINGS_COLLECTION]: {
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
					[MEETINGS_COLLECTION]: {
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
		// Finish an inherited frozen page set before claiming this run's newer fence is exhausted.
		return Result({ _yay: { truncated: throughUpdatedAt < args.runStartMs } });
	},
});

export const reconcile_meetings = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		keyLimit: v.optional(v.number()),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const state = await db_get_projection_state(ctx, args.installationId);
		if (!state || state.syncGeneration !== args.syncGeneration) {
			return false;
		}

		const mappedKeys = new Set<string>();
		const keyLimit = args.keyLimit ?? RECONCILE_KEYS_PER_SYNC;
		let afterChannelKey = state.reconcileAfterChannelKey;
		let exhausted = false;
		while (mappedKeys.size < keyLimit) {
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
				if (mappedKeys.size === keyLimit) {
					break;
				}
				mappedKeys.add(row.channelKey);
				lastAddedChannelKey = row.channelKey;
			}
			afterChannelKey = mappedKeys.size === keyLimit ? lastAddedChannelKey : rows[rows.length - 1]?.channelKey;
			if (mappedKeys.size === keyLimit) {
				break;
			}
			if (rows.length < plugins_data_MAX_LIST_PAGE_SIZE) {
				exhausted = true;
				break;
			}
		}

		const meetings = await Promise.all(
			[...mappedKeys].map(async (channelKey) => ({
				channelKey,
				doc: await ctx.db
					.query("plugins_data")
					.withIndex("by_installation_collection_key", (q) =>
						q.eq("installationId", args.installationId).eq("collection", MEETINGS_COLLECTION).eq("key", channelKey),
					)
					.first(),
			})),
		);
		await Promise.all(
			meetings
				.filter(
					({ channelKey, doc }) =>
						doc === null ||
						doc.scopeId !== undefined ||
						is_private_key(channelKey) ||
						as_meeting_value(doc.value) === null,
				)
				.map(({ channelKey }) =>
					db_mark_channel_dirty(ctx, {
						organizationId: state.organizationId,
						workspaceId: state.workspaceId,
						installationId: args.installationId,
						channelKey,
					}),
				),
		);

		await ctx.db.patch("plugins_data_projection_states", state._id, {
			reconcileAfterChannelKey: exhausted ? undefined : afterChannelKey,
			updatedAt: Date.now(),
		});

		return !exhausted;
	},
});

/**
 * Claim the oldest Council row before the action attempts it.
 *
 * Move the row to the tail in its own transaction. A failed or thrown file rebuild then leaves
 * later meetings at the front instead of blocking the whole installation behind one bad path.
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

export const complete_dirty_channel = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		channelKey: v.string(),
		updatedAt: v.number(),
		files: v.array(v.object({ rolloverIndex: v.number(), path: v.string() })),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await db_get_projection_state(ctx, args.installationId);
		if (!state || state.syncGeneration !== args.syncGeneration) {
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
		});
		if (dirty && dirty.updatedAt === args.updatedAt && filesCurrent) {
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
		// Make every mark visible to the completion stamp even when two writes share one clock tick.
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

export { ROOT_FOLDER_PATH, MEETING_FILE_NAME };
