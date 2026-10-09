// Fixtures shared by the bash_run_command test files.
import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { encodeStateAsUpdate } from "yjs";
import { api, internal } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel";
import type { ActionCtx, MutationCtx } from "../convex/_generated/server.js";
import { ai_chat_runs_db_begin, ai_chat_runs_db_insert_node } from "../convex/ai_chat_runs.ts";
import { organizations_membership_lifetimes_db_ensure } from "../convex/organizations_membership_lifetimes.ts";
import { files_db_yjs_push_update } from "../convex/files_nodes.ts";
import { db_insert_file_text_content } from "../convex/files_nodes_content.ts";
import { r2, r2_confirmed_object_delete } from "../convex/r2_client.ts";
import {
	test_save_file_pending_update,
	test_finish_pending_update_run,
	test_convex,
	test_mocks,
	test_mocks_fill_db_with,
} from "../convex/setup.test.ts";
import { ai_chat_DEFAULT_MODEL_ID, type ai_chat_ModelId } from "../shared/ai-chat.ts";
import { delay } from "../shared/async-utils.ts";
import { files_yjs_doc_create_from_text } from "../shared/files-tiptap.ts";
import {
	type files_PendingTarget,
	files_ancestor_fields,
	files_ancestor_ids,
	files_ROOT_ID,
	files_guess_content_type_from_name,
	files_u8_to_array_buffer,
	files_yjs_root_kind_of_content_type,
} from "../shared/files.ts";
import { bash_run_command, bash_run_job } from "./bash.ts";
import { bash_READ_INLINE_MAX_BYTES } from "./bash-utils.ts";

export const test_db_files_mount = "/home/cloud-usr/w/personal/home";
export const function_name_of = (ref: unknown) => {
	try {
		return getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
	} catch {
		return null;
	}
};

const test_organization_name = "personal";
const test_workspace_name = "home";

// Full object bytes served by the stubbed global fetch, keyed by files_r2_assets.r2Key. The
// R2 client's getUrl is spied to embed the key in the URL so the bounded window readers
// exercise real HTTP Range parsing against this store.
export const test_r2_objects = new Map<string, Uint8Array>();
let test_runner_counter = 0;

// Importing this file adds these hooks to every test of the importing file. They are added after
// the hook in convex/setup.test.ts, so this afterEach runs before that one.
beforeEach(async () => {
	test_r2_objects.clear();
	// Billing enqueue and R2 metadata sync behavior are covered by their own suites; file
	// content reads are served from test_r2_objects through the fetch stub below.
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_bash_test_billing_event" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey?: string) => {
		const key = customKey ?? "bash-test-upload-key";
		return { key, url: `https://r2.test/upload?key=${encodeURIComponent(key)}` };
	});
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	// Turning collaboration off schedules a delete of the old Yjs snapshot object. Keep that
	// job off the network.
	vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
	vi.spyOn(r2_confirmed_object_delete, "delete_object").mockImplementation(async (_ctx, key) => {
		test_r2_objects.delete(key);
	});
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key: string) => `https://r2.test/object/${encodeURIComponent(key)}`,
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const url = new URL(href);
			// Keep uploaded content and snapshots available for later reads.
			if (url.origin === "https://r2.test" && url.pathname === "/upload" && init?.method === "PUT") {
				const key = decodeURIComponent(url.searchParams.get("key") ?? "");
				if (new Headers(init.headers).get("If-None-Match") === "*" && test_r2_objects.has(key))
					return new Response(null, { status: 412 });
				const body = init.body;
				const bytes =
					typeof body === "string"
						? new TextEncoder().encode(body)
						: body instanceof ArrayBuffer
							? new Uint8Array(body)
							: ArrayBuffer.isView(body)
								? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
								: body instanceof Blob
									? new Uint8Array(await body.arrayBuffer())
									: new TextEncoder().encode("");
				test_r2_objects.set(key, bytes);
				return new Response(null, { status: 200 });
			}
			if (url.origin !== "https://r2.test" || !url.pathname.startsWith("/object/")) {
				return new Response(null, { status: 200 });
			}
			const key = decodeURIComponent(url.pathname.slice("/object/".length));
			const bytes = test_r2_objects.get(key);
			if (!bytes) {
				return new Response(null, { status: 404 });
			}
			const range = new Headers(init?.headers).get("Range");
			const rangeMatch = range == null ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
			if (rangeMatch) {
				const start = Number(rangeMatch[1]);
				const endInclusive = Math.min(Number(rangeMatch[2]), bytes.byteLength - 1);
				return new Response(bytes.slice(start, endInclusive + 1), {
					status: 206,
					headers: { "Content-Range": `bytes ${start}-${endInclusive}/${bytes.byteLength}` },
				});
			}
			return new Response(bytes.slice(0), { status: 200 });
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	// Never let a mocked clock leak into the next test. This is a no-op when no test mocked it.
	vi.useRealTimers();
});

type BashSeedSpec = {
	path: string;
	kind?: "folder" | "file";
	content?: string;
	contentType?: string;
	/**
	 * false skips chunk materialization: reads fall back to the bounded R2 window paths.
	 */
	materialized?: boolean;
	/**
	 * Break chunk tiling contiguity (materialization anomaly) so chunk readers bail to the window fallback.
	 */
	brokenChunks?: boolean;
	/**
	 * Upload-style node without editable yjs state (binary uploads, PDFs).
	 */
	withoutYjsState?: boolean;
	/**
	 * Editable text file with collaboration turned off: committed chunks only, no Yjs docs.
	 */
	nonCollaborative?: boolean;
	/**
	 * Store a real yjs snapshot in mock R2 so action-side base-state fetches work (pending upserts).
	 */
	withRealYjsSnapshot?: boolean;
	/**
	 * Committed asset byte size override; defaults to the utf8 size of `content`.
	 */
	size?: number;
	updatedAt?: number;
};

// Saved chunks keep this text. Copied rich text separates the heading from its paragraph.
export const readme_seed_content = "# Readme\nunique-token here\nmore unique-token below\n";
export const readme_copy_content = "# Readme\n\nunique-token here\nmore unique-token below\n";
export const default_organization_files: BashSeedSpec[] = [
	{ path: "/docs", kind: "folder" },
	{ path: "/docs/readme.md", content: readme_seed_content },
	{ path: "/docs/tutorial.md", content: "zeta\nalpha\nALPHA\n" },
	{ path: "/docs/nested", kind: "folder" },
	{ path: "/docs/nested/deep.md", content: "one:two\nthree:four\n" },
	{
		path: "/source.pdf",
		content: "%PDF-1.7\n".padEnd(4096, " "),
		contentType: "application/pdf",
		withoutYjsState: true,
	},
	{ path: "/uploaded.md", content: "x".repeat(64), contentType: "application/octet-stream", withoutYjsState: true },
	{ path: "/reports", kind: "folder" },
	{ path: "/reports/summary.md", content: "summary\n" },
];

// Keep 1000 lines while exceeding the full-read cap. Common first/tail pages stay short.
export const big_md_file: BashSeedSpec = {
	path: "/big.md",
	content: `${Array.from({ length: 1000 }, (_, index) => `line ${index + 1}${index === 749 ? "x".repeat(bash_READ_INLINE_MAX_BYTES) : ""}`).join("\n")}\n`,
};

async function seed_organization_folder(args: {
	ctx: MutationCtx;
	scope: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; userId: Id<"users"> };
	path: string;
	updatedAt: number;
}) {
	const { ctx, scope, path, updatedAt } = args;

	const segments = path.split("/").filter(Boolean);
	let parentId: Id<"files_nodes"> | typeof files_ROOT_ID = files_ROOT_ID;
	// Saved nodes keep their ancestor ids for scoped name search.
	const ancestors: Id<"files_nodes">[] = [];
	for (let depth = 1; depth <= segments.length; depth++) {
		if (parentId !== files_ROOT_ID) ancestors.push(parentId);
		const ancestorPath = `/${segments.slice(0, depth).join("/")}`;
		const existing = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", scope.organizationId)
					.eq("workspaceId", scope.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("path", ancestorPath)
					.eq("archiveOperationId", null),
			)
			.first();
		if (existing) {
			parentId = existing._id;
			continue;
		}
		parentId = await ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			createdBy: scope.userId,
			updatedBy: scope.userId,
			parentId,
			name: segments[depth - 1],
			kind: "folder",
			path: ancestorPath,
			treePath: `${ancestorPath}/`,
			pathDepth: depth,
			...files_ancestor_fields(ancestors),
			updatedAt,
		});
	}
	return parentId;
}

export async function seed_organization_node(args: {
	ctx: MutationCtx;
	scope: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; userId: Id<"users"> };
	spec: BashSeedSpec;
	seedIndex: number;
}) {
	const { ctx, scope, spec, seedIndex } = args;

	// Deterministic, distinct recency: later seeds are newer.
	const updatedAt = spec.updatedAt ?? Date.now() - 1_000_000 + seedIndex * 1000;
	const segments = spec.path.split("/").filter(Boolean);
	if (spec.kind === "folder") {
		await seed_organization_folder({ ctx, scope, path: spec.path, updatedAt });
		return;
	}
	const parentId =
		segments.length > 1
			? await seed_organization_folder({ ctx, scope, path: `/${segments.slice(0, -1).join("/")}`, updatedAt })
			: files_ROOT_ID;
	const name = segments[segments.length - 1];
	const dotIndex = name.lastIndexOf(".");
	const content = spec.content ?? "";
	const bytes = new TextEncoder().encode(content);
	// The stored type decides the shape, exactly like the production create path. A seed
	// without a type takes the hint from its name and falls back to Markdown.
	const seedContentType = spec.contentType ?? files_guess_content_type_from_name(name) ?? "text/markdown;charset=utf-8";
	const seedRootKind = files_yjs_root_kind_of_content_type(seedContentType) ?? "rich_text";
	const parent = parentId === files_ROOT_ID ? null : await ctx.db.get("files_nodes", parentId);
	const fileId = await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
		createdBy: scope.userId,
		updatedBy: scope.userId,
		parentId,
		name,
		kind: "file",
		path: spec.path,
		treePath: spec.path,
		pathDepth: segments.length,
		...files_ancestor_fields(parent ? [...files_ancestor_ids(parent), parent._id] : []),
		lowercaseExtension: dotIndex <= 0 || dotIndex === name.length - 1 ? null : name.slice(dotIndex + 1).toLowerCase(),
		contentType: seedContentType,
		textKind: spec.withoutYjsState ? null : seedRootKind,
		collaborationEnabled: spec.withoutYjsState ? null : !spec.nonCollaborative,
		updatedAt,
	});
	const r2Key = `bash-test${spec.path}`;
	const assetId = await ctx.db.insert("files_r2_assets", {
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
		kind: "content",
		r2Bucket: "test",
		r2Key,
		size: spec.size ?? bytes.byteLength,
		createdBy: scope.userId,
		updatedAt,
	});
	test_r2_objects.set(r2Key, bytes);
	if (spec.withoutYjsState) {
		await ctx.db.patch("files_nodes", fileId, { assetId });
		return;
	}
	// Collaboration off: the committed chunks are the whole file, so there is no Yjs asset,
	// no snapshot doc, no sequence doc, and the chunks carry no sequence.
	if (spec.nonCollaborative) {
		await ctx.db.patch("files_nodes", fileId, { assetId, collaborationEnabled: false });
		const committed = await db_insert_file_text_content(ctx, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			nodeId: fileId,
			path: spec.path,
			rootKind: seedRootKind,
			textContent: content,
		});
		if (committed._nay) {
			throw new Error(`Seed chunking failed for ${spec.path}: ${committed._nay.message}`);
		}
		return;
	}

	let yjsSnapshotAssetFields: { r2Key?: string; size: number } = { size: 0 };
	if (spec.withRealYjsSnapshot !== false) {
		const yjsDoc = files_yjs_doc_create_from_text({
			text: content,
			rootKind: seedRootKind,
		});
		if ("_nay" in yjsDoc) {
			throw new Error(`Seed yjs snapshot failed for ${spec.path}: ${yjsDoc._nay.message}`);
		}
		const snapshotBytes = encodeStateAsUpdate(yjsDoc);
		const yjsSnapshotR2Key = `bash-test-yjs${spec.path}`;
		test_r2_objects.set(yjsSnapshotR2Key, snapshotBytes);
		yjsSnapshotAssetFields = { r2Key: yjsSnapshotR2Key, size: snapshotBytes.byteLength };
	}
	const yjsSnapshotAssetId = await ctx.db.insert("files_r2_assets", {
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
		kind: "yjs_snapshot",
		r2Bucket: "test",
		...yjsSnapshotAssetFields,
		createdBy: scope.userId,
		updatedAt,
	});
	const yjsSnapshotId = await ctx.db.insert("files_yjs_snapshots", {
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
		fileNodeId: fileId,
		sequence: 1,
		assetId: yjsSnapshotAssetId,
		createdBy: scope.userId,
		updatedBy: scope.userId,
		updatedAt,
	});
	const yjsLastSequenceId = await ctx.db.insert("files_yjs_docs_last_sequences", {
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
		fileNodeId: fileId,
		lastSequence: 1,
		unmaterializedUpdateCount: 0,
		unmaterializedUpdateBytes: 0,
		lineageGeneration: 0,
	});
	await ctx.db.patch("files_nodes", fileId, {
		assetId,
		yjsSnapshotId,
		yjsLastSequenceId,
		textKind: seedRootKind,
	});
	if (spec.materialized === false) {
		return;
	}
	const chunked = await db_insert_file_text_content(ctx, {
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
		nodeId: fileId,
		path: spec.path,
		yjsSequence: 1,
		rootKind: seedRootKind,
		textContent: content,
	});
	if (chunked._nay) {
		throw new Error(`Seed chunking failed for ${spec.path}: ${chunked._nay.message}`);
	}
	if (spec.brokenChunks) {
		// Materialization anomaly: break the verbatim chunk tiling so chunk-backed readers
		// bail out (usable: false) and the bounded R2 window fallback runs instead.
		const chunks = await ctx.db
			.query("files_text_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
				q
					.eq("organizationId", scope.organizationId)
					.eq("workspaceId", scope.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", fileId)
					.eq("moveView.cohortId", undefined)
					.eq("moveView.view", undefined)
					.eq("yjsSequence", 1),
			)
			.collect();
		const second = chunks[1];
		if (second) {
			await ctx.db.patch("files_text_chunks", second._id, { startIndex: second.startIndex + 1 });
		} else {
			const first = chunks[0];
			await ctx.db.insert("files_text_chunks", {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				fileNodeId: fileId,
				sourceKind: "committed",
				yjsSequence: 1,
				chunkIndex: (first?.chunkIndex ?? 0) + 1,
				textChunk: "x",
				startIndex: (first?.endIndex ?? 0) + 7,
				endIndex: (first?.endIndex ?? 0) + 8,
				lineStart: first?.lineEnd ?? 1,
				lineEnd: first?.lineEnd ?? 1,
				chunkFlags: 0,
			});
		}
	}
}

export async function create_bash_runner(opts?: {
	initialCwd?: string;
	allowDbFilesMkdir?: boolean;
	extraFiles?: BashSeedSpec[];
	/**
	 * Reuse another runner's database (fresh thread, no default tree re-seed).
	 */
	shared?: {
		t: unknown;
		seeded: {
			userId: Id<"users">;
			organizationId: Id<"organizations">;
			workspaceId: Id<"organizations_workspaces">;
			membershipId: Id<"organizations_workspaces_users">;
		};
	};
	/**
	 * Acting user override for the action args (scoping tests).
	 */
	userId?: Id<"users">;
	/**
	 * Attach to an existing thread instead of creating one (tmp-scope tests).
	 */
	threadId?: Id<"ai_chat_threads">;
	/**
	 * Every call of this runner asks to be woken when its jobs end (the tool's `wakeOnJobFinish`).
	 */
	wakeAgent?: { modelId: ai_chat_ModelId };
}) {
	test_runner_counter += 1;
	const runnerIndex = test_runner_counter;

	const t = (opts?.shared?.t as ReturnType<typeof test_convex> | undefined) ?? test_convex();
	const seeded =
		opts?.shared?.seeded ??
		(await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: test_organization_name,
				workspaceName: test_workspace_name,
			}),
		));
	const actingUserId = opts?.userId ?? seeded.userId;

	const seedSpecs = [...(opts?.shared ? [] : default_organization_files), ...(opts?.extraFiles ?? [])];
	if (seedSpecs.length > 0) {
		await t.run(async (ctx) => {
			for (const [seedIndex, spec] of seedSpecs.entries()) {
				await seed_organization_node({
					ctx,
					scope: { organizationId: seeded.organizationId, workspaceId: seeded.workspaceId, userId: seeded.userId },
					spec,
					seedIndex,
				});
			}
		});
	}

	let threadId: Id<"ai_chat_threads">;
	if (opts?.threadId != null) {
		threadId = opts.threadId;
	} else {
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: `clerk-bash-runner-${runnerIndex}`,
			external_id: seeded.userId,
			email: `bash-runner-${runnerIndex}@test.local`,
		});
		const createdThread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: seeded.membershipId,
			clientGeneratedId: `client_bash_thread_${runnerIndex}`,
			title: "bash test thread",
			lastMessageAt: Date.now(),
		});
		if (!createdThread._yay) {
			throw new Error(`Failed to create bash test thread: ${createdThread._nay?.message}`);
		}
		threadId = createdThread._yay.threadId;
	}

	const membershipLifetime = await t.run(async (ctx) => {
		const membership = await ctx.db.get("organizations_workspaces_users", seeded.membershipId);
		if (!membership) throw new Error("Expected source membership");
		return await organizations_membership_lifetimes_db_ensure(ctx, membership);
	});

	// A chat tool call runs inside a chat run. Start one, so the calls pass its fence and a job
	// finish has a reply branch to go to. A runner on a shared thread joins the run that is live there.
	const start_chat_run = () =>
		t.run(async (ctx) => {
			const thread = await ctx.db.get("ai_chat_threads", threadId);
			if (!thread) throw new Error("Expected the bash test thread");
			if (thread.activeRun && thread.activeRun.expiresAt > Date.now()) {
				return { runId: thread.activeRun.runId, generation: thread.activeRun.generation };
			}

			const messageId = `bash-runner-message-${runnerIndex}-${thread.newestNodeId ?? "root"}`;
			const triggerId = await ai_chat_runs_db_insert_node(ctx, {
				thread,
				parentId: thread.newestNodeId,
				createdBy: actingUserId,
				clientGeneratedMessageId: messageId,
				content: { id: messageId, role: "user", parts: [{ type: "text", text: "Run the commands." }] },
				status: "done",
				runId: null,
				wakePending: false,
				jobFinishInvocationId: null,
				newest: "set",
				now: Date.now(),
			});
			const begun = await ai_chat_runs_db_begin(ctx, {
				thread: (await ctx.db.get("ai_chat_threads", threadId))!,
				kind: "chat",
				source: {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: actingUserId,
					membershipId: seeded.membershipId,
					membershipLifetime,
				},
				triggerId,
				modeId: "agent",
				modelId: ai_chat_DEFAULT_MODEL_ID,
				now: Date.now(),
			});
			if (!begun) throw new Error("Expected the bash test run to start");
			return { runId: begun.runId, generation: begun.generation };
		});
	const chatRun = await start_chat_run();

	let cwd = "~";
	if (opts?.initialCwd != null && opts.initialCwd !== "~") {
		// The first call creates the shell row, so seed it here to start somewhere else.
		await t.run(async (ctx) => {
			await ctx.db.insert("ai_chat_bash_shells", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				threadId,
				name: "default",
				cwd: opts.initialCwd!,
				cwdTarget: null,
				state: null,
				transcriptBytes: 0,
				transcriptEntries: 0,
				transcriptSeq: 0,
				updatedBy: actingUserId,
				updatedAt: Date.now(),
			});
		});
		cwd = opts.initialCwd;
	}

	// Spy-delegate ctx: every downstream function runs for real against the in-memory db
	// while the spies keep call-shape assertions (toHaveBeenCalledWith) working.
	const testQuery = t.query as unknown as (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
	const testMutation = t.mutation as unknown as (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
	const testAction = t.action as unknown as (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
	const runQuery = vi.fn(async (ref: unknown, queryArgs: Record<string, unknown>) => {
		if (function_name_of(ref) === "files_transfer:get_for_agent") {
			const runId = queryArgs.runId as Id<"files_transfer_runs">;
			// Workpool is mocked. Drive the real transfer when the shell checks its result.
			for (let step = 0; step < 200; step++) {
				const activity = await t.run((ctx) =>
					ctx.db
						.query("activities")
						.withIndex("by_source_id", (q) => q.eq("source.id", runId))
						.unique(),
				);
				if (!activity || !["queued", "running", "stopping"].includes(activity.status)) break;
				await t.mutation(internal.files_transfer.advance, { runId });
				const items = await t.run((ctx) =>
					ctx.db
						.query("files_transfer_items")
						.withIndex("by_run_state_order", (q) => q.eq("runId", runId).eq("state", "copying"))
						.collect(),
				);
				for (const item of items) {
					let result: { kind: "success"; returnValue: null } | { kind: "failed"; error: string };
					try {
						await t.action(internal.files_nodes_content.copy_transfer_file, {
							itemId: item._id,
							attempt: item.attempt,
						});
						result = { kind: "success", returnValue: null };
					} catch (error) {
						result = { kind: "failed", error: String(error) };
					}
					await t.mutation(internal.files_transfer.handle_copy_complete, {
						workId: item.workId!,
						context: { itemId: item._id, attempt: item.attempt },
						result,
					});
				}
			}
		}
		return await testQuery(ref, queryArgs);
	});
	const runMutation = vi.fn((ref: unknown, mutationArgs: Record<string, unknown>) => testMutation(ref, mutationArgs));
	const runAction = vi.fn((ref: unknown, actionArgs: Record<string, unknown>) => testAction(ref, actionArgs));
	const ctx = { runQuery, runMutation, runAction } as unknown as ActionCtx;
	const names = await t.run(async (ctx) => {
		const organization = await ctx.db.get("organizations", seeded.organizationId);
		const workspace = await ctx.db.get("organizations_workspaces", seeded.workspaceId);
		if (!organization || !workspace) throw new Error("Expected the seeded workspace");
		return { organizationName: organization.name, workspaceName: workspace.name };
	});

	const ctxData = {
		organizationId: seeded.organizationId,
		workspaceId: seeded.workspaceId,
		...names,
		userId: actingUserId,
		membershipId: seeded.membershipId,
		membershipLifetime,
		threadId,
	};

	let toolCallNumber = 0;
	const run = async (args: { command: string; toolCallId?: string; shellName?: string }) => {
		const { toolCallId = `bash-${runnerIndex}-${toolCallNumber++}`, shellName = "default", command } = args;

		// A job end can start a wake that takes over an expired run, and the wake can end too. Like the
		// next turn in the app, the call runs in the live run, or in a new one.
		const liveRun = await start_chat_run();
		const result = await bash_run_command(ctx, {
			...ctxData,
			threadId,
			toolCallId,
			command,
			allowDbFilesMkdir: opts?.allowDbFilesMkdir ?? true,
			shellName,
			wakeAgent: opts?.wakeAgent ?? null,
			output: null,
			run: liveRun,
		});
		cwd = (await get_shell({ t, threadId, name: shellName }))?.cwd ?? cwd;
		return result;
	};

	return { run, runQuery, runMutation, runAction, getCwd: () => cwd, t, seeded, threadId, chatRun, ctxData, ctx };
}

/**
 * A shell row of a thread, as the last call left it.
 */
export async function get_shell(args: {
	t: ReturnType<typeof test_convex>;
	threadId: Id<"ai_chat_threads">;
	name?: string;
}) {
	const { t, threadId, name = "default" } = args;

	return await t.run((ctx) =>
		ctx.db
			.query("ai_chat_bash_shells")
			.withIndex("by_thread_name", (q) => q.eq("threadId", threadId).eq("name", name))
			.unique(),
	);
}

export async function get_seeded_node(runner: Awaited<ReturnType<typeof create_bash_runner>>, path: string) {
	const dbFilesDoc = await runner.t.run((ctx) =>
		ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", runner.seeded.organizationId)
					.eq("workspaceId", runner.seeded.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("path", path)
					.eq("archiveOperationId", null),
			)
			.first(),
	);
	if (!dbFilesDoc) {
		throw new Error(`No seeded node at ${path}`);
	}
	return dbFilesDoc;
}

export async function get_seeded_node_id(runner: Awaited<ReturnType<typeof create_bash_runner>>, path: string) {
	return (await get_seeded_node(runner, path))._id;
}

export async function job_row(runner: Awaited<ReturnType<typeof create_bash_runner>>, jobNumber: number) {
	const row = await runner.t.run(async (ctx) =>
		(await ctx.db.query("ai_chat_bash_invocations").collect()).find((row) => row.job?.jobNumber === jobNumber),
	);
	if (!row?.job) throw new Error(`Expected job ${jobNumber}`);
	return { ...row, job: row.job };
}

export async function get_private_entry(runner: Awaited<ReturnType<typeof create_bash_runner>>, path: string) {
	const entry = await runner.t.query(internal.files_nodes.get_visible_entry_by_path, {
		organizationId: runner.seeded.organizationId,
		workspaceId: runner.seeded.workspaceId,
		visibilityUserId: runner.ctxData.userId,
		overlayUserId: runner.ctxData.userId,
		path,
	});
	if (entry?.kind !== "private") throw new Error(`No private draft at ${path}`);
	return entry;
}

export async function list_pending_updates(runner: Awaited<ReturnType<typeof create_bash_runner>>) {
	return await runner.t.run(async (ctx) =>
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_organization_workspace_user_target", (q) =>
				q
					.eq("organizationId", runner.ctxData.organizationId)
					.eq("workspaceId", runner.ctxData.workspaceId)
					.eq("userId", runner.ctxData.userId),
			)
			.collect(),
	);
}

/**
 * Seed one pending content proposal through the real agent flow: stage the text under a
 * server-side batch, then run the finishing internal action that carries only ids. The
 * target file must be seeded `withRealYjsSnapshot: true`, because the action reconstructs
 * the live base state from the stored snapshot. `stagedText` and `copiedFrom` build the doc
 * shape a partial save or a replace-move needs.
 */
export async function upsert_pending_update_for_test(
	runner: Awaited<ReturnType<typeof create_bash_runner>>,
	args: {
		target: files_PendingTarget;
		stagedText?: string;
		unstagedText: string;
		copiedFrom?: { nodeId: Id<"files_nodes">; path: string };
	},
) {
	const batch = await runner.t.mutation(
		internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
		{
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId: runner.seeded.userId,
			target: args.target,
		},
	);
	if (batch._nay) {
		throw new Error(batch._nay.message);
	}
	const operationBatchId = batch._yay.operationBatchId;
	if (args.stagedText !== undefined) {
		const stagedRole = await runner.t.mutation(
			internal.files_pending_updates.stage_file_pending_update_text_input_internal,
			{
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				userId: runner.seeded.userId,
				operationBatchId,
				role: "staged",
				text: args.stagedText,
			},
		);
		if (stagedRole._nay) {
			throw new Error(stagedRole._nay.message);
		}
	}
	const staged = await runner.t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
		organizationId: runner.seeded.organizationId,
		workspaceId: runner.seeded.workspaceId,
		userId: runner.seeded.userId,
		operationBatchId,
		role: "unstaged",
		text: args.unstagedText,
	});
	if (staged._nay) {
		throw new Error(staged._nay.message);
	}
	const upserted = await runner.t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
		organizationId: runner.seeded.organizationId,
		workspaceId: runner.seeded.workspaceId,
		userId: runner.seeded.userId,
		target: args.target,
		operationBatchId,
		...(args.copiedFrom
			? { copiedFrom: { target: { kind: "saved" as const, id: args.copiedFrom.nodeId }, path: args.copiedFrom.path } }
			: {}),
	});
	if (upserted._nay) {
		throw new Error(upserted._nay.message);
	}
}

/**
 * The seeded user signed in like the Files UI, for the public accept, discard, and
 * collaboration doors.
 */
export function runner_as_user(runner: Awaited<ReturnType<typeof create_bash_runner>>) {
	return runner.t.withIdentity({
		issuer: "https://clerk.test",
		subject: `clerk-${runner.seeded.userId}`,
		external_id: runner.seeded.userId,
		email: "bash-runner-user@test.local",
	});
}

/**
 * Every pending update row of one file, in index order. Structural rows and copy rows both count.
 */
export async function list_pending_updates_for_node(
	runner: Awaited<ReturnType<typeof create_bash_runner>>,
	nodeId: Id<"files_nodes">,
) {
	return await runner.t.run((ctx) =>
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", nodeId))
			.collect(),
	);
}

export async function pending_review_for_test(
	runner: Awaited<ReturnType<typeof create_bash_runner>>,
	nodeId: Id<"files_nodes">,
) {
	const pendingUpdate = (await list_pending_updates_for_node(runner, nodeId)).find(
		(pending) => pending.userId === runner.seeded.userId,
	);
	if (!pendingUpdate) throw new Error("No pending update to review");
	return {
		membershipId: runner.seeded.membershipId,
		target: { kind: "saved" as const, id: nodeId },
		pendingUpdateId: pendingUpdate._id,
		reviewedRevision: pendingUpdate.revision,
	};
}

/**
 * Review every move in one connected group through the same job as the Files panel.
 */
export async function accept_pending_move_group_for_test(
	runner: Awaited<ReturnType<typeof create_bash_runner>>,
	nodeIds: Id<"files_nodes">[],
) {
	const hadFakeTimers = vi.isFakeTimers();
	if (!hadFakeTimers) vi.useFakeTimers();
	try {
		const asUser = runner_as_user(runner);
		const reviews = await Promise.all(nodeIds.map((nodeId) => pending_review_for_test(runner, nodeId)));
		const started = await asUser.mutation(api.files_pending_update_runs.start, {
			membershipId: runner.seeded.membershipId,
			requestId: crypto.randomUUID(),
			kind: "accept",
			expectedItemCount: reviews.length,
			items: reviews.map(({ pendingUpdateId, reviewedRevision }) => ({
				pendingUpdateId,
				reviewedRevision,
				selectedContentStateId: null,
			})),
		});
		if (started._nay) throw new Error(started._nay.message);
		const { runId } = started._yay;
		expect(
			await asUser.mutation(api.files_pending_update_runs.seal, { membershipId: runner.seeded.membershipId, runId }),
		).toEqual({ _yay: null });
		await test_finish_pending_update_run(asUser, runId);
		const unit = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_update_run_units")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.unique(),
		);
		if (!unit) throw new Error("Expected one connected move group");
		const result = await asUser.query(api.files_pending_update_runs.get, {
			membershipId: runner.seeded.membershipId,
			runId,
		});
		expect(result?.activity.status).toBe("succeeded");
		expect(result?.activity.progress?.completed).toBe(nodeIds.length);
	} finally {
		if (!hadFakeTimers) vi.useRealTimers();
	}
}

/**
 * Save the seeded user's proposal on `nodeId` like the Files UI does, then run the
 * materialization the save enqueued. The Workpool enqueue is mocked in this suite, so the
 * committed chunks and the version snapshot only update when the test runs the worker.
 * The save publishes the `staged` branch only; see `accept_pending_update_for_test`.
 */
export async function save_pending_update_for_test(
	runner: Awaited<ReturnType<typeof create_bash_runner>>,
	nodeId: Id<"files_nodes">,
) {
	const saved = await test_save_file_pending_update(
		runner_as_user(runner),
		await pending_review_for_test(runner, nodeId),
	);
	if (saved._nay) {
		throw new Error(saved._nay.message);
	}
	if (saved._yay.newSequence !== null) {
		const materialized = await runner.t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			nodeId,
			userId: runner.seeded.userId,
			targetSequence: saved._yay.newSequence,
		});
		if (materialized._nay) {
			throw new Error(materialized._nay.message);
		}
	}
	return saved._yay;
}

/**
 * Accept an agent proposal the way the Pending changes panel does: read the proposed text,
 * stage it as both `staged` and `unstaged`, then save. An agent write stages no `staged`
 * text, so a bare save would publish nothing and keep the doc as a partial save.
 */
export async function accept_pending_update_for_test(
	runner: Awaited<ReturnType<typeof create_bash_runner>>,
	args: { nodeId: Id<"files_nodes">; path: string },
) {
	const proposed = await runner.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
		organizationId: runner.seeded.organizationId,
		workspaceId: runner.seeded.workspaceId,
		userId: runner.seeded.userId,
		path: args.path,
		overlayUserId: runner.seeded.userId,
	});
	if (!proposed) {
		throw new Error(`No proposed text at ${args.path}`);
	}
	await upsert_pending_update_for_test(runner, {
		target: { kind: "saved", id: args.nodeId },
		stagedText: proposed.content,
		unstagedText: proposed.content,
	});
	return await save_pending_update_for_test(runner, args.nodeId);
}

export async function save_private_copy_for_test(runner: Awaited<ReturnType<typeof create_bash_runner>>, path: string) {
	const draft = await get_private_entry(runner, path);
	const target = { kind: "private" as const, id: draft.node._id };
	const saved = await test_save_file_pending_update(runner_as_user(runner), {
		membershipId: runner.seeded.membershipId,
		target,
		pendingUpdateId: draft.pendingUpdate._id,
		reviewedRevision: draft.pendingUpdate.revision,
	});
	if (saved._nay) throw new Error(saved._nay.message);
	if (saved._yay.target.kind !== "saved") throw new Error("Draft was not published");
	return saved._yay.target.id;
}

/**
 * Push one rich text edit into a file's Yjs document without saving it, like a live editor
 * session does.
 */
export async function push_unsaved_rich_text_edit(args: {
	runner: Awaited<ReturnType<typeof create_bash_runner>>;
	fileNode: Awaited<ReturnType<typeof get_seeded_node>>;
	text: string;
}) {
	const { runner, fileNode, text } = args;

	const editedYjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text });
	if ("_nay" in editedYjsDoc) {
		throw new Error(editedYjsDoc._nay.message);
	}
	await runner.t.run(async (ctx) =>
		files_db_yjs_push_update(ctx, {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId: runner.seeded.userId,
			nodeId: fileNode._id,
			expectedYjsLastSequenceId: fileNode.yjsLastSequenceId!,
			rootKind: "rich_text",
			update: files_u8_to_array_buffer(encodeStateAsUpdate(editedYjsDoc)),
			sessionId: "bash-test-editor-session",
			materializeImmediately: false,
		}),
	);
}

/**
 * Accept the seeded user's whole-file copy the way the Pending changes panel does.
 */
export async function accept_pending_replacement_for_test(
	runner: Awaited<ReturnType<typeof create_bash_runner>>,
	nodeId: Id<"files_nodes">,
) {
	const row = (await list_pending_updates_for_node(runner, nodeId)).find((row) => row.userId === runner.seeded.userId);
	if (!row) {
		throw new Error("No pending copy to accept");
	}
	const accepted = await runner_as_user(runner).action(api.files_pending_updates.accept_file_pending_replacement, {
		membershipId: runner.seeded.membershipId,
		target: { kind: "saved", id: nodeId },
		pendingUpdateId: row._id,
		reviewedRevision: row.revision,
	});
	if (accepted._nay) {
		throw new Error(accepted._nay.message);
	}
}

/**
 * Read the committed chunk text of one file, without the seeded user's pending overlay.
 */
export async function read_committed_text(
	runner: Awaited<ReturnType<typeof create_bash_runner>>,
	nodeId: Id<"files_nodes">,
) {
	return await runner.t.run(async (ctx) => {
		const chunks = await ctx.db
			.query("files_text_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
				q
					.eq("organizationId", runner.seeded.organizationId)
					.eq("workspaceId", runner.seeded.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", nodeId),
			)
			.collect();
		return chunks
			.sort((left, right) => left.chunkIndex - right.chunkIndex)
			.map((chunk) => chunk.textChunk)
			.join("");
	});
}

/**
 * The content assets one file's version history points at, oldest first.
 */
export async function version_snapshot_asset_ids(
	runner: Awaited<ReturnType<typeof create_bash_runner>>,
	nodeId: Id<"files_nodes">,
) {
	return await runner.t.run(async (ctx) => {
		const snapshots = await ctx.db
			.query("files_snapshots")
			.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
				q
					.eq("organizationId", runner.seeded.organizationId)
					.eq("workspaceId", runner.seeded.workspaceId)
					.eq("fileNodeId", nodeId),
			)
			.collect();
		return snapshots.map((snapshot) => snapshot.assetId);
	});
}

/**
 * Count the version snapshots of one file. A direct save on a file with collaboration
 * off stores one per save.
 */
export async function count_version_snapshots(
	runner: Awaited<ReturnType<typeof create_bash_runner>>,
	nodeId: Id<"files_nodes">,
) {
	return (await version_snapshot_asset_ids(runner, nodeId)).length;
}

/**
 * The text one version's content object holds in the test bucket.
 */
export async function read_version_text(
	runner: Awaited<ReturnType<typeof create_bash_runner>>,
	assetId: Id<"files_r2_assets">,
) {
	const asset = await runner.t.run((ctx) => ctx.db.get("files_r2_assets", assetId));
	const bytes = asset?.r2Key === undefined ? undefined : test_r2_objects.get(asset.r2Key);
	if (!bytes) {
		throw new Error("The version's content is missing from the test bucket");
	}
	return new TextDecoder().decode(bytes);
}

/**
 * Run the paged cleanup that turning collaboration off schedules. `runAfter(0, ...)` sets
 * a real timer, so yield first, and repeat because one page can schedule the next.
 */
export async function drain_scheduled_continuations(runner: Awaited<ReturnType<typeof create_bash_runner>>) {
	for (let round = 0; round < 5; round += 1) {
		await delay(0);
		await runner.t.finishInProgressScheduledFunctions();
	}
}

// Plain text copy fixtures. A copy keeps the source's type, so nothing is ever parsed as
// Markdown. The lossy text carries an HTML comment that a Markdown parse would drop; the
// copy tests check it survives.
export const plain_copy_canonical =
	'{\n  "name": "demo",\n  "items": [1, 2, 3],\n  "nested": {\n    "deep": true\n  }\n}\n';
export const plain_copy_lossy = "alpha line\n\n<!-- only in the plain file -->\n\nbeta line\n";

export const activity_of = async (runner: Awaited<ReturnType<typeof create_bash_runner>>, jobNumber: number) => {
	const row = await job_row(runner, jobNumber);
	return await runner.t.run((ctx) =>
		ctx.db
			.query("activities")
			.withIndex("by_source_id", (q) => q.eq("source.id", row._id))
			.unique(),
	);
};

// The pool is mocked, so a job runs only when the test runs its worker.
export const run_job = async (runner: Awaited<ReturnType<typeof create_bash_runner>>, jobNumber: number) => {
	const row = await job_row(runner, jobNumber);
	await bash_run_job(runner.ctx, { invocationId: row._id, workerGeneration: row.job!.workerGeneration });
	return await job_row(runner, jobNumber);
};

export const mutation_calls = (runner: Awaited<ReturnType<typeof create_bash_runner>>, name: string) =>
	runner.runMutation.mock.calls.filter(([ref]) => function_name_of(ref) === name).length;
