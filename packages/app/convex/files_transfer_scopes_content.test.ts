import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { applyUpdate, Doc as YjsDoc, encodeStateAsUpdate, encodeStateVector } from "yjs";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
	test_convex,
	test_create_saved_text_file,
	test_get_file_yjs_pointers,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import { r2_create_asset_key, r2_server_side_copy } from "./r2_client.ts";
import { files_media_build_file_src, files_media_build_private_src } from "../shared/files-media.ts";
import {
	files_ROOT_ID,
	files_u8_to_array_buffer,
	files_YJS_DOC_KEYS,
	type files_PendingTarget,
} from "../shared/files.ts";

const objects = new Map<string, BodyInit>();

beforeEach(() => {
	vi.useFakeTimers();
	objects.clear();
	let workCount = 0;
	vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(async () => `scope-copy-${++workCount}` as never);
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

async function fixture() {
	const t = test_convex({ transactionLimits: true });
	const owner = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "team", workspaceName: "home" }),
	);
	const personal = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
	);
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: personal.userId });
	expect(
		await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userIdToAdd: personal.userId,
		}),
	).toEqual({ _yay: null });
	expect(
		await asOwner.mutation(api.organizations.set_organization_billing_mode, {
			organizationId: owner.organizationId,
			billingMode: "organization_owner",
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
	if (!membership) throw new Error("Missing team membership");
	const current = {
		organizationId: owner.organizationId,
		workspaceId: owner.workspaceId,
		userId: personal.userId,
		membershipId: membership._id,
	};
	const created = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: current.membershipId,
		clientGeneratedId: "scope-copy-chat",
		lastMessageAt: Date.now(),
	});
	if (created._nay) throw new Error(created._nay.message);
	return { t, owner, current, personal, asOwner, asUser, threadId: created._yay.threadId };
}

async function start_copy(
	f: Awaited<ReturnType<typeof fixture>>,
	source: files_PendingTarget,
	sourceWorkspace: "current" | "personal" = "personal",
	destinationWorkspace: "current" | "personal" = "current",
) {
	const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
		membershipId: f.current.membershipId,
		threadId: f.threadId,
		sourceWorkspace,
		destinationWorkspace,
		requestId: "scope-copy",
		kind: "copy",
		expectedSourceCount: 1,
		sources: [source],
		targetParent: { kind: "root" },
		targetPath: "/",
		targetName: "copy.txt",
		missingParentNames: [],
		conflictPolicy: { file: "replace", folder: "error" },
	});
	if (started._nay) throw new Error(started._nay.message);
	expect(
		await f.t.mutation(internal.files_transfer.seal_for_agent, {
			membershipId: f.current.membershipId,
			threadId: f.threadId,
			runId: started._yay.runId,
		}),
	).toEqual({ _yay: null });
	for (let step = 0; step < 16; step++) {
		await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
		const item = await f.t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
				.first(),
		);
		if (item?.workId)
			return { ...started._yay, item, claim: { itemId: item._id, attempt: item.attempt, workId: item.workId } };
		if (item?.state === "failed") throw new Error(item.errorMessage!);
	}
	throw new Error("Copy did not start");
}

async function append_saved_text(
	f: Awaited<ReturnType<typeof fixture>>,
	membershipId: Id<"organizations_workspaces_users">,
	nodeId: Id<"files_nodes">,
	text: string,
) {
	const pointers = await test_get_file_yjs_pointers(f.t, nodeId);
	const asset = await f.t.run(async (ctx) => {
		const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
		return await ctx.db.get("files_r2_assets", snapshot!.assetId);
	});
	const document = new YjsDoc();
	try {
		applyUpdate(document, new Uint8Array(await new Response(objects.get(asset!.r2Key!)).arrayBuffer()));
		const before = encodeStateVector(document);
		const value = document.getText(files_YJS_DOC_KEYS.plainText);
		value.insert(value.length, text);
		expect(
			await f.asUser.mutation(api.files_nodes.yjs_push_update, {
				membershipId,
				nodeId,
				expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
				update: files_u8_to_array_buffer(encodeStateAsUpdate(document, before)),
				sessionId: "scope-copy-edit",
			}),
		).toMatchObject({ _yay: expect.anything() });
	} finally {
		document.destroy();
	}
}

async function media_proposal(
	f: Awaited<ReturnType<typeof fixture>>,
	workspace: "current" | "personal",
	path = "/photo.png",
) {
	const scope = f[workspace];
	const prepared = await f.t.mutation(internal.files_ingestion.prepare_file, {
		...scope,
		requestId: `media:${workspace}:${path}`,
		attemptId: "media",
		path,
		size: 4,
		contentType: "image/png",
		digest: "a".repeat(64),
		content: { kind: "stored" },
	});
	if (prepared._nay || prepared._yay.kind !== "stored") throw new Error("Expected stored media");
	objects.set(prepared._yay.r2Key, new Uint8Array([1, 2, 3, 4]));
	const finalized = await f.t.mutation(internal.files_ingestion.finalize_file, {
		...scope,
		receiptId: prepared._yay.receiptId,
		attemptId: "media",
	});
	if (finalized._nay) throw new Error(finalized._nay.message);
	return finalized._yay.target;
}

async function get_proposal(
	f: Awaited<ReturnType<typeof fixture>>,
	workspace: "current" | "personal",
	target: files_PendingTarget,
) {
	const view = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
		membershipId: f[workspace].membershipId,
		target,
	});
	if (!view?.entry.pendingUpdate) throw new Error("Expected a proposal");
	return view.entry.pendingUpdate;
}

async function get_dependencies(
	f: Awaited<ReturnType<typeof fixture>>,
	setId: Id<"files_media_dependency_sets"> | undefined,
) {
	if (!setId) throw new Error("Expected a media dependency set");
	return await f.t.run(async (ctx) =>
		(
			await ctx.db
				.query("files_media_dependencies")
				.withIndex("by_set_order", (q) => q.eq("setId", setId))
				.collect()
		).map((row) => row.dependency),
	);
}

async function save_proposal(
	f: Awaited<ReturnType<typeof fixture>>,
	workspace: "current" | "personal",
	target: files_PendingTarget,
) {
	const proposal = await get_proposal(f, workspace, target);
	return await f.asUser.action(api.files_pending_updates.save_file_pending_update, {
		membershipId: f[workspace].membershipId,
		target,
		pendingUpdateId: proposal._id,
		reviewedRevision: proposal.revision,
	});
}

async function copy_files(
	f: Awaited<ReturnType<typeof fixture>>,
	args: {
		sources: files_PendingTarget[];
		sourceWorkspace: "current" | "personal";
		destinationWorkspace: "current" | "personal";
		targetName?: string;
	},
) {
	const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
		membershipId: f.current.membershipId,
		threadId: f.threadId,
		...args,
		requestId: crypto.randomUUID(),
		kind: "copy",
		expectedSourceCount: args.sources.length,
		targetParent: { kind: "root" },
		targetPath: "/",
		targetName: args.targetName ?? null,
		missingParentNames: [],
		conflictPolicy: { file: "replace", folder: "error" },
	});
	if (started._nay) throw new Error(started._nay.message);
	expect(
		await f.t.mutation(internal.files_transfer.seal_for_agent, {
			membershipId: f.current.membershipId,
			threadId: f.threadId,
			runId: started._yay.runId,
		}),
	).toEqual({ _yay: null });
	for (let step = 0; step < 64; step++) {
		await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
		const items = await f.t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
				.collect(),
		);
		if (items.length && items.every((item) => ["completed", "failed", "skipped", "canceled"].includes(item.state)))
			return items;
		for (const item of items) {
			if (item.state !== "copying" || !item.workId) continue;
			await f.t.action(internal.files_nodes_content.copy_transfer_file, { itemId: item._id, attempt: item.attempt });
			await f.t.mutation(internal.files_transfer.handle_copy_complete, {
				workId: item.workId,
				context: { itemId: item._id, attempt: item.attempt },
				result: { kind: "success", returnValue: null },
			});
		}
	}
	throw new Error("Copy did not finish");
}

async function media_copy_source(f: Awaited<ReturnType<typeof fixture>>) {
	const media = await media_proposal(f, "current");
	const saved = await save_proposal(f, "current", media);
	if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected saved media");
	const documentId = await test_create_saved_text_file(f.t, {
		membershipId: f.current.membershipId,
		path: "/document.md",
		textContent: `Before\n\n![Photo](${files_media_build_file_src(saved._yay.target.id)})\n\nAfter\n`,
	});
	return [{ kind: "saved" as const, id: documentId }, saved._yay.target];
}

describe("cross-workspace Move refusal", () => {
	test.each(["current", "personal"] as const)(
		"refuses a Move from %s before creating output",
		async (sourceWorkspace) => {
			const f = await fixture();
			const sourceId = await test_create_saved_text_file(f.t, {
				membershipId: f[sourceWorkspace].membershipId,
				path: "/source.txt",
				textContent: "Keep this source\n",
			});
			const before = await f.t.run(async (ctx) => ({
				nodes: await ctx.db.query("files_nodes").collect(),
				assets: await ctx.db.query("files_r2_assets").collect(),
				holds: await ctx.db.query("files_private_storage_reservations").collect(),
				pendingNodes: await ctx.db.query("files_pending_nodes").collect(),
				pendingUpdates: await ctx.db.query("files_pending_updates").collect(),
			}));
			const result = await f.t.mutation(internal.files_transfer.start_for_agent, {
				membershipId: f.current.membershipId,
				threadId: f.threadId,
				sourceWorkspace,
				destinationWorkspace: sourceWorkspace === "current" ? "personal" : "current",
				requestId: "refused-move",
				kind: "move",
				sources: [{ kind: "saved", id: sourceId }],
				targetParent: { kind: "root" },
				targetPath: "/",
				targetName: null,
				missingParentNames: [],
				conflictPolicy: { file: "replace", folder: "error" },
			});
			expect(result).toEqual({
				_nay: {
					name: "cross_workspace_move",
					message:
						"Moves between workspaces are not allowed. Use cp to copy files instead, or cp -R for a folder. The originals will stay in place.",
				},
			});
			await f.t.run(async (ctx) => {
				expect(await ctx.db.query("files_nodes").collect()).toEqual(before.nodes);
				expect(await ctx.db.query("files_r2_assets").collect()).toEqual(before.assets);
				expect(await ctx.db.query("files_private_storage_reservations").collect()).toEqual(before.holds);
				expect(await ctx.db.query("files_pending_nodes").collect()).toEqual(before.pendingNodes);
				expect(await ctx.db.query("files_pending_updates").collect()).toEqual(before.pendingUpdates);
				for (const table of [
					"files_transfer_runs",
					"files_transfer_items",
					"activities",
					"ai_chat_bash_invocation_transfers",
				] as const)
					expect(await ctx.db.query(table).collect(), table).toEqual([]);
			});
		},
	);
});

describe("complete folder Copy", () => {
	test("refuses an unreadable saved child before creating a private copy", async () => {
		const f = await fixture();
		const created = await f.asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.owner.membershipId,
			parentId: "root",
			path: "source/hidden-name",
		});
		if (created._nay) throw new Error(created._nay.message);
		expect(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.owner.membershipId,
				nodeId: created._yay.nodeId,
			}),
		).toEqual({ _yay: null });
		const source = await f.asUser.query(api.files_nodes.get_visible_target_by_path, {
			membershipId: f.current.membershipId,
			path: "/source",
		});
		if (!source) throw new Error("Missing source folder");
		const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
			membershipId: f.current.membershipId,
			threadId: f.threadId,
			sourceWorkspace: "current",
			destinationWorkspace: "personal",
			requestId: "complete-folder",
			kind: "copy",
			expectedSourceCount: 1,
			sources: [source.target],
			targetParent: { kind: "root" },
			targetPath: "/",
			targetName: null,
			missingParentNames: [],
			conflictPolicy: { file: "replace", folder: "error" },
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await f.t.mutation(internal.files_transfer.seal_for_agent, {
				membershipId: f.current.membershipId,
				threadId: f.threadId,
				runId: started._yay.runId,
			}),
		).toEqual({ _yay: null });
		for (let step = 0; step < 3; step++)
			await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
		const view = await f.asUser.query(api.files_transfer.get, {
			membershipId: f.current.membershipId,
			runId: started._yay.runId,
		});
		expect(view).toMatchObject({
			activity: {
				status: "failed",
				progress: { completed: 0 },
				errorMessage: "Permission denied",
			},
		});
		expect(JSON.stringify(view)).not.toContain("hidden-name");
		await f.t.run(async (ctx) => {
			expect(await ctx.db.query("files_pending_nodes").collect()).toEqual([]);
			expect(await ctx.db.query("files_r2_assets").collect()).toEqual([]);
			expect((await ctx.db.get("files_nodes", created._yay.nodeId))?.archiveOperationId).toBeNull();
		});
	});

	// With 50 readable children the refusal comes on the second discovery page, after the first page
	// was already added to the manifest.
	test.each([1, 50])("refuses Retry after discovery stopped with %i readable children", async (readableCount) => {
		const f = await fixture();
		for (let index = 0; index < readableCount; index++) {
			const created = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				userId: f.owner.userId,
				path: `/source/a${String(index).padStart(2, "0")}`,
			});
			if (created._nay) throw new Error(created._nay.message);
		}
		const hidden = await f.asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.owner.membershipId,
			parentId: "root",
			path: "source/zz-hidden",
		});
		if (hidden._nay) throw new Error(hidden._nay.message);
		expect(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.owner.membershipId,
				nodeId: hidden._yay.nodeId,
			}),
		).toEqual({ _yay: null });
		const source = await f.asUser.query(api.files_nodes.get_visible_target_by_path, {
			membershipId: f.current.membershipId,
			path: "/source",
		});
		if (!source) throw new Error("Missing source folder");
		const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
			membershipId: f.current.membershipId,
			threadId: f.threadId,
			sourceWorkspace: "current",
			destinationWorkspace: "personal",
			requestId: "partial-discovery",
			kind: "copy",
			expectedSourceCount: 1,
			sources: [source.target],
			targetParent: { kind: "root" },
			targetPath: "/",
			targetName: null,
			missingParentNames: [],
			conflictPolicy: { file: "replace", folder: "merge" },
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await f.t.mutation(internal.files_transfer.seal_for_agent, {
				membershipId: f.current.membershipId,
				threadId: f.threadId,
				runId: started._yay.runId,
			}),
		).toEqual({ _yay: null });
		const args = { membershipId: f.current.membershipId, runId: started._yay.runId };
		for (let step = 0; step < 10; step++)
			await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });

		expect(await f.asUser.query(api.files_transfer.get, args)).toMatchObject({
			activity: { status: "failed", errorMessage: "Permission denied", progress: { total: null } },
			controls: { canRetry: false },
		});
		const before = await f.t.run((ctx) => ctx.db.query("files_transfer_runs").collect());
		expect(await f.asUser.mutation(api.files_transfer.retry_remaining, { ...args, requestId: "retry" })).toEqual({
			_nay: { message: "This copy stopped before it found all its files. Start a new copy instead." },
		});
		await f.t.run(async (ctx) => {
			expect(await ctx.db.query("files_transfer_runs").collect()).toEqual(before);
			expect(await ctx.db.query("files_pending_nodes").collect()).toEqual([]);
		});
	});
});

describe("copy_transfer_file scopes", () => {
	test.each([
		["private", "new"],
		["private", "private"],
		["private", "saved"],
		["saved", "new"],
		["saved", "private"],
		["saved", "saved"],
	] as const)(
		"keeps copied media dependencies from a %s proposal over a %s destination",
		async (sourceKind, destination) => {
			const f = await fixture();
			const sources = await media_copy_source(f);
			if (sourceKind === "saved")
				await test_create_saved_text_file(f.t, {
					membershipId: f.personal.membershipId,
					path: "/document.md",
					textContent: "Original destination\n",
				});
			const first = await copy_files(f, { sources, sourceWorkspace: "current", destinationWorkspace: "personal" });
			expect(first.every((item) => item.state === "completed")).toBe(true);
			const source = first[0]!.outputTarget!;
			const original = await get_proposal(f, "personal", source);
			const originalDependencies = await get_dependencies(f, original.mediaDependencySetId);
			expect(originalDependencies).toHaveLength(1);
			if (destination === "saved")
				await test_create_saved_text_file(f.t, {
					membershipId: f.personal.membershipId,
					path: "/second.md",
					textContent: "Keep saved content\n",
				});
			if (destination === "private")
				await copy_files(f, {
					sources: [source],
					sourceWorkspace: "personal",
					destinationWorkspace: "personal",
					targetName: "second.md",
				});
			const second = await copy_files(f, {
				sources: [source],
				sourceWorkspace: "personal",
				destinationWorkspace: "personal",
				targetName: "second.md",
			});
			expect(second[0]).toMatchObject({ state: "completed" });
			const target = second[0]!.outputTarget!;
			const pending = await get_proposal(f, "personal", target);
			const before = target.kind === "saved" ? await f.t.run((ctx) => ctx.db.get("files_nodes", target.id)) : null;
			expect(await save_proposal(f, "personal", target)).toMatchObject({
				_nay: { message: expect.stringContaining("Save the selected media") },
			});
			expect(await get_proposal(f, "personal", target)).toEqual(pending);
			expect(await get_dependencies(f, pending.mediaDependencySetId)).toEqual(originalDependencies);
			expect(second[0]!.capture!.mediaDependencySetId).toBe(pending.mediaDependencySetId);
			if (target.kind === "saved") expect(await f.t.run((ctx) => ctx.db.get("files_nodes", target.id))).toEqual(before);
			else
				expect(await f.t.run((ctx) => ctx.db.get("files_pending_nodes", target.id))).toMatchObject({ state: "active" });
			expect(await save_proposal(f, "personal", first[1]!.outputTarget!)).toHaveProperty("_yay");
			expect(await save_proposal(f, "personal", target)).toHaveProperty("_yay");
		},
	);

	test.each([
		["private", "save"],
		["private", "replace"],
		["private", "save_replacement"],
		["saved", "save"],
		["saved", "replace"],
		["saved", "save_replacement"],
	] as const)(
		"checks the pinned %s media after %s while the document PUT is paused",
		async (destinationKind, change) => {
			const f = await fixture();
			const sources = await media_copy_source(f);
			if (destinationKind === "saved") {
				const existing = await media_proposal(f, "personal");
				expect(await save_proposal(f, "personal", existing)).toHaveProperty("_yay");
			}
			const otherMedia = change === "save" ? null : await media_proposal(f, "personal", "/different.png");
			const personalThread = await f.asUser.mutation(api.ai_chat.thread_create, {
				membershipId: f.personal.membershipId,
				clientGeneratedId: "personal-media-edit",
				lastMessageAt: Date.now(),
			});
			if (personalThread._nay) throw new Error(personalThread._nay.message);
			const fetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
			let savedTarget: files_PendingTarget | null = null;
			let pinnedAssetId: Id<"files_r2_assets"> | null = null;
			let mediaRef: string | null = null;
			vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
				if (!savedTarget && init?.method === "PUT" && typeof init.body === "string" && init.body.includes("![Photo]")) {
					const media = await f.asUser.query(api.files_nodes.get_visible_target_by_path, {
						membershipId: f.personal.membershipId,
						path: "/photo.png",
					});
					if (!media) throw new Error("Expected copied media");
					const target = media.target;
					expect(target.kind).toBe(destinationKind);
					const pending = await get_proposal(f, "personal", target);
					const stored =
						pending.pendingReplacement ?? (pending.createIntent?.kind === "stored" ? pending.createIntent : null);
					if (!stored) throw new Error("Expected stored media");
					pinnedAssetId = stored.assetId;
					mediaRef =
						target.kind === "private"
							? files_media_build_private_src(target.id)
							: files_media_build_file_src(target.id);
					expect(init.body).toContain(mediaRef);
					const saved = await save_proposal(f, "personal", target);
					if (saved._nay) throw new Error(saved._nay.message);
					savedTarget = saved._yay.target;
					if (otherMedia) {
						// A second chat workspace has its own transfer lane while this PUT is paused.
						const replaced = await copy_files(
							{ ...f, current: f.personal, threadId: personalThread._yay.threadId },
							{
								sources: [otherMedia],
								sourceWorkspace: "current",
								destinationWorkspace: "current",
								targetName: "photo.png",
							},
						);
						expect(replaced[0]).toMatchObject({ state: "completed", outputTarget: savedTarget });
						const replacement = await get_proposal(f, "personal", savedTarget);
						expect(replacement.pendingReplacement!.assetId).not.toBe(pinnedAssetId);
						if (change === "save_replacement")
							expect(await save_proposal(f, "personal", savedTarget)).toHaveProperty("_yay");
					}
				}
				return await fetch(input, init);
			});
			const copied = await copy_files(f, { sources, sourceWorkspace: "current", destinationWorkspace: "personal" });
			expect(savedTarget).not.toBeNull();
			if (change !== "save") {
				expect(copied[0]).toMatchObject({
					state: "failed",
					outputTarget: null,
					errorMessage: "The copied media changed while this document was being copied. Try again.",
				});
				return;
			}
			expect(copied[0]).toMatchObject({ state: "completed" });
			const pending = await get_proposal(f, "personal", copied[0]!.outputTarget!);
			expect(await get_dependencies(f, pending.mediaDependencySetId)).toEqual([
				expect.objectContaining({ src: mediaRef, assetId: pinnedAssetId }),
			]);
			expect(await save_proposal(f, "personal", copied[0]!.outputTarget!)).toHaveProperty("_yay");
		},
	);

	test.each(["current", "personal"] as const)(
		"copies saved %s content into destination-owned proposal states",
		async (sourceWorkspace) => {
			const f = await fixture();
			const destinationWorkspace = sourceWorkspace === "current" ? "personal" : "current";
			const sourceScope = f[sourceWorkspace];
			const destinationScope = f[destinationWorkspace];
			const sourceId = await test_create_saved_text_file(f.t, {
				membershipId: sourceScope.membershipId,
				path: "/source.txt",
				textContent: "Saved\n",
			});
			await append_saved_text(f, sourceScope.membershipId, sourceId, "Unmaterialized\n");
			expect(
				await f.asUser.mutation(api.files_metadata.set_entries, {
					membershipId: sourceScope.membershipId,
					fileNodeId: sourceId,
					metadataYaml: "owner: source",
				}),
			).toEqual({ _yay: null });
			expect(
				await (sourceWorkspace === "current" ? f.asOwner : f.asUser).mutation(api.files_nodes.set_node_write_policy, {
					membershipId: sourceWorkspace === "current" ? f.owner.membershipId : f.personal.membershipId,
					nodeId: sourceId,
					writePolicy: { mode: "read_only" },
				}),
			).toEqual({ _yay: null });
			const copy = await start_copy(f, { kind: "saved", id: sourceId }, sourceWorkspace, destinationWorkspace);
			const data = await f.t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, {
				itemId: copy.item._id,
				attempt: copy.item.attempt,
			});
			expect(data._yay).toMatchObject({
				sourceScope: { organizationId: sourceScope.organizationId, workspaceId: sourceScope.workspaceId },
				destinationScope: {
					organizationId: destinationScope.organizationId,
					workspaceId: destinationScope.workspaceId,
				},
			});
			expect(data._yay).not.toHaveProperty("organizationId");
			expect(data._yay).not.toHaveProperty("workspaceId");
			await f.t.action(internal.files_nodes_content.copy_transfer_file, {
				itemId: copy.item._id,
				attempt: copy.item.attempt,
			});
			const proposal = await f.t.run(async (ctx) => {
				expect(await ctx.db.get("files_transfer_items", copy.item._id)).toMatchObject({
					state: "completed",
					billedUserId: destinationWorkspace === "current" ? f.owner.userId : f.personal.userId,
				});
				return await ctx.db.get("files_pending_updates", copy.item.preparation!.pendingUpdateId);
			});
			expect(proposal).toMatchObject({
				organizationId: destinationScope.organizationId,
				workspaceId: destinationScope.workspaceId,
				copiedFrom: {
					target: { kind: "saved", id: sourceId },
					path: "/source.txt",
					sourceWritePolicy: { mode: "read_only" },
				},
				createIntent: { metadata: [{ key: "owner", value: "source" }] },
				threadIds: [f.threadId],
			});
			expect(proposal!.copiedFrom).not.toHaveProperty("sourceNewChildWritePolicy");
			expect(
				(
					await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
						organizationId: destinationScope.organizationId,
						workspaceId: destinationScope.workspaceId,
						userId: f.personal.userId,
						path: "/copy.txt",
						overlayUserId: f.personal.userId,
					})
				)?.content,
			).toBe("Saved\nUnmaterialized\n");
			await f.t.run(async (ctx) => {
				const states = await ctx.db
					.query("files_pending_update_yjs_states")
					.withIndex("by_owner_pendingUpdate", (q) => q.eq("owner.pendingUpdateId", proposal!._id))
					.collect();
				expect(states).toHaveLength(3);
				for (const state of states) {
					expect(state).toMatchObject({
						organizationId: destinationScope.organizationId,
						workspaceId: destinationScope.workspaceId,
						target: proposal!.target,
					});
					const pages = await ctx.db
						.query("files_pending_update_yjs_state_pages")
						.withIndex("by_state_pageIndex", (q) => q.eq("stateId", state._id))
						.collect();
					for (const page of pages) expect(page.workspaceId).toBe(destinationScope.workspaceId);
					const hold = await ctx.db
						.query("files_private_storage_reservations")
						.withIndex("by_resource", (q) => q.eq("resource.kind", "state").eq("resource.id", state._id))
						.unique();
					expect(hold).toMatchObject({
						organizationId: destinationScope.organizationId,
						workspaceId: destinationScope.workspaceId,
						settlement: { kind: "held" },
					});
				}
				const retired = (await ctx.db.query("files_pending_update_yjs_states").collect()).filter(
					(state) => state.target.kind === "saved" && state.target.id === sourceId && state.owner.kind === "retired",
				);
				expect(retired).toHaveLength(1);
				for (const state of retired) {
					expect(state.workspaceId).toBe(sourceScope.workspaceId);
					if (state.owner.kind !== "retired") throw new Error("Expected retired capture");
					expect(await ctx.db.get("files_pending_update_state_cleanup_tasks", state.owner.cleanupTaskId)).toMatchObject(
						{ workspaceId: sourceScope.workspaceId },
					);
				}
				const assetHolds = (await ctx.db.query("files_private_storage_reservations").collect()).filter(
					(hold) => hold.resource.kind === "asset" && hold.settlement.kind === "held",
				);
				expect(assetHolds).toHaveLength(2);
				for (const hold of assetHolds) expect(hold.workspaceId).toBe(destinationScope.workspaceId);
			});
		},
	);

	test("rebases a personal source draft using personal saved text", async () => {
		const f = await fixture();
		const sourceId = await test_create_saved_text_file(f.t, {
			membershipId: f.personal.membershipId,
			path: "/source.txt",
			textContent: "Saved\nDraft\n",
		});
		const scope = {
			organizationId: f.personal.organizationId,
			workspaceId: f.personal.workspaceId,
			userId: f.personal.userId,
		};
		const target = { kind: "saved" as const, id: sourceId };
		const batch = await f.t.mutation(
			internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
			{ ...scope, target },
		);
		if (batch._nay) throw new Error(batch._nay.message);
		for (const role of ["staged", "unstaged"] as const)
			expect(
				await f.t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
					...scope,
					operationBatchId: batch._yay.operationBatchId,
					role,
					text: "Saved\nProposed\n",
				}),
			).toEqual({ _yay: null });
		expect(
			await f.t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
				...scope,
				target,
				operationBatchId: batch._yay.operationBatchId,
			}),
		).toEqual({ _yay: null });
		await append_saved_text(f, f.personal.membershipId, sourceId, "New saved line\n");
		const copy = await start_copy(f, target);
		const data = await f.t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, {
			itemId: copy.item._id,
			attempt: copy.item.attempt,
		});
		expect(data._nay).toMatchObject({
			name: "source_needs_rebase",
			data: { organizationId: scope.organizationId, workspaceId: scope.workspaceId, savedPath: "/source.txt" },
		});
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: copy.item._id,
			attempt: copy.item.attempt,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", copy.item._id))).toMatchObject({
			state: "completed",
		});
		expect(
			(
				await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
					organizationId: f.current.organizationId,
					workspaceId: f.current.workspaceId,
					userId: f.personal.userId,
					path: "/copy.txt",
					overlayUserId: f.personal.userId,
				})
			)?.content,
		).toBe("Saved\nProposed\nNew saved line\n");
	});

	test("keeps saved destination mode and uses its own replacement asset", async () => {
		const f = await fixture();
		const sourceId = await test_create_saved_text_file(f.t, {
			membershipId: f.personal.membershipId,
			path: "/source.txt",
			textContent: "Replacement\n",
		});
		const destinationId = await test_create_saved_text_file(f.t, {
			membershipId: f.current.membershipId,
			path: "/copy.txt",
			textContent: "Destination\n",
		});
		expect(
			await f.asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: f.current.membershipId,
				nodeId: destinationId,
				acknowledgeDropCollaborativeHistory: true,
			}),
		).toEqual({ _yay: null });
		const source = await f.t.run((ctx) => ctx.db.get("files_nodes", sourceId));
		const destination = await f.t.run((ctx) => ctx.db.get("files_nodes", destinationId));
		const copy = await start_copy(f, { kind: "saved", id: sourceId });
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: copy.item._id,
			attempt: copy.item.attempt,
		});
		await f.t.run(async (ctx) => {
			expect(await ctx.db.get("files_transfer_items", copy.item._id)).toMatchObject({ state: "completed" });
			expect(await ctx.db.get("files_nodes", destinationId)).toEqual(destination);
			const pending = await ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", f.personal.userId).eq("target.kind", "saved").eq("target.id", destinationId),
				)
				.first();
			expect(pending).toMatchObject({
				workspaceId: f.current.workspaceId,
				pendingReplacement: { nonCollaborative: true, baseAssetId: destination!.assetId },
				copiedFrom: { target: { kind: "saved", id: sourceId } },
			});
			const asset = await ctx.db.get("files_r2_assets", pending!.pendingReplacement!.assetId);
			expect(asset!._id).not.toBe(source!.assetId);
			expect(asset).toMatchObject({ organizationId: f.current.organizationId, workspaceId: f.current.workspaceId });
			expect(asset!.r2Key).toBe(r2_create_asset_key({ ...f.current, assetId: asset!._id }));
		});
	});

	test("checks the personal destination plan before copying stored team bytes", async () => {
		const f = await fixture();
		const source = await f.asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: f.current.membershipId,
			parentId: files_ROOT_ID,
			filename: "source.bin",
			contentType: "application/octet-stream",
			size: 3,
		});
		if (source._nay) throw new Error(source._nay.message);
		const key = r2_create_asset_key({ ...f.current, assetId: source._yay.assetId });
		objects.set(key, new Uint8Array([1, 2, 3]));
		await f.t.run(async (ctx) => {
			await ctx.db.patch("files_r2_assets", source._yay.assetId, { r2Key: key, unfinalizedExpiresAt: undefined });
			await test_mocks_fill_db_with.plan(ctx, { userId: f.personal.userId, plan: "Free" });
		});
		const copy = await start_copy(f, { kind: "saved", id: source._yay.nodeId }, "current", "personal");
		const before = vi.mocked(globalThis.fetch).mock.calls.length;
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: copy.item._id,
			attempt: copy.item.attempt,
		});
		expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(before);
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", copy.item._id))).toMatchObject({
			state: "failed",
			errorMessage: "This workspace's plan does not include file uploads",
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toHaveLength(1);
	});

	test("cleans source captures and destination allocations in their own scopes after a storage refusal", async () => {
		const f = await fixture();
		const sourceId = await test_create_saved_text_file(f.t, {
			membershipId: f.current.membershipId,
			path: "/source.txt",
			textContent: "Captured text\n",
		});
		const copy = await start_copy(f, { kind: "saved", id: sourceId }, "current", "personal");
		const data = await f.t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, {
			itemId: copy.item._id,
			attempt: copy.item.attempt,
		});
		if (!data._yay?.asset || !data._yay.yjsSnapshotAsset) throw new Error("Missing source assets");
		const source = data._yay;
		const staged = await f.t.mutation(internal.files_nodes_content.stage_transfer_file_copy_assets, {
			...copy.claim,
			contentSize: source.asset!.size,
			yjsSnapshotSize: source.yjsSnapshotAsset!.size,
		});
		if (!staged._yay) throw new Error("Missing staged assets");
		expect(
			await f.t.mutation(internal.files_nodes_content.seal_transfer_file_capture, {
				...copy.claim,
				...staged._yay,
				text: "Captured text\n",
			}),
		).toEqual({ _yay: null });

		await f.t.run(async (ctx) => {
			const hold = await ctx.db
				.query("files_private_storage_reservations")
				.withIndex("by_resource", (q) => q.eq("resource.kind", "asset").eq("resource.id", staged._yay!.contentAssetId))
				.unique();
			const quota = await ctx.db.get("quotas", hold!.workspaceQuotaId!);
			// Allow the empty base, then refuse the copied staged state.
			await ctx.db.patch("quotas", quota!._id, { maxCount: quota!.usedCount + 2 });
		});
		const finalized = await f.t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, {
			...copy.claim,
			...staged._yay,
			text: "Captured text\n",
		});
		expect(finalized._nay).toMatchObject({ name: "storage_full" });
		await f.t.mutation(internal.files_nodes_content.discard_transfer_file_attempt, {
			...copy.claim,
			message: finalized._nay!.message,
		});
		await f.t.run(async (ctx) => {
			const capturedStates = (await ctx.db.query("files_pending_update_yjs_states").collect()).filter(
				(state) =>
					state.owner.kind === "retired" &&
					(state.target.id === sourceId || state.target.id === copy.item.preparation!.privateNodeId),
			);
			expect(capturedStates).toHaveLength(2);
			expect(new Set(capturedStates.map((state) => state.workspaceId))).toEqual(
				new Set([f.current.workspaceId, f.personal.workspaceId]),
			);
			for (const state of capturedStates) {
				if (state.owner.kind !== "retired") throw new Error("Expected retired capture");
				expect(await ctx.db.get("files_pending_update_state_cleanup_tasks", state.owner.cleanupTaskId)).toMatchObject({
					organizationId: state.organizationId,
					workspaceId: state.workspaceId,
				});
			}
			const jobs = await ctx.db.query("files_r2_object_deletion_jobs").collect();
			expect(jobs).toHaveLength(2);
			for (const assetId of [staged._yay!.contentAssetId, staged._yay!.yjsSnapshotAssetId!]) {
				expect(await ctx.db.get("files_r2_assets", assetId)).toBeNull();
				expect(jobs).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							organizationId: f.personal.organizationId,
							workspaceId: f.personal.workspaceId,
							r2Key: r2_create_asset_key({ ...f.personal, assetId }),
						}),
					]),
				);
				const hold = await ctx.db
					.query("files_private_storage_reservations")
					.withIndex("by_resource", (q) => q.eq("resource.kind", "asset").eq("resource.id", assetId))
					.unique();
				expect(hold).toMatchObject({ workspaceId: f.personal.workspaceId, settlement: { kind: "held" } });
			}
			expect(await ctx.db.get("files_r2_assets", source.asset!._id)).toEqual(source.asset);
			expect(await ctx.db.get("files_r2_assets", source.yjsSnapshotAsset!._id)).toEqual(source.yjsSnapshotAsset);
		});
	});
});
