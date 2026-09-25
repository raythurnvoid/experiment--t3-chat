import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_create_saved_text_file, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_transfer_db_prepare_copy_item } from "./files_transfer.ts";
import { files_transfer_media_db_map_refs } from "./files_transfer_media.ts";
import { r2_server_side_copy, r2_create_asset_key } from "./r2_client.ts";
import { files_media_build_file_src, files_media_build_private_src } from "../shared/files-media.ts";
import type { files_PendingTarget } from "../shared/files.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import {
	files_headless_tiptap_editor_create,
	files_headless_tiptap_editor_get_markdown,
	files_yjs_doc_create_from_text,
	files_yjs_doc_get_text,
} from "../shared/files-tiptap.ts";
import { files_transfer_rewrite_media_refs } from "../server/files-transfer-media.ts";

const objects = new Map<string, BodyInit>();

beforeEach(() => {
	vi.useFakeTimers();
	objects.clear();
	let workCount = 0;
	vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(async () => `media-copy-${++workCount}` as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
		const body = objects.get(args.sourceKey)!;
		objects.set(args.destinationKey, body);
		return { outcome: "copied", size: (await new Response(body).arrayBuffer()).byteLength, etag: "copied" };
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			const key = url.searchParams.get("key") ?? "";
			if (url.pathname === "/upload" && init?.method === "PUT") {
				objects.set(key, init.body ?? "");
				return new Response(null, { status: 200 });
			}
			const body = objects.get(key);
			return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
		}),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function create_media(
	t: ReturnType<typeof test_convex>,
	scope: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		membershipId: Id<"organizations_workspaces_users">;
	},
	path = "/photo.png",
) {
	const prepared = await t.mutation(internal.files_ingestion.prepare_file, {
		...scope,
		requestId: `${scope.workspaceId}:${path}`,
		attemptId: "media-attempt",
		path,
		size: 4,
		contentType: path.endsWith(".mp4") ? "video/mp4" : "image/png",
		digest: "a".repeat(64),
		content: { kind: "stored" },
	});
	if (prepared._nay || prepared._yay.kind !== "stored") throw new Error("Expected stored media");
	objects.set(prepared._yay.r2Key, new Uint8Array([1, 2, 3, 4]));
	const completed = await t.mutation(internal.files_ingestion.finalize_file, {
		...scope,
		receiptId: prepared._yay.receiptId,
		attemptId: "media-attempt",
	});
	if (completed._nay) throw new Error(completed._nay.message);
	return { target: completed._yay.target, assetId: prepared._yay.assetId };
}

async function save_media(
	t: ReturnType<typeof test_convex>,
	membershipId: Id<"organizations_workspaces_users">,
	userId: Id<"users">,
	target: files_PendingTarget,
) {
	// Keep large real Save sequences within the public rate limit without running cleanup timers.
	vi.setSystemTime(Date.now() + 1500);
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: userId });
	const view = await asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target });
	if (!view?.entry.pendingUpdate) throw new Error("Expected media proposal");
	const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
		membershipId,
		target,
		pendingUpdateId: view.entry.pendingUpdate._id,
		reviewedRevision: view.entry.pendingUpdate.revision,
	});
	if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected saved media");
	return saved._yay.target;
}

async function fixture(
	options: {
		sourceWorkspace?: "current" | "personal";
		sourceKind?: "saved" | "private";
		selected?: boolean;
		replacement?: boolean;
		video?: boolean;
		documentReplacement?: boolean;
		documentText?: (src: string) => string;
		mediaCount?: number;
		aliases?: boolean;
	} = {},
) {
	const t = test_convex({ transactionLimits: true });
	const owner = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "media-team", workspaceName: "home" }),
	);
	const personal = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
	);
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
	expect(
		await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userIdToAdd: personal.userId,
		}),
	).toEqual({ _yay: null });
	const membership = await t.run((ctx) =>
		ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_workspace_user_active", (q) =>
				q.eq("workspaceId", owner.workspaceId).eq("userId", personal.userId).eq("active", true),
			)
			.first(),
	);
	if (!membership) throw new Error("Expected team membership");
	const current = { ...owner, userId: personal.userId, membershipId: membership._id };
	const sourceWorkspace = options.sourceWorkspace ?? "current";
	const source = sourceWorkspace === "current" ? current : personal;
	const destination = sourceWorkspace === "current" ? personal : current;
	const media = await create_media(t, source, options.video ? "/clip.mp4" : "/photo.png");
	const original = media.target;
	if (options.sourceKind !== "private")
		media.target = await save_media(t, source.membershipId, source.userId, media.target);
	const sourceRef =
		media.target.kind === "saved"
			? files_media_build_file_src(media.target.id)
			: files_media_build_private_src(media.target.id);
	const mediaFiles = [media];
	const sourceRefs = [sourceRef];
	if (options.aliases && original.kind === "private") sourceRefs.push(files_media_build_private_src(original.id));
	for (let index = 1; index < (options.mediaCount ?? 1); index++) {
		const extra = await create_media(t, source, `/photo-${index}.png`);
		extra.target = await save_media(t, source.membershipId, source.userId, extra.target);
		mediaFiles.push(extra);
		sourceRefs.push(files_media_build_file_src(extra.target.id));
	}
	const documentText =
		options.documentText?.(sourceRef) ??
		`Before\n\n${sourceRefs.map((src) => `![Photo](${src})`).join("\n\n")}\n\nAfter\n`;
	const documentId = await test_create_saved_text_file(t, {
		membershipId: source.membershipId,
		path: "/document.md",
		textContent: documentText,
	});
	if (options.documentReplacement)
		await test_create_saved_text_file(t, {
			membershipId: destination.membershipId,
			path: "/document.md",
			textContent: "Destination\n",
		});
	const occupant = options.replacement ? await create_media(t, destination) : null;
	const savedOccupant = occupant
		? await save_media(t, destination.membershipId, destination.userId, occupant.target)
		: null;
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: personal.userId });
	const thread = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: current.membershipId,
		clientGeneratedId: "media-copy-chat",
		lastMessageAt: Date.now(),
	});
	if (thread._nay) throw new Error(thread._nay.message);
	const sources: files_PendingTarget[] = [
		{ kind: "saved", id: documentId },
		...(options.selected === false ? [] : mediaFiles.map((file) => file.target)),
	];
	const started = await t.mutation(internal.files_transfer.start_for_agent, {
		membershipId: current.membershipId,
		threadId: thread._yay.threadId,
		sourceWorkspace,
		destinationWorkspace: sourceWorkspace === "current" ? "personal" : "current",
		requestId: "media-copy",
		kind: "copy",
		expectedSourceCount: sources.length,
		sources: sources.slice(0, 100),
		targetParent: { kind: "root" },
		targetPath: "/",
		targetName: null,
		missingParentNames: [],
		conflictPolicy: { file: "replace", folder: "error" },
	});
	if (started._nay) throw new Error(started._nay.message);
	for (let offset = 100; offset < sources.length; offset += 100)
		expect(
			await t.mutation(internal.files_transfer.append_sources_for_agent, {
				membershipId: current.membershipId,
				threadId: thread._yay.threadId,
				runId: started._yay.runId,
				offset,
				sources: sources.slice(offset, offset + 100),
			}),
		).toEqual({ _yay: null });
	expect(
		await t.mutation(internal.files_transfer.seal_for_agent, {
			membershipId: current.membershipId,
			threadId: thread._yay.threadId,
			runId: started._yay.runId,
		}),
	).toEqual({ _yay: null });
	for (let step = 0; step < 24 + sources.length * 4; step++) {
		await t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
		const items = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
				.collect(),
		);
		const document = items.find((item) => item.source.id === documentId);
		const selectedMedia = items.find((item) => item.source.id === media.target.id);
		if (document?.workId)
			return {
				t,
				owner,
				source,
				destination,
				current,
				asUser,
				asOwner,
				document,
				selectedMedia,
				selectedMediaItems: items.filter((item) => item.source.id !== documentId),
				sourceRefs,
				documentText,
				media,
				original,
				sourceRef,
				savedOccupant,
				occupant,
			};
		for (const selectedMedia of items.filter(
			(item) => item.source.id !== documentId && item.state === "copying" && item.workId,
		)) {
			await t.action(internal.files_nodes_content.copy_transfer_file, {
				itemId: selectedMedia._id,
				attempt: selectedMedia.attempt,
			});
			await t.mutation(internal.files_transfer.handle_copy_complete, {
				workId: selectedMedia.workId!,
				context: { itemId: selectedMedia._id, attempt: selectedMedia.attempt },
				result: { kind: "success", returnValue: null },
			});
		}
	}
	throw new Error("Document worker did not start");
}

async function map_refs(f: Awaited<ReturnType<typeof fixture>>, refs = [f.sourceRef]) {
	return await f.t.run(async (ctx) => {
		const prepared = await files_transfer_db_prepare_copy_item(ctx, {
			itemId: f.document._id,
			attempt: f.document.attempt,
			workId: f.document.workId!,
		});
		if (prepared._nay || !prepared._yay) return prepared;
		return await files_transfer_media_db_map_refs(ctx, { prepared: prepared._yay, refs });
	});
}

async function read_dependencies(
	t: ReturnType<typeof test_convex>,
	setId: Id<"files_media_dependency_sets"> | undefined,
) {
	expect(setId).toBeDefined();
	return await t.run(async (ctx) =>
		(
			await ctx.db
				.query("files_media_dependencies")
				.withIndex("by_set_order", (q) => q.eq("setId", setId!))
				.collect()
		).map((row) => row.dependency),
	);
}

async function prepare_document_capture(f: Awaited<ReturnType<typeof fixture>>) {
	const claim = { itemId: f.document._id, attempt: f.document.attempt, workId: f.document.workId! };
	const captured = await f.t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, {
		itemId: f.document._id,
		attempt: f.document.attempt,
	});
	if (captured._nay) throw new Error(captured._nay.message);
	const editor = files_headless_tiptap_editor_create({ initialContent: { markdown: f.documentText } });
	if (editor._nay) throw new Error(editor._nay.message);
	const referenceMap = new Map<string, string>();
	let text: string;
	try {
		const sourceTextDigest = await crypto_sha256_hex(
			files_headless_tiptap_editor_get_markdown({ mut_editor: editor._yay }),
		);
		const refs =
			files_transfer_rewrite_media_refs({ mut_editor: editor._yay, referenceMap: new Map() })._nay?.data
				.unresolvedRefs ?? [];
		for (let offset = 0; offset < Math.max(1, refs.length); offset += 50) {
			const args = {
				...claim,
				sourceTextDigest,
				expectedCount: refs.length,
				offset,
				refs: refs.slice(offset, offset + 50),
			};
			const page = await f.t.mutation(internal.files_nodes_content.prepare_transfer_file_media, args);
			if (page._nay || !page._yay) throw new Error(page._nay?.message ?? "Expected mappings");
			expect(await f.t.mutation(internal.files_nodes_content.prepare_transfer_file_media, args)).toEqual(page);
			for (const mapping of page._yay) referenceMap.set(mapping.sourceSrc, mapping.dependency.src);
		}
		expect(files_transfer_rewrite_media_refs({ mut_editor: editor._yay, referenceMap })).toEqual({ _yay: null });
		text = files_headless_tiptap_editor_get_markdown({ mut_editor: editor._yay });
	} finally {
		editor._yay.destroy();
	}
	const document = files_yjs_doc_create_from_text({ text, rootKind: "rich_text" });
	if ("_nay" in document) throw new Error(document._nay.message);
	try {
		const normalized = files_yjs_doc_get_text({ yjsDoc: document, rootKind: "rich_text" });
		if (normalized._nay) throw new Error(normalized._nay.message);
		text = normalized._yay;
	} finally {
		document.destroy();
	}
	const staged = await f.t.mutation(internal.files_nodes_content.stage_transfer_file_copy_assets, {
		...claim,
		contentSize: new TextEncoder().encode(text).byteLength,
	});
	if (staged._nay || !staged._yay) throw new Error(staged._nay?.message ?? "Expected capture assets");
	objects.set(r2_create_asset_key({ ...f.destination, assetId: staged._yay.contentAssetId }), text);
	const args = { ...claim, ...staged._yay, text };
	expect(await f.t.mutation(internal.files_nodes_content.seal_transfer_file_capture, args)).toEqual({ _yay: null });
	return args;
}

async function finish_document(f: Awaited<ReturnType<typeof fixture>>) {
	await f.t.mutation(internal.files_transfer.handle_copy_complete, {
		workId: f.document.workId!,
		context: { itemId: f.document._id, attempt: f.document.attempt },
		result: { kind: "success", returnValue: null },
	});
	await f.t.mutation(internal.files_transfer.advance, { runId: f.document.runId });
}

async function copy_again(f: Awaited<ReturnType<typeof fixture>>, source: files_PendingTarget, targetName: string) {
	const thread = await f.asUser.mutation(api.ai_chat.thread_create, {
		membershipId: f.destination.membershipId,
		clientGeneratedId: `again-${targetName}`,
		lastMessageAt: Date.now(),
	});
	if (thread._nay) throw new Error(thread._nay.message);
	const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
		membershipId: f.destination.membershipId,
		threadId: thread._yay.threadId,
		sourceWorkspace: "current",
		destinationWorkspace: "current",
		requestId: `again-${targetName}`,
		kind: "copy",
		expectedSourceCount: 1,
		sources: [source],
		targetParent: { kind: "root" },
		targetPath: "/",
		targetName,
		missingParentNames: [],
		conflictPolicy: { file: "replace", folder: "error" },
	});
	if (started._nay) throw new Error(started._nay.message);
	expect(
		await f.t.mutation(internal.files_transfer.seal_for_agent, {
			membershipId: f.destination.membershipId,
			threadId: thread._yay.threadId,
			runId: started._yay.runId,
		}),
	).toEqual({ _yay: null });
	for (let step = 0; step < 24; step++) {
		await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
		const item = await f.t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
				.unique(),
		);
		if (!item?.workId) continue;
		const sourceHolds = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_holds")
				.withIndex("by_target_role", (q) =>
					q.eq("target.kind", source.kind).eq("target.id", source.id).eq("role", "source"),
				)
				.collect(),
		);
		const sourceHold = sourceHolds.find((hold) => hold.producer.id === item.runId);
		if (source.kind === "private") expect(sourceHold).toBeDefined();
		await f.t.action(internal.files_nodes_content.copy_transfer_file, { itemId: item._id, attempt: item.attempt });
		const completed = await f.t.run((ctx) => ctx.db.get("files_transfer_items", item._id));
		expect(completed?.state).toBe("completed");
		if (sourceHold) {
			const held = await f.t.run((ctx) => ctx.db.get("files_pending_holds", sourceHold._id));
			if (completed!.capture!.sourceVersion.textKind === null) expect(held).toEqual(sourceHold);
			else expect(held).toBeNull();
		}
		return await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q
						.eq("userId", f.destination.userId)
						.eq("target.kind", completed!.outputTarget!.kind)
						.eq("target.id", completed!.outputTarget!.id),
				)
				.unique(),
		);
	}
	throw new Error("Second Copy did not start");
}

describe("files_transfer_media_db_map_refs", () => {
	test.each(["current", "personal"] as const)(
		"maps saved %s media to the ready destination draft",
		async (sourceWorkspace) => {
			const f = await fixture({ sourceWorkspace, video: sourceWorkspace === "personal" });
			const result = await map_refs(f, [f.sourceRef, f.sourceRef, "https://example.test/external.png"]);
			if (!result._yay || !("referencePairs" in result._yay)) throw new Error("Expected mappings");
			const output = f.selectedMedia!.outputTarget!;
			const destinationRef = files_media_build_private_src(output.id);
			expect(new Map(result._yay.referencePairs)).toEqual(new Map([[f.sourceRef, destinationRef]]));
			expect(result._yay.mediaDependencies).toEqual([
				expect.objectContaining({
					src: destinationRef,
					target: output,
					assetId: expect.any(String),
					version: expect.objectContaining({
						kind: "pending",
						contentType: sourceWorkspace === "personal" ? "video/mp4" : "image/png",
						textKind: null,
					}),
				}),
			]);
			expect(result._yay.mediaDependencies[0]!.assetId).not.toBe(f.media.assetId);
			expect(result._yay.mediaDependencies[0]!.assetId).toBe(f.selectedMedia!.outputMediaAssetId);
			expect(f.selectedMedia!.capture!.artifact).toBeNull();
		},
	);

	test("maps a selected active private source and its exact spelling", async () => {
		const f = await fixture({ sourceKind: "private" });
		expect(await map_refs(f)).toMatchObject({
			_yay: {
				referencePairs: [[f.sourceRef, files_media_build_private_src(f.selectedMedia!.outputTarget!.id)]],
			},
		});
	});

	test("finds the selected saved source through its published private origin", async () => {
		const f = await fixture();
		const privateRef = files_media_build_private_src(f.original.id);
		const result = await map_refs(f, [privateRef]);
		expect(result).toMatchObject({
			_yay: { referencePairs: [[privateRef, files_media_build_private_src(f.selectedMedia!.outputTarget!.id)]] },
		});
	});

	test("uses the actor's stored replacement asset instead of the saved destination bytes", async () => {
		const f = await fixture({ replacement: true });
		const result = await map_refs(f);
		if (!result._yay || !("mediaDependencies" in result._yay)) throw new Error("Expected mappings");
		const dependency = result._yay.mediaDependencies[0]!;
		expect(dependency).toMatchObject({
			target: f.savedOccupant,
			src: files_media_build_file_src(f.savedOccupant!.id),
			version: { kind: "pending" },
		});
		expect(dependency.assetId).not.toBe(f.occupant!.assetId);
		expect(dependency.assetId).not.toBe(f.media.assetId);
		expect(dependency.assetId).toBe(f.selectedMedia!.outputMediaAssetId);
	});

	test("finds a selected private source after it is saved under its stable origin", async () => {
		const f = await fixture({ sourceKind: "private" });
		const saved = await save_media(f.t, f.source.membershipId, f.source.userId, f.media.target);
		const savedRef = files_media_build_file_src(saved.id);
		expect(await map_refs(f, [savedRef, f.sourceRef])).toMatchObject({
			_yay: {
				referencePairs: [
					[savedRef, files_media_build_private_src(f.selectedMedia!.outputTarget!.id)],
					[f.sourceRef, files_media_build_private_src(f.selectedMedia!.outputTarget!.id)],
				],
			},
		});
	});

	test("keeps the destination private ref after that media is saved", async () => {
		const f = await fixture();
		await save_media(f.t, f.destination.membershipId, f.destination.userId, f.selectedMedia!.outputTarget!);
		expect(await map_refs(f)).toMatchObject({
			_yay: {
				mediaDependencies: [
					{
						src: files_media_build_private_src(f.selectedMedia!.outputTarget!.id),
						target: f.selectedMedia!.outputTarget,
						version: { kind: "asset" },
					},
				],
			},
		});
	});

	test("keeps unselected media errors name-free and checks access first", async () => {
		const f = await fixture({ selected: false });
		expect(await map_refs(f)).toEqual({
			_nay: { message: "Select the linked image or video files with this document" },
		});
		expect(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.owner.membershipId,
				nodeId: f.media.target.id as Id<"files_nodes">,
			}),
		).toEqual({ _yay: null });
		expect(await map_refs(f)).toEqual({ _nay: { message: "A linked media file is not available" } });
	});

	test("transfer history does not retain a linked media path after access is revoked", async () => {
		const f = await fixture({ selected: false });
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		await f.t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: f.document.workId!,
			context: { itemId: f.document._id, attempt: f.document.attempt },
			result: { kind: "success", returnValue: null },
		});
		await f.t.mutation(internal.files_transfer.advance, { runId: f.document.runId });
		expect(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.owner.membershipId,
				nodeId: f.media.target.id as Id<"files_nodes">,
			}),
		).toEqual({ _yay: null });
		const args = { membershipId: f.current.membershipId, runId: f.document.runId };
		const view = await f.asUser.query(api.files_transfer.get, args);
		const items = await f.asUser.query(api.files_transfer.list_items, {
			...args,
			paginationOpts: { cursor: null, numItems: 20 },
		});
		expect(view?.activity).toMatchObject({ status: "failed", errorCode: "copy_failed" });
		expect(items?.page).toHaveLength(1);
		expect(JSON.stringify({ view, items })).not.toContain("/photo.png");
	});

	test("rejects wrong-scope and wrong-table references without names", async () => {
		const f = await fixture();
		for (const ref of [
			files_media_build_private_src(f.selectedMedia!.outputTarget!.id),
			files_media_build_file_src(f.media.assetId),
			"bonobo-file://not-an-id",
		])
			expect(await map_refs(f, [ref])).toEqual({ _nay: { message: "A linked media file is not available" } });
	});

	test.each(["failed", "copying", "skipped"] as const)("refuses a selected %s item", async (state) => {
		const f = await fixture();
		await f.t.run((ctx) => ctx.db.patch("files_transfer_items", f.selectedMedia!._id, { state }));
		expect(await map_refs(f)).toEqual({
			_nay: { message: "A selected image or video file has not finished copying" },
		});
	});

	test.each([
		"unfinalized",
		"retired",
		"wrong scope",
		"wrong owner",
		"wrong size",
		"missing hold",
		"settled hold",
		"wrong key",
		"preparing",
		"discarded",
	] as const)("refuses destination media with %s", async (fault) => {
		const f = await fixture();
		const target = f.selectedMedia!.outputTarget!;
		await f.t.run(async (ctx) => {
			const pending = await ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", f.destination.userId).eq("target.kind", target.kind).eq("target.id", target.id),
				)
				.first();
			if (pending!.createIntent!.kind !== "stored") throw new Error("Expected stored draft");
			const assetId = pending!.createIntent!.assetId;
			const hold = await ctx.db
				.query("files_private_storage_reservations")
				.withIndex("by_resource", (q) => q.eq("resource.kind", "asset").eq("resource.id", assetId))
				.first();
			if (fault === "unfinalized") await ctx.db.patch("files_r2_assets", assetId, { unfinalizedExpiresAt: Date.now() });
			if (fault === "retired") await ctx.db.patch("files_r2_assets", assetId, { uploadRetiredAt: Date.now() });
			if (fault === "wrong scope")
				await ctx.db.patch("files_r2_assets", assetId, {
					organizationId: f.source.organizationId,
					workspaceId: f.source.workspaceId,
				});
			if (fault === "wrong owner") await ctx.db.patch("files_r2_assets", assetId, { createdBy: f.owner.userId });
			if (fault === "wrong size") await ctx.db.patch("files_r2_assets", assetId, { size: 5 });
			if (fault === "missing hold") await ctx.db.delete("files_private_storage_reservations", hold!._id);
			if (fault === "settled hold")
				await ctx.db.patch("files_private_storage_reservations", hold!._id, {
					settlement: { kind: "saved", savedNodeId: f.document.source.id as Id<"files_nodes">, settledAt: Date.now() },
				});
			if (fault === "wrong key")
				await ctx.db.patch("files_private_storage_reservations", hold!._id, {
					resource: { kind: "asset", id: assetId, r2Key: "wrong-key" },
				});
			if (fault === "preparing")
				await ctx.db.patch("files_pending_updates", pending!._id, {
					preparation: { transferItemId: f.selectedMedia!._id, creationGeneration: 1 },
				});
			if (fault === "discarded")
				await ctx.db.patch("files_pending_nodes", target.id as Id<"files_pending_nodes">, { state: "discarded" });
		});
		expect(await map_refs(f)).toEqual({ _nay: { message: "A copied media file is no longer ready or readable" } });
	});

	test("refuses an oversized page before resolving refs", async () => {
		const f = await fixture();
		expect(
			await map_refs(
				f,
				Array.from({ length: 51 }, () => f.sourceRef),
			),
		).toEqual({ _nay: { message: "Invalid media selection page" } });
	});
});

describe("copy_transfer_file media", () => {
	test("reuses mappings after a lost seal reply and rejects the old attempt proof", async () => {
		const f = await fixture();
		const capture = await prepare_document_capture(f);
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, {
				itemId: capture.itemId,
				attempt: capture.attempt,
				workId: capture.workId,
				text: capture.text,
				offset: 0,
			}),
		).toEqual({ _yay: { offset: 1, isDone: true } });
		const before = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		const setId = before!.capture!.mediaDependencySetId!;
		const mappings = await read_dependencies(f.t, setId);
		await f.t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: capture.workId,
			context: { itemId: capture.itemId, attempt: capture.attempt },
			result: { kind: "failed", error: "Lost seal response" },
		});
		await f.t.mutation(internal.files_transfer.advance, { runId: f.document.runId });
		const retried = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		expect(retried!.attempt).toBe(capture.attempt + 1);
		expect(retried!.capture).toEqual(before!.capture);
		expect(
			await f.t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, {
				...capture,
				attempt: retried!.attempt,
				workId: retried!.workId!,
			}),
		).toHaveProperty("_nay");
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: retried!._id,
			attempt: retried!.attempt,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "completed",
		});
		expect(await read_dependencies(f.t, setId)).toEqual(mappings);
		const adopted = await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId));
		expect(adopted).toMatchObject({ owner: { kind: "proposal" } });
		await f.t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: capture.workId,
			context: { itemId: capture.itemId, attempt: capture.attempt },
			result: { kind: "failed", error: "Late old callback" },
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toEqual(adopted);
	});

	test("retires a saved clipboard copy's set without deleting its media", async () => {
		const f = await fixture();
		expect(
			await f.asUser.mutation(api.files_transfer.stop, {
				membershipId: f.current.membershipId,
				runId: f.document.runId,
			}),
		).toEqual({ _yay: null });
		await finish_document(f);
		const folder = await f.asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.source.membershipId,
			parentId: "root",
			path: "/copies",
		});
		if (folder._nay) throw new Error(folder._nay.message);
		const started = await f.asUser.mutation(api.files_transfer.start, {
			membershipId: f.source.membershipId,
			requestId: "clipboard-media",
			kind: "copy",
			expectedSourceCount: 1,
			sourceIds: [f.document.source.id as Id<"files_nodes">],
			targetParentId: folder._yay.nodeId,
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await f.asUser.mutation(api.files_transfer.seal, {
				membershipId: f.source.membershipId,
				runId: started._yay.runId,
			}),
		).toEqual({ _yay: null });
		for (let step = 0; step < 24; step++) {
			await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
			const item = await f.t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
					.unique(),
			);
			if (!item?.workId) continue;
			await f.t.action(internal.files_nodes_content.copy_transfer_file, { itemId: item._id, attempt: item.attempt });
			const completed = await f.t.run((ctx) => ctx.db.get("files_transfer_items", item._id));
			expect(completed).toMatchObject({ state: "completed", outputTarget: { kind: "saved" } });
			const setId = completed!.capture!.mediaDependencySetId!;
			expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toMatchObject({
				owner: { kind: "cleanup" },
				count: 1,
			});
			await f.t.mutation(internal.files_media_dependencies.cleanup_set, { setId });
			expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toBeNull();
			expect(await f.t.run((ctx) => ctx.db.get("files_r2_assets", f.media.assetId))).not.toBeNull();
			return;
		}
		throw new Error("Clipboard Copy did not start");
	});

	test("requires a validation page even for an empty media set", async () => {
		const f = await fixture({ selected: false, documentText: () => "No media\n" });
		const capture = await prepare_document_capture(f);
		expect(await f.t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, capture)).toHaveProperty(
			"_nay",
		);
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "copying",
			outputTarget: null,
		});
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, {
				itemId: capture.itemId,
				attempt: capture.attempt,
				workId: capture.workId,
				text: capture.text,
				offset: 0,
			}),
		).toEqual({ _yay: { offset: 0, isDone: true } });
		expect(await f.t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, capture)).toEqual({
			_yay: null,
		});
	});

	test("does not repin media replaced between validation pages", async () => {
		const f = await fixture({ mediaCount: 51 });
		const capture = await prepare_document_capture(f);
		const validate = { itemId: capture.itemId, attempt: capture.attempt, workId: capture.workId, text: capture.text };
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 0 }),
		).toEqual({ _yay: { offset: 50, isDone: false } });
		const other = await create_media(f.t, f.destination, "/other.png");
		const replacement = await copy_again(f, other.target, "photo.png");
		if (replacement?.createIntent?.kind !== "stored") throw new Error("Expected replacement media");
		expect(replacement.createIntent.assetId).not.toBe(f.selectedMedia!.outputMediaAssetId);
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 50 }),
		).toHaveProperty("_nay");
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 0 }),
		).toMatchObject({ _nay: { message: "The copied media changed while this document was being copied. Try again." } });
		expect(await f.t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, capture)).toHaveProperty(
			"_nay",
		);
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "copying",
			outputTarget: null,
		});
		expect(
			await f.t.run((ctx) =>
				ctx.db.get(
					"files_r2_assets",
					replacement.createIntent!.kind === "stored" ? replacement.createIntent!.assetId : other.assetId,
				),
			),
		).not.toBeNull();
	}, 120_000);

	test("rejects a source ACL change after the media proof is sealed", async () => {
		const f = await fixture();
		const capture = await prepare_document_capture(f);
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, {
				itemId: capture.itemId,
				attempt: capture.attempt,
				workId: capture.workId,
				text: capture.text,
				offset: 0,
			}),
		).toEqual({ _yay: { offset: 1, isDone: true } });
		expect(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.owner.membershipId,
				nodeId: f.media.target.id as Id<"files_nodes">,
			}),
		).toEqual({ _yay: null });
		expect(await f.t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, capture)).toMatchObject({
			_nay: { message: "Media access changed during validation. Try again." },
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "copying",
			outputTarget: null,
		});
	});

	test.each(["source", "destination"] as const)(
		"rejects %s media Archive after a sealed proof",
		async (changedSide) => {
			const f = await fixture();
			const savedMedia =
				changedSide === "destination"
					? await save_media(f.t, f.destination.membershipId, f.destination.userId, f.selectedMedia!.outputTarget!)
					: null;
			const capture = await prepare_document_capture(f);
			const validation = {
				itemId: capture.itemId,
				attempt: capture.attempt,
				workId: capture.workId,
				text: capture.text,
				offset: 0,
			};
			expect(await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, validation)).toEqual({
				_yay: { offset: 1, isDone: true },
			});
			const nodeId = changedSide === "source" ? (f.media.target.id as Id<"files_nodes">) : savedMedia!.id;
			const membershipId = changedSide === "source" ? f.source.membershipId : f.destination.membershipId;
			expect(await f.asUser.mutation(api.files_nodes.archive_nodes, { membershipId, nodeIds: [nodeId] })).toEqual({
				_yay: null,
			});
			const archived = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
			expect(archived).not.toBeNull();
			expect(archived!.archiveOperationId).not.toBeNull();
			expect(await f.t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, capture)).toMatchObject({
				_nay: { message: "Media access changed during validation. Try again." },
			});
			expect(await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, validation)).toHaveProperty(
				"_nay",
			);
			expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
				state: "copying",
				outputTarget: null,
			});
		},
	);

	test("clones a same-workspace dependency set in pages without sharing its owner", async () => {
		const f = await fixture({ mediaCount: 51 });
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		await finish_document(f);
		const original = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		const setId = original!.capture!.mediaDependencySetId!;
		const before = await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId));
		const clone = await copy_again(f, original!.outputTarget!, "cloned.md");
		expect(clone!.mediaDependencySetId).not.toBe(setId);
		expect(await read_dependencies(f.t, clone!.mediaDependencySetId)).toEqual(await read_dependencies(f.t, setId));
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toEqual(before);
		expect(
			await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", clone!.mediaDependencySetId!)),
		).toMatchObject({ count: 51, owner: { kind: "proposal", pendingUpdateId: clone!._id } });
	}, 120_000);

	test("retires the old set when a document replacement is replaced again", async () => {
		const f = await fixture({ documentReplacement: true });
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		await finish_document(f);
		const original = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		const setId = original!.capture!.mediaDependencySetId!;
		const before = await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId));
		const source = await test_create_saved_text_file(f.t, {
			membershipId: f.destination.membershipId,
			path: "/new-source.md",
			textContent: "No media now\n",
		});
		const replacement = await copy_again(f, { kind: "saved", id: source }, "document.md");
		expect(replacement!.target).toEqual(original!.outputTarget);
		expect(replacement!.mediaDependencySetId).not.toBe(setId);
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toMatchObject({
			owner: { kind: "cleanup" },
			generation: before!.generation + 1,
		});
		expect(await read_dependencies(f.t, replacement!.mediaDependencySetId)).toEqual([]);
		await f.t.mutation(internal.files_media_dependencies.cleanup_set, { setId });
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_r2_assets", f.selectedMedia!.outputMediaAssetId!))).not.toBeNull();
	});

	test("Stop fences a sealed capture and keeps completed media assets", async () => {
		const f = await fixture();
		const capture = await prepare_document_capture(f);
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, {
				itemId: capture.itemId,
				attempt: capture.attempt,
				workId: capture.workId,
				text: capture.text,
				offset: 0,
			}),
		).toEqual({ _yay: { offset: 1, isDone: true } });
		const item = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		const setId = item!.capture!.mediaDependencySetId!;
		expect(
			await f.asUser.mutation(api.files_transfer.stop, {
				membershipId: f.current.membershipId,
				runId: f.document.runId,
			}),
		).toEqual({ _yay: null });
		await f.t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, capture);
		await f.t.mutation(internal.files_transfer.advance, { runId: f.document.runId });
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			outputTarget: null,
		});
		await f.t.mutation(internal.files_media_dependencies.cleanup_set, { setId });
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_r2_assets", f.selectedMedia!.outputMediaAssetId!))).not.toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.selectedMedia!._id))).toMatchObject({
			state: "completed",
			outputTarget: f.selectedMedia!.outputTarget,
		});
	});

	test("rejects a source ACL change after the first validation page without changing P", async () => {
		const f = await fixture({ mediaCount: 51 });
		const capture = await prepare_document_capture(f);
		const validate = { itemId: capture.itemId, attempt: capture.attempt, workId: capture.workId, text: capture.text };
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 0 }),
		).toEqual({ _yay: { offset: 50, isDone: false } });
		const pendingVersions = await f.t.run((ctx) => ctx.db.query("files_pending_review_versions").collect());
		expect(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.owner.membershipId,
				nodeId: f.media.target.id as Id<"files_nodes">,
			}),
		).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_review_versions").collect())).toEqual(pendingVersions);
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 50 }),
		).toMatchObject({ _nay: { message: "Media access changed during validation. Try again." } });
		expect(await f.t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, capture)).toHaveProperty(
			"_nay",
		);
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "copying",
			outputTarget: null,
		});
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 0 }),
		).toMatchObject({ _nay: { message: "A linked media file is not available" } });
		for (const media of f.selectedMediaItems)
			expect(await f.t.run((ctx) => ctx.db.get("files_r2_assets", media.outputMediaAssetId!))).not.toBeNull();
	}, 120_000);

	test("rechecks pages after media Save and binds final adoption to exact text", async () => {
		const f = await fixture({ mediaCount: 51 });
		const capture = await prepare_document_capture(f);
		const validate = { itemId: capture.itemId, attempt: capture.attempt, workId: capture.workId, text: capture.text };
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 0 }),
		).toEqual({ _yay: { offset: 50, isDone: false } });
		await save_media(f.t, f.destination.membershipId, f.destination.userId, f.selectedMedia!.outputTarget!);
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 50 }),
		).toHaveProperty("_nay");
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 0 }),
		).toEqual({ _yay: { offset: 50, isDone: false } });
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 50 }),
		).toEqual({ _yay: { offset: 51, isDone: true } });
		expect(
			await f.t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, {
				...capture,
				text: `${capture.text}\nDifferent bytes`,
			}),
		).toHaveProperty("_nay");
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "copying",
			outputTarget: null,
		});
		expect(await f.t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, capture)).toEqual({
			_yay: null,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "completed",
		});
	}, 120_000);

	test("counts saved and private source aliases separately and saves their one destination", async () => {
		const f = await fixture({ aliases: true });
		expect(f.sourceRefs).toHaveLength(2);
		expect(f.selectedMediaItems).toHaveLength(1);
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		const item = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		expect(item).toMatchObject({ state: "completed", outputTarget: { kind: "private" } });
		const setId = item!.capture!.mediaDependencySetId!;
		const dependencies = await read_dependencies(f.t, setId);
		// Two source refs can map to one copied media file.
		expect(dependencies).toHaveLength(2);
		expect(new Set(dependencies.map((dependency) => dependency.src)).size).toBe(1);
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toMatchObject({
			count: 2,
			expectedCount: 2,
			owner: { kind: "proposal" },
		});
		await save_media(f.t, f.destination.membershipId, f.destination.userId, f.selectedMedia!.outputTarget!);
		const view = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: f.destination.membershipId,
			target: item!.outputTarget!,
		});
		const pending = view!.entry.pendingUpdate!;
		const saved = await f.asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId: f.destination.membershipId,
			target: pending.target,
			pendingUpdateId: pending._id,
			reviewedRevision: pending.revision,
		});
		expect(saved).toMatchObject({ _yay: { target: { kind: "saved" } } });
		const read = await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			organizationId: f.destination.organizationId,
			workspaceId: f.destination.workspaceId,
			userId: f.destination.userId,
			path: "/document.md",
			includePending: false,
		});
		expect(read?.content.split(dependencies[0]!.src)).toHaveLength(3);
		for (const src of f.sourceRefs) expect(read?.content).not.toContain(src);
	});

	// 101 media files fill two media pages of 50 and start a third one. With the document they are
	// 102 sources, so the selection also needs a second intake page of 100.
	test.each([false, true])(
		"adopts 101 distinct media references (replacement: %s)",
		async (documentReplacement) => {
			const f = await fixture({ mediaCount: 101, documentReplacement });
			expect(f.selectedMediaItems).toHaveLength(101);
			expect(f.selectedMediaItems.every((item) => item.state === "completed")).toBe(true);
			await f.t.action(internal.files_nodes_content.copy_transfer_file, {
				itemId: f.document._id,
				attempt: f.document.attempt,
			});
			const item = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
			expect(item).toMatchObject({
				state: "completed",
				outputTarget: { kind: documentReplacement ? "saved" : "private" },
			});
			const pending = await f.t.run((ctx) =>
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_user_target", (q) =>
						q
							.eq("userId", f.destination.userId)
							.eq("target.kind", item!.outputTarget!.kind)
							.eq("target.id", item!.outputTarget!.id),
					)
					.unique(),
			);
			const dependencies = await read_dependencies(f.t, pending!.mediaDependencySetId);
			expect(dependencies).toHaveLength(101);
			expect(new Set(dependencies.map((dependency) => dependency.assetId)).size).toBe(101);
			expect(new Set(dependencies.map((dependency) => dependency.assetId))).toEqual(
				new Set(f.selectedMediaItems.map((media) => media.outputMediaAssetId)),
			);
			expect(
				await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", pending!.mediaDependencySetId!)),
			).toMatchObject({
				count: 101,
				expectedCount: 101,
				sealed: true,
				owner: { kind: "proposal", pendingUpdateId: pending!._id },
			});
			const read = await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				organizationId: f.destination.organizationId,
				workspaceId: f.destination.workspaceId,
				userId: f.destination.userId,
				overlayUserId: f.destination.userId,
				path: "/document.md",
			});
			for (const dependency of dependencies) expect(read?.content).toContain(`![Photo](${dependency.src})`);
			for (const src of f.sourceRefs) expect(read?.content).not.toContain(src);
			for (const media of f.selectedMediaItems)
				await save_media(f.t, f.destination.membershipId, f.destination.userId, media.outputTarget!);
			expect(
				await f.asUser.action(api.files_pending_updates.save_file_pending_update, {
					membershipId: f.destination.membershipId,
					target: item!.outputTarget!,
					pendingUpdateId: pending!._id,
					reviewedRevision: pending!.revision,
				}),
			).toMatchObject({ _yay: { target: { kind: "saved" } } });
			for (const dependency of dependencies)
				expect(await f.t.run((ctx) => ctx.db.get("files_r2_assets", dependency.assetId))).not.toBeNull();
		},
		120_000,
	);

	test.each([false, true])("adopts an empty set for rich text (replacement: %s)", async (documentReplacement) => {
		const f = await fixture({ documentReplacement, selected: false, documentText: () => "No media yet\n" });
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		const item = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		expect(item?.state).toBe("completed");
		const pending = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q
						.eq("userId", f.destination.userId)
						.eq("target.kind", item!.outputTarget!.kind)
						.eq("target.id", item!.outputTarget!.id),
				)
				.unique(),
		);
		expect(pending?.mediaDependencySetId).toBeDefined();
		const set = await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", pending!.mediaDependencySetId!));
		expect(set).toMatchObject({
			count: 0,
			expectedCount: 0,
			sealed: true,
			owner: { kind: "proposal", pendingUpdateId: pending!._id },
		});
		expect(pending).not.toHaveProperty("mediaDependencies");
	});

	test("rewrites a real video embed from personal to current", async () => {
		const f = await fixture({
			sourceWorkspace: "personal",
			video: true,
			documentText: (src) => `Before\n\n<video src="${src}" title="Clip"></video>\n\nAfter\n`,
		});
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "completed",
		});
		const read = await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			organizationId: f.destination.organizationId,
			workspaceId: f.destination.workspaceId,
			userId: f.destination.userId,
			overlayUserId: f.destination.userId,
			path: "/document.md",
		});
		expect(read?.content).toContain(`src="${files_media_build_private_src(f.selectedMedia!.outputTarget!.id)}"`);
		expect(read?.content).toContain('title="Clip"');
		expect(read?.content).not.toContain(f.sourceRef);
	});

	test.each([false, true])("replacement Save waits for its media (media replacement: %s)", async (replacement) => {
		const f = await fixture({ documentReplacement: true, replacement });
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		const item = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		if (item?.outputTarget?.kind !== "saved") throw new Error("Expected document replacement");
		const target = item.outputTarget;
		const view = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: f.destination.membershipId,
			target,
		});
		const pending = view!.entry.pendingUpdate!;
		const before = await f.t.run((ctx) => ctx.db.get("files_nodes", target.id));
		const args = {
			membershipId: f.destination.membershipId,
			target,
			pendingUpdateId: pending._id,
			reviewedRevision: pending.revision,
		};
		expect(await f.asUser.action(api.files_pending_updates.save_file_pending_update, args)).toMatchObject({
			_nay: { message: expect.stringContaining("Save the selected media") },
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", target.id))).toEqual(before);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual(pending);
		await save_media(f.t, f.destination.membershipId, f.destination.userId, f.selectedMedia!.outputTarget!);
		expect(await f.asUser.action(api.files_pending_updates.save_file_pending_update, args)).toMatchObject({
			_yay: { target },
		});
	});

	test("refuses a second Copy over private media before the first document mapping", async () => {
		const f = await fixture();
		expect(f.document.capture).toBeNull();
		const target = f.selectedMedia!.outputTarget!;
		expect(target.kind).toBe("private");
		const before = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: f.destination.membershipId,
			target,
		});
		const original = before!.entry.pendingUpdate!.createIntent!;
		if (original.kind !== "stored") throw new Error("Expected stored media");

		const other = await create_media(f.t, f.destination, "/other.png");
		const thread = await f.asUser.mutation(api.ai_chat.thread_create, {
			membershipId: f.destination.membershipId,
			clientGeneratedId: "replace-media-chat",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
			membershipId: f.destination.membershipId,
			threadId: thread._yay.threadId,
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			requestId: "replace-copied-media",
			kind: "copy",
			expectedSourceCount: 1,
			sources: [other.target],
			targetParent: { kind: "root" },
			targetPath: "/",
			targetName: "photo.png",
			missingParentNames: [],
			conflictPolicy: { file: "replace", folder: "error" },
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await f.t.mutation(internal.files_transfer.seal_for_agent, {
				membershipId: f.destination.membershipId,
				threadId: thread._yay.threadId,
				runId: started._yay.runId,
			}),
		).toEqual({ _yay: null });
		for (let step = 0; step < 16; step++) {
			await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
			const item = await f.t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
					.unique(),
			);
			if (item?.state === "completed") {
				expect(item.outputTarget).toEqual(target);
				break;
			}
			if (item?.workId) {
				await f.t.action(internal.files_nodes_content.copy_transfer_file, {
					itemId: item._id,
					attempt: item.attempt,
				});
				await f.t.mutation(internal.files_transfer.handle_copy_complete, {
					workId: item.workId,
					context: { itemId: item._id, attempt: item.attempt },
					result: { kind: "success", returnValue: null },
				});
			}
		}
		const changed = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: f.destination.membershipId,
			target,
		});
		const replacement = changed!.entry.pendingUpdate!.createIntent!;
		if (replacement.kind !== "stored") throw new Error("Expected stored replacement");
		expect(replacement.assetId).not.toBe(original.assetId);
		expect(changed!.entry.pendingUpdate!.preparation).toBeUndefined();

		const uploads = () => vi.mocked(globalThis.fetch).mock.calls.filter(([, init]) => init?.method === "PUT").length;
		const beforeUploads = uploads();
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "failed",
			outputTarget: null,
		});
		expect(uploads()).toBe(beforeUploads);
		expect(
			await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
				membershipId: f.destination.membershipId,
				target,
			}),
		).toEqual(changed);

		await f.t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: f.document.workId!,
			context: { itemId: f.document._id, attempt: f.document.attempt },
			result: { kind: "success", returnValue: null },
		});
		await f.t.mutation(internal.files_transfer.advance, { runId: f.document.runId });
		const retried = await f.asUser.mutation(api.files_transfer.retry_remaining, {
			membershipId: f.current.membershipId,
			runId: f.document.runId,
			requestId: "retry-original-media",
		});
		if (retried._nay) throw new Error(retried._nay.message);
		for (let step = 0; step < 16; step++) {
			await f.t.mutation(internal.files_transfer.advance, { runId: retried._yay.runId });
			const items = await f.t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", retried._yay.runId))
					.collect(),
			);
			const document = items.find((item) => item.source.id === f.document.source.id);
			if (!document?.workId) continue;
			expect(items.find((item) => item.source.id === f.media.target.id)).toMatchObject({
				state: "completed",
				capture: null,
				outputTarget: target,
				outputMediaAssetId: original.assetId,
			});
			await f.t.action(internal.files_nodes_content.copy_transfer_file, {
				itemId: document._id,
				attempt: document.attempt,
			});
			expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", document._id))).toMatchObject({
				state: "failed",
				outputTarget: null,
			});
			expect(uploads()).toBe(beforeUploads);
			return;
		}
		throw new Error("Retried document worker did not start");
	});

	test("allows unchanged media Save before the first document mapping and then saves the document", async () => {
		const f = await fixture();
		expect(f.document.capture).toBeNull();
		const mediaTarget = f.selectedMedia!.outputTarget!;
		const before = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: f.destination.membershipId,
			target: mediaTarget,
		});
		const original = before!.entry.pendingUpdate!.createIntent!;
		if (original.kind !== "stored") throw new Error("Expected stored media");
		const savedMedia = await save_media(f.t, f.destination.membershipId, f.destination.userId, mediaTarget);
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", savedMedia.id))).toMatchObject({
			assetId: original.assetId,
		});
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		const item = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		expect(item?.state).toBe("completed");
		expect(item?.outputMediaAssetId).toBeUndefined();
		const target = item!.outputTarget!;
		const view = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: f.destination.membershipId,
			target,
		});
		const pending = view!.entry.pendingUpdate!;
		expect(await read_dependencies(f.t, pending.mediaDependencySetId)).toEqual([
			expect.objectContaining({
				src: files_media_build_private_src(mediaTarget.id),
				target: mediaTarget,
				assetId: original.assetId,
				version: expect.objectContaining({ kind: "asset" }),
			}),
		]);
		expect(
			await f.asUser.action(api.files_pending_updates.save_file_pending_update, {
				membershipId: f.destination.membershipId,
				target,
				pendingUpdateId: pending._id,
				reviewedRevision: pending.revision,
			}),
		).toMatchObject({ _yay: { target: { kind: "saved" } } });
	});

	test("keeps the first media pins when the worker retries before upload", async () => {
		const f = await fixture();
		const claim = { itemId: f.document._id, attempt: f.document.attempt, workId: f.document.workId! };
		const editor = files_headless_tiptap_editor_create({ initialContent: { markdown: f.documentText } });
		if (editor._nay) throw new Error(editor._nay.message);
		const sourceTextDigest = await crypto_sha256_hex(
			files_headless_tiptap_editor_get_markdown({ mut_editor: editor._yay }),
		);
		editor._yay.destroy();
		const page = { expectedCount: 1, offset: 0, sourceTextDigest };
		await f.t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		const first = await f.t.mutation(internal.files_nodes_content.prepare_transfer_file_media, {
			...claim,
			...page,
			refs: [f.sourceRef],
		});
		expect(first._yay).toHaveLength(1);
		expect(
			await f.t.mutation(internal.files_nodes_content.prepare_transfer_file_media, {
				...claim,
				...page,
				expectedCount: 51,
				refs: Array.from({ length: 51 }, () => f.sourceRef),
			}),
		).toEqual({ _nay: { message: "Invalid media selection page" } });
		await f.t.run(async (ctx) => {
			const target = f.selectedMedia!.outputTarget!;
			const pending = await ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", f.destination.userId).eq("target.kind", target.kind).eq("target.id", target.id),
				)
				.first();
			await ctx.db.patch("files_pending_updates", pending!._id, { revision: pending!.revision + 1 });
		});
		expect(
			await f.t.mutation(internal.files_nodes_content.prepare_transfer_file_media, {
				...claim,
				...page,
				refs: [f.sourceRef],
			}),
		).toEqual(first);
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "failed",
			outputTarget: null,
			errorMessage: "The copied media changed while this document was being copied. Try again.",
		});
	});

	test.each([false, true])(
		"rewrites only app media and stores destination pins (replacement: %s)",
		async (documentReplacement) => {
			const f = await fixture({
				documentReplacement,
				documentText: (src) =>
					`Before\n\n![Photo](${src})\n\n\`literal ${src}\`\n\n![External](https://example.test/photo.png)\n\nAfter\n`,
			});
			const mapped = await map_refs(f);
			if (!mapped._yay || !("mediaDependencies" in mapped._yay)) throw new Error("Expected media mapping");
			await f.t.action(internal.files_nodes_content.copy_transfer_file, {
				itemId: f.document._id,
				attempt: f.document.attempt,
			});
			const item = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
			expect(item).toMatchObject({
				state: "completed",
				outputTarget: { kind: documentReplacement ? "saved" : "private" },
			});
			const pending = await f.t.run((ctx) =>
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_user_target", (q) =>
						q
							.eq("userId", f.destination.userId)
							.eq("target.kind", item!.outputTarget!.kind)
							.eq("target.id", item!.outputTarget!.id),
					)
					.first(),
			);
			expect(await read_dependencies(f.t, pending!.mediaDependencySetId)).toEqual(mapped._yay.mediaDependencies);
			const read = await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				organizationId: f.destination.organizationId,
				workspaceId: f.destination.workspaceId,
				userId: f.destination.userId,
				overlayUserId: f.destination.userId,
				path: "/document.md",
			});
			expect(read?.content).toContain(`![Photo](${mapped._yay.mediaDependencies[0]!.src})`);
			expect(read?.content).toContain(`\`literal ${f.sourceRef}\``);
			expect(read?.content).toContain("![External](https://example.test/photo.png)");
		},
	);

	test("refuses an unselected dependency before uploading document output", async () => {
		const f = await fixture({ selected: false });
		const uploads = () => vi.mocked(globalThis.fetch).mock.calls.filter(([, init]) => init?.method === "PUT").length;
		const before = uploads();
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "failed",
			errorMessage: "Select the linked image or video files with this document",
		});
		expect(uploads()).toBe(before);
	});

	test("refuses a media revision changed while the document uploads", async () => {
		const f = await fixture();
		const fetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
		let changed = false;
		vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
			if (!changed && init?.method === "PUT") {
				changed = true;
				await f.t.run(async (ctx) => {
					const target = f.selectedMedia!.outputTarget!;
					const pending = await ctx.db
						.query("files_pending_updates")
						.withIndex("by_user_target", (q) =>
							q.eq("userId", f.destination.userId).eq("target.kind", target.kind).eq("target.id", target.id),
						)
						.first();
					await ctx.db.patch("files_pending_updates", pending!._id, { revision: pending!.revision + 1 });
				});
			}
			return await fetch(input, init);
		});
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		expect(changed).toBe(true);
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "failed",
			outputTarget: null,
			errorMessage: "The copied media changed while this document was being copied. Try again.",
		});
	});
});
