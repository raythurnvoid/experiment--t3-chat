import { mutation, query, type QueryCtx, type MutationCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import { v, type Infer } from "convex/values";
import * as Y from "yjs";
import { sha256 } from "@noble/hashes/sha2";
import { Base64 } from "js-base64";
import { pages_u8_to_array_buffer } from "../shared/pages.js";

type yjs_sync_StreamKey = {
	roomId: string;
	guid: string | null;
};

function yjs_sync_encode_snapshot(doc: Y.Doc): Uint8Array {
	return Y.encodeSnapshot(Y.snapshot(doc));
}

function yjs_sync_snapshot_hash(doc: Y.Doc): string {
	const encodedSnapshot = yjs_sync_encode_snapshot(doc);
	return Base64.fromUint8Array(sha256(encodedSnapshot));
}

function yjs_sync_apply_update(doc: Y.Doc, update: ArrayBuffer) {
	const u8 = new Uint8Array(update);
	Y.applyUpdate(doc, u8);
}

function yjs_sync_encode_state_vector(doc: Y.Doc): Uint8Array {
	return Y.encodeStateVector(doc);
}

function yjs_sync_encode_state_as_update(doc: Y.Doc, stateVector?: ArrayBuffer): Uint8Array {
	return stateVector ? Y.encodeStateAsUpdate(doc, new Uint8Array(stateVector)) : Y.encodeStateAsUpdate(doc);
}

async function yjs_sync_get_head_row(
	ctx: QueryCtx,
	stream: yjs_sync_StreamKey,
): Promise<{
	_id: Id<"pages_yjs_doc_heads">;
	seq: number;
	snapshot_update: ArrayBuffer;
	snapshot_hash: string;
} | null> {
	// Intentionally tolerate duplicates; pick the highest seq.
	const rows = await ctx.db
		.query("pages_yjs_doc_heads")
		.withIndex("by_room_guid", (q) => q.eq("room_id", stream.roomId).eq("guid", stream.guid))
		.collect();

	if (rows.length === 0) return null;

	let best = rows[0]!;
	for (const row of rows) {
		if (row.seq > best.seq) {
			best = row;
		}
	}
	return best;
}

async function yjs_sync_get_or_create_head_row(
	ctx: MutationCtx,
	stream: yjs_sync_StreamKey,
): Promise<{
	_id: Id<"pages_yjs_doc_heads">;
	seq: number;
	snapshot_update: ArrayBuffer;
	snapshot_hash: string;
}> {
	let head = await yjs_sync_get_head_row(ctx, stream);
	if (head) return head;

	const emptyDoc = new Y.Doc();
	const snapshotUpdate = yjs_sync_encode_state_as_update(emptyDoc);
	const snapshotHash = yjs_sync_snapshot_hash(emptyDoc);

	await ctx.db.insert("pages_yjs_doc_heads", {
		room_id: stream.roomId,
		guid: stream.guid,
		seq: 0,
		snapshot_update: pages_u8_to_array_buffer(snapshotUpdate),
		snapshot_hash: snapshotHash,
		updated_at: Date.now(),
	});

	// Re-query and pick the best; tolerate duplicates.
	head = await yjs_sync_get_head_row(ctx, stream);
	if (!head) {
		throw new Error("Failed to create pages_yjs_doc_heads row");
	}
	return head;
}

export const fetch_doc = query({
	args: {
		roomId: v.string(),
		guid: v.union(v.string(), v.null()),
		clientStateVector: v.bytes(),
	},
	returns: v.object({
		update: v.bytes(),
		serverStateVector: v.bytes(),
		remoteSnapshotHash: v.string(),
		latestSeq: v.number(),
	}),
	handler: async (ctx, args) => {
		const stream: yjs_sync_StreamKey = { roomId: args.roomId, guid: args.guid };

		const head = await yjs_sync_get_head_row(ctx, stream);

		const doc = new Y.Doc();
		const headSeq = head?.seq ?? 0;
		const headHash = head?.snapshot_hash ?? yjs_sync_snapshot_hash(doc);

		if (head) {
			yjs_sync_apply_update(doc, head.snapshot_update);
		}

		const diff = yjs_sync_encode_state_as_update(doc, args.clientStateVector);
		const serverVector = yjs_sync_encode_state_vector(doc);

		return {
			update: pages_u8_to_array_buffer(diff),
			serverStateVector: pages_u8_to_array_buffer(serverVector),
			remoteSnapshotHash: headHash,
			latestSeq: headSeq,
		};
	},
});

async function yjs_sync_prune_updates(
	ctx: MutationCtx,
	stream: yjs_sync_StreamKey,
	args: { keepLastN: number; latestSeq: number; maxDeletes: number },
) {
	const threshold = args.latestSeq - args.keepLastN;
	if (threshold <= 0) return;

	const oldRows = await ctx.db
		.query("pages_yjs_updates")
		.withIndex("by_room_guid_and_seq", (q) =>
			q.eq("room_id", stream.roomId).eq("guid", stream.guid).lt("seq", threshold),
		)
		.take(args.maxDeletes);

	for (const row of oldRows) {
		await ctx.db.delete(row._id);
	}
}

export const submit_update = mutation({
	args: {
		roomId: v.string(),
		guid: v.union(v.string(), v.null()),
		update: v.bytes(),
		sessionId: v.string(),
	},
	returns: v.object({
		latestSeq: v.number(),
		remoteSnapshotHash: v.string(),
	}),
	handler: async (ctx, args) => {
		const stream: yjs_sync_StreamKey = { roomId: args.roomId, guid: args.guid };

		const head = await yjs_sync_get_or_create_head_row(ctx, stream);

		const doc = new Y.Doc();
		yjs_sync_apply_update(doc, head.snapshot_update);
		yjs_sync_apply_update(doc, args.update);

		const newSnapshotUpdate = yjs_sync_encode_state_as_update(doc);
		const newSnapshotHash = yjs_sync_snapshot_hash(doc);
		const newSeq = head.seq + 1;

		await ctx.db.insert("pages_yjs_updates", {
			room_id: stream.roomId,
			guid: stream.guid,
			seq: newSeq,
			update: args.update,
			session_id: args.sessionId,
			snapshot_hash: newSnapshotHash,
			created_at: Date.now(),
		});

		await ctx.db.patch(head._id, {
			seq: newSeq,
			snapshot_update: pages_u8_to_array_buffer(newSnapshotUpdate),
			snapshot_hash: newSnapshotHash,
			updated_at: Date.now(),
		});

		// Best-effort pruning to keep the update log bounded.
		if (newSeq % 50 === 0) {
			await yjs_sync_prune_updates(ctx, stream, {
				keepLastN: 512,
				latestSeq: newSeq,
				maxDeletes: 512,
			});
		}

		return { latestSeq: newSeq, remoteSnapshotHash: newSnapshotHash };
	},
});

const tail_updates_validator = v.object({
	latestSeq: v.number(),
	remoteSnapshotHash: v.string(),
	updates: v.array(
		v.object({
			seq: v.number(),
			update: v.bytes(),
			sessionId: v.string(),
			snapshotHash: v.string(),
		}),
	),
});

export type pages_YjsTailUpdates = Infer<typeof tail_updates_validator>;

export const tail_updates = query({
	args: {
		roomId: v.string(),
		guid: v.union(v.string(), v.null()),
		limit: v.number(),
		excludeSessionId: v.optional(v.string()),
	},
	returns: tail_updates_validator,
	handler: async (ctx, args) => {
		const stream: yjs_sync_StreamKey = { roomId: args.roomId, guid: args.guid };

		const head = await yjs_sync_get_head_row(ctx, stream);
		const latestSeq = head?.seq ?? 0;
		const remoteSnapshotHash = head?.snapshot_hash ?? yjs_sync_snapshot_hash(new Y.Doc());

		const changes = await ctx.db
			.query("pages_yjs_updates")
			.withIndex("by_room_guid_and_seq", (q) => q.eq("room_id", args.roomId).eq("guid", args.guid))
			.order("desc")
			.take(args.limit);

		const updatesAsc = changes.reverse().map((row) => ({
			seq: row.seq,
			update: row.update,
			sessionId: row.session_id,
			snapshotHash: row.snapshot_hash,
		}));

		const filtered =
			args.excludeSessionId === undefined
				? updatesAsc
				: updatesAsc.filter((u) => u.sessionId !== args.excludeSessionId);

		return {
			latestSeq,
			remoteSnapshotHash,
			updates: filtered,
		};
	},
});
