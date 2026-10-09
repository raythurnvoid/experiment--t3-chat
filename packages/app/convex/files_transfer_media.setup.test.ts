// Fixtures shared by the files_transfer_media test files.
import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { expect, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_save_file_pending_update, test_convex, test_create_saved_text_file, test_mocks_fill_db_with } from "./setup.test.ts";
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

// Each test file calls this in `beforeEach`.
export function mock_media_storage() {
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
}

export async function create_media(args: {
	t: ReturnType<typeof test_convex>;
	scope: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		membershipId: Id<"organizations_workspaces_users">;
	};
	path?: string;
}) {
	const { t, scope, path = "/photo.png" } = args;

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

export async function save_media(args: {
	t: ReturnType<typeof test_convex>;
	membershipId: Id<"organizations_workspaces_users">;
	userId: Id<"users">;
	target: files_PendingTarget;
}) {
	const { t, userId, membershipId, target } = args;

	// Keep large real Save sequences within the public rate limit without running cleanup timers.
	vi.setSystemTime(Date.now() + 1500);
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: userId });
	const view = await asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target });
	if (!view?.entry.pendingUpdate) throw new Error("Expected media proposal");
	const saved = await test_save_file_pending_update(asUser, {
		membershipId,
		target,
		pendingUpdateId: view.entry.pendingUpdate._id,
		reviewedRevision: view.entry.pendingUpdate.revision,
	});
	if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected saved media");
	return saved._yay.target;
}

export async function fixture(
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
	const media = await create_media({ t, scope: source, path: options.video ? "/clip.mp4" : "/photo.png" });
	const original = media.target;
	if (options.sourceKind !== "private")
		media.target = await save_media({
			t,
			membershipId: source.membershipId,
			userId: source.userId,
			target: media.target,
		});
	const sourceRef =
		media.target.kind === "saved"
			? files_media_build_file_src(media.target.id)
			: files_media_build_private_src(media.target.id);
	const mediaFiles = [media];
	const sourceRefs = [sourceRef];
	if (options.aliases && original.kind === "private") sourceRefs.push(files_media_build_private_src(original.id));
	for (let index = 1; index < (options.mediaCount ?? 1); index++) {
		const extra = await create_media({ t, scope: source, path: `/photo-${index}.png` });
		extra.target = await save_media({
			t,
			membershipId: source.membershipId,
			userId: source.userId,
			target: extra.target,
		});
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
	const occupant = options.replacement ? await create_media({ t, scope: destination }) : null;
	const savedOccupant = occupant
		? await save_media({
				t,
				membershipId: destination.membershipId,
				userId: destination.userId,
				target: occupant.target,
			})
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

export async function map_refs(f: Awaited<ReturnType<typeof fixture>>, refs = [f.sourceRef]) {
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

export async function read_dependencies(
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

export async function prepare_document_capture(f: Awaited<ReturnType<typeof fixture>>) {
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

export async function finish_document(f: Awaited<ReturnType<typeof fixture>>) {
	await f.t.mutation(internal.files_transfer.handle_copy_complete, {
		workId: f.document.workId!,
		context: { itemId: f.document._id, attempt: f.document.attempt },
		result: { kind: "success", returnValue: null },
	});
	await f.t.mutation(internal.files_transfer.advance, { runId: f.document.runId });
}

export async function copy_again(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	source: files_PendingTarget;
	targetName: string;
}) {
	const { f, source, targetName } = args;

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
