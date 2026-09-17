import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { encodeStateAsUpdate } from "yjs";
import { api, internal } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel";
import type { ActionCtx, MutationCtx } from "../convex/_generated/server.js";
import {
	ai_chat_files_db_delete_job_batch,
	type ai_chat_files_patch_thread_tmp_files_Args,
} from "../convex/ai_chat_files.ts";
import type { bash_ReviewScratch } from "../convex/bash.ts";
import { access_control_db_ensure_role_assignment } from "../convex/access_control.ts";
import { files_db_yjs_push_update } from "../convex/files_nodes.ts";
import { db_insert_file_text_content } from "../convex/files_nodes_content.ts";
import { files_PENDING_REPLACEMENT_BASE_CHANGED_MESSAGE } from "../convex/files_pending_updates.ts";
import { r2_confirmed_object_delete, r2_server_side_copy } from "../convex/r2_client.ts";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import type { ai_chat_ModelId } from "../shared/ai-chat.ts";
import { delay } from "../shared/async-utils.ts";
import { files_yjs_doc_create_from_text } from "../shared/files-tiptap.ts";
import {
	type files_PendingTarget,
	files_ROOT_ID,
	files_guess_content_type_from_name,
	files_u8_to_array_buffer,
	files_yjs_root_kind_of_content_type,
} from "../shared/files.ts";
import {
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
} from "../shared/organizations.ts";
import { bash_run_command, bash_run_job } from "./bash.ts";
import {
	bash_COMMAND_EXIT_CANNOT_EXECUTE,
	bash_COMMAND_EXIT_NOT_FOUND,
	bash_COMMAND_EXIT_USAGE,
	bash_JOB_NUMBERS_MAX_COUNT,
	bash_READER_FILE_OPERAND_MAX,
	bash_READ_HEAD_LARGE_FILE_MAX_LINES,
	bash_READ_INLINE_MAX_BYTES,
} from "./bash-utils.ts";
import { ai_chat_tool_create_edit_file, ai_chat_tool_create_set_file_metadata } from "./server-ai-tools.ts";

const test_db_files_mount = "/home/cloud-usr/w/personal/home";
const function_name_of = (ref: unknown) => {
	try {
		return getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
	} catch {
		return null;
	}
};

describe("bash_run_command", () => {
	const test_organization_name = "personal";
	const test_workspace_name = "home";

	// Full object bytes served by the stubbed global fetch, keyed by files_r2_assets.r2Key. The
	// R2 client's getUrl is spied to embed the key in the URL so the bounded window readers
	// exercise real HTTP Range parsing against this store.
	const test_r2_objects = new Map<string, Uint8Array>();
	let test_runner_counter = 0;

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
					test_r2_objects.set(decodeURIComponent(url.searchParams.get("key") ?? ""), bytes);
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
					return new Response(bytes.slice(start, endInclusive + 1), { status: 206 });
				}
				return new Response(bytes.slice(0), { status: 200 });
			}),
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
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
	const readme_seed_content = "# Readme\nunique-token here\nmore unique-token below\n";
	const readme_copy_content = "# Readme\n\nunique-token here\nmore unique-token below\n";
	const default_organization_files: BashSeedSpec[] = [
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
	const big_md_file: BashSeedSpec = {
		path: "/big.md",
		content: `${Array.from({ length: 1000 }, (_, index) => `line ${index + 1}${index === 749 ? "x".repeat(bash_READ_INLINE_MAX_BYTES) : ""}`).join("\n")}\n`,
	};

	async function seed_organization_folder(
		ctx: MutationCtx,
		scope: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; userId: Id<"users"> },
		path: string,
		updatedAt: number,
	) {
		const segments = path.split("/").filter(Boolean);
		let parentId: Id<"files_nodes"> | typeof files_ROOT_ID = files_ROOT_ID;
		for (let depth = 1; depth <= segments.length; depth++) {
			const ancestorPath = `/${segments.slice(0, depth).join("/")}`;
			const existing = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", scope.organizationId)
						.eq("workspaceId", scope.workspaceId)
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
				updatedAt,
			});
		}
		return parentId;
	}

	async function seed_organization_node(
		ctx: MutationCtx,
		scope: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; userId: Id<"users"> },
		spec: BashSeedSpec,
		seedIndex: number,
	) {
		// Deterministic, distinct recency: later seeds are newer.
		const updatedAt = spec.updatedAt ?? Date.now() - 1_000_000 + seedIndex * 1000;
		const segments = spec.path.split("/").filter(Boolean);
		if (spec.kind === "folder") {
			await seed_organization_folder(ctx, scope, spec.path, updatedAt);
			return;
		}
		const parentId =
			segments.length > 1
				? await seed_organization_folder(ctx, scope, `/${segments.slice(0, -1).join("/")}`, updatedAt)
				: files_ROOT_ID;
		const name = segments[segments.length - 1];
		const dotIndex = name.lastIndexOf(".");
		const content = spec.content ?? "";
		const bytes = new TextEncoder().encode(content);
		// The stored type decides the shape, exactly like the production create path. A seed
		// without a type takes the hint from its name and falls back to Markdown.
		const seedContentType =
			spec.contentType ?? files_guess_content_type_from_name(name) ?? "text/markdown;charset=utf-8";
		const seedRootKind = files_yjs_root_kind_of_content_type(seedContentType) ?? "rich_text";
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

	async function create_bash_runner(opts?: {
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
					await seed_organization_node(
						ctx,
						{ organizationId: seeded.organizationId, workspaceId: seeded.workspaceId, userId: seeded.userId },
						spec,
						seedIndex,
					);
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

		const ctxData = {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			organizationName: test_organization_name,
			workspaceName: test_workspace_name,
			userId: actingUserId,
			threadId,
		};

		let toolCallNumber = 0;
		const run = async (
			command: string,
			toolCallId = `bash-${runnerIndex}-${toolCallNumber++}`,
			shellName = "default",
		) => {
			const result = await bash_run_command(ctx, {
				...ctxData,
				threadId,
				toolCallId,
				command,
				allowDbFilesMkdir: opts?.allowDbFilesMkdir ?? true,
				shellName,
				wakeAgent: opts?.wakeAgent ?? null,
			});
			cwd = (await get_shell(t, threadId, shellName))?.cwd ?? cwd;
			return result;
		};

		return { run, runQuery, runMutation, runAction, getCwd: () => cwd, t, seeded, threadId, ctxData, ctx };
	}

	/**
	 * A shell row of a thread, as the last call left it.
	 */
	async function get_shell(t: ReturnType<typeof test_convex>, threadId: Id<"ai_chat_threads">, name = "default") {
		return await t.run((ctx) =>
			ctx.db
				.query("ai_chat_bash_shells")
				.withIndex("by_thread_name", (q) => q.eq("threadId", threadId).eq("name", name))
				.unique(),
		);
	}

	async function get_seeded_node(runner: Awaited<ReturnType<typeof create_bash_runner>>, path: string) {
		const dbFilesDoc = await runner.t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", runner.seeded.organizationId)
						.eq("workspaceId", runner.seeded.workspaceId)
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

	async function get_seeded_node_id(runner: Awaited<ReturnType<typeof create_bash_runner>>, path: string) {
		return (await get_seeded_node(runner, path))._id;
	}

	async function job_row(runner: Awaited<ReturnType<typeof create_bash_runner>>, jobNumber: number) {
		const row = await runner.t.run(async (ctx) =>
			(await ctx.db.query("ai_chat_bash_invocations").collect()).find((row) => row.job?.jobNumber === jobNumber),
		);
		if (!row?.job) throw new Error(`Expected job ${jobNumber}`);
		return row;
	}

	async function get_private_entry(runner: Awaited<ReturnType<typeof create_bash_runner>>, path: string) {
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

	async function list_pending_updates(runner: Awaited<ReturnType<typeof create_bash_runner>>) {
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
	async function upsert_pending_update_for_test(
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
		const staged = await runner.t.mutation(
			internal.files_pending_updates.stage_file_pending_update_text_input_internal,
			{
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				userId: runner.seeded.userId,
				operationBatchId,
				role: "unstaged",
				text: args.unstagedText,
			},
		);
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
	function runner_as_user(runner: Awaited<ReturnType<typeof create_bash_runner>>) {
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
	async function list_pending_updates_for_node(
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

	async function pending_review_for_test(
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
	async function accept_pending_move_group_for_test(
		runner: Awaited<ReturnType<typeof create_bash_runner>>,
		nodeIds: Id<"files_nodes">[],
	) {
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
		await runner.t.action(internal.files_pending_update_runs.plan, { runId, fence: 0 });
		await runner.t.mutation(internal.files_pending_update_runs.advance, { runId });
		const unit = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_update_run_units")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.unique(),
		);
		if (!unit) throw new Error("Expected one connected move group");
		await runner.t.action(internal.files_pending_update_runs.prepare_unit, {
			runId,
			fence: 0,
			unitId: unit._id,
			attemptFence: unit.attemptFence,
		});
		await runner.t.mutation(internal.files_pending_update_runs.advance, { runId });
		const result = await asUser.query(api.files_pending_update_runs.get, {
			membershipId: runner.seeded.membershipId,
			runId,
		});
		expect(result?.activity.status).toBe("succeeded");
		expect(result?.activity.progress?.completed).toBe(nodeIds.length);
	}

	/**
	 * Save the seeded user's proposal on `nodeId` like the Files UI does, then run the
	 * materialization the save enqueued. The Workpool enqueue is mocked in this suite, so the
	 * committed chunks and the version snapshot only update when the test runs the worker.
	 * The save publishes the `staged` branch only; see `accept_pending_update_for_test`.
	 */
	async function save_pending_update_for_test(
		runner: Awaited<ReturnType<typeof create_bash_runner>>,
		nodeId: Id<"files_nodes">,
	) {
		const saved = await runner_as_user(runner).action(
			api.files_pending_updates.save_file_pending_update,
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
	async function accept_pending_update_for_test(
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

	async function save_private_copy_for_test(runner: Awaited<ReturnType<typeof create_bash_runner>>, path: string) {
		const draft = await get_private_entry(runner, path);
		const target = { kind: "private" as const, id: draft.node._id };
		const saved = await runner_as_user(runner).action(api.files_pending_updates.save_file_pending_update, {
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
	async function push_unsaved_rich_text_edit(
		runner: Awaited<ReturnType<typeof create_bash_runner>>,
		fileNode: Awaited<ReturnType<typeof get_seeded_node>>,
		text: string,
	) {
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
	async function accept_pending_replacement_for_test(
		runner: Awaited<ReturnType<typeof create_bash_runner>>,
		nodeId: Id<"files_nodes">,
	) {
		const row = (await list_pending_updates_for_node(runner, nodeId)).find(
			(row) => row.userId === runner.seeded.userId,
		);
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
	async function read_committed_text(
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
	async function version_snapshot_asset_ids(
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
	async function count_version_snapshots(
		runner: Awaited<ReturnType<typeof create_bash_runner>>,
		nodeId: Id<"files_nodes">,
	) {
		return (await version_snapshot_asset_ids(runner, nodeId)).length;
	}

	/**
	 * The text one version's content object holds in the test bucket.
	 */
	async function read_version_text(
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
	async function drain_scheduled_continuations(runner: Awaited<ReturnType<typeof create_bash_runner>>) {
		for (let round = 0; round < 5; round += 1) {
			await delay(0);
			await runner.t.finishInProgressScheduledFunctions();
		}
	}

	// Plain text copy fixtures. A copy keeps the source's type, so nothing is ever parsed as
	// Markdown. The lossy text carries an HTML comment that a Markdown parse would drop; the
	// copy tests check it survives.
	const plain_copy_canonical = '{\n  "name": "demo",\n  "items": [1, 2, 3],\n  "nested": {\n    "deep": true\n  }\n}\n';
	const plain_copy_lossy = "alpha line\n\n<!-- only in the plain file -->\n\nbeta line\n";

	test("runs pwd and persists cd across invocations", async () => {
		const { run, getCwd } = await create_bash_runner();

		const pwdResult = await run("pwd");
		expect(pwdResult.stdout.trim()).toBe(test_db_files_mount);
		expect(pwdResult.metadata.cwd).toBe(test_db_files_mount);
		expect(getCwd()).toBe(test_db_files_mount);

		const cdResult = await run(`cd ${test_db_files_mount}/docs`);
		expect(cdResult.metadata.nextCwd).toBe(`${test_db_files_mount}/docs`);
		expect(getCwd()).toBe(`${test_db_files_mount}/docs`);

		const nextPwdResult = await run("pwd");
		expect(nextPwdResult.stdout.trim()).toBe(`${test_db_files_mount}/docs`);
	});

	test("sets HOME to the cloud user home", async () => {
		const { run } = await create_bash_runner();

		const result = await run("printf $HOME");

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe("/home/cloud-usr");
	});

	test("replays a completed Bash call without repeating scratch or private writes", async () => {
		const runner = await create_bash_runner();
		const command = "printf once >> /tmp/replay.txt; printf draft >> draft-replay.txt";
		const first = await runner.run(command, "replay-write");
		expect(first.metadata.exitCode).toBe(0);
		const draft = await get_private_entry(runner, "/draft-replay.txt");

		expect(await runner.run(command, "replay-write")).toEqual(first);
		expect((await runner.run("cat /tmp/replay.txt; cat draft-replay.txt")).stdout).toBe("oncedraft");
		const unchanged = await get_private_entry(runner, "/draft-replay.txt");
		expect(unchanged.pendingUpdate).toEqual(draft.pendingUpdate);
		await expect(runner.run("printf changed >> /tmp/replay.txt", "replay-write")).rejects.toThrow(
			"already has a different command",
		);
		expect((await runner.run("cat /tmp/replay.txt")).stdout).toBe("once");
	});

	test("reads a lost Bash begin reply without starting its interpreter", async () => {
		const runner = await create_bash_runner();
		const mutate = runner.runMutation.getMockImplementation()!;
		let lostReply = false;
		runner.runMutation.mockImplementation(async (ref, args) => {
			const result = await mutate(ref, args);
			if (!lostReply && function_name_of(ref) === "ai_chat_files:begin_bash_invocation") {
				lostReply = true;
				throw new Error("Lost begin reply");
			}
			return result;
		});

		const result = await runner.run("printf once >> /tmp/lost-begin.txt", "lost-begin");
		expect(lostReply).toBe(true);
		expect(result.metadata.exitCode).toBe(3);
		expect(result.stderr).toContain("still running");
		expect(
			runner.runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "ai_chat_files:get_bash_invocation"),
		).toBe(true);
		expect((await runner.run("test -e /tmp/lost-begin.txt")).metadata.exitCode).toBe(1);
		const replay = await runner.run("printf once >> /tmp/lost-begin.txt", "lost-begin");
		expect(replay.metadata.exitCode).toBe(3);
		expect((await runner.run("test -e /tmp/lost-begin.txt")).metadata.exitCode).toBe(1);
	});

	test("replays a saved Bash result after its finish reply is lost", async () => {
		const runner = await create_bash_runner();
		const mutate = runner.runMutation.getMockImplementation()!;
		let lostReply = false;
		runner.runMutation.mockImplementation(async (ref, args) => {
			const result = await mutate(ref, args);
			if (!lostReply && function_name_of(ref) === "ai_chat_files:finish_bash_invocation") {
				lostReply = true;
				throw new Error("Lost finish reply");
			}
			return result;
		});

		await expect(runner.run("printf once >> /tmp/lost-finish.txt", "lost-finish")).rejects.toThrow("Lost finish reply");
		const replay = await runner.run("printf once >> /tmp/lost-finish.txt", "lost-finish");
		expect(replay.metadata.exitCode).toBe(0);
		expect((await runner.run("cat /tmp/lost-finish.txt")).stdout).toBe("once");
	});

	test("does not restart an interrupted Bash call with partial scratch writes", async () => {
		const runner = await create_bash_runner();
		const mutate = runner.runMutation.getMockImplementation()!;
		let interrupted = false;
		runner.runMutation.mockImplementation(async (ref, args) => {
			if (!interrupted && function_name_of(ref) === "ai_chat_files:finish_bash_invocation") {
				interrupted = true;
				throw new Error("Finish unavailable");
			}
			return await mutate(ref, args);
		});

		await expect(runner.run("printf once >> /tmp/interrupted.txt", "interrupted")).rejects.toThrow(
			"Finish unavailable",
		);
		const replay = await runner.run("printf once >> /tmp/interrupted.txt", "interrupted");
		expect(replay.metadata.exitCode).toBe(1);
		expect(replay.stderr).toContain("was interrupted");
		expect((await runner.run("cat /tmp/interrupted.txt")).stdout).toBe("once");
	});

	test.each([false, true])(
		"returns 124 when final scratch persistence passes the deadline (watchdog: %s)",
		async (watchdog) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			try {
				const runner = await create_bash_runner();
				const mutate = runner.runMutation.getMockImplementation()!;
				runner.runMutation.mockImplementation(async (ref, args) => {
					const saved = await mutate(ref, args);
					if (function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files") {
						const invocation = await runner.t.run((ctx) => ctx.db.query("ai_chat_bash_invocations").first());
						if (!invocation) throw new Error("Expected invocation");
						vi.setSystemTime(invocation.deadlineAt + 1);
						if (watchdog)
							await runner.t.mutation(internal.ai_chat_files.interrupt_bash_invocation, {
								invocationId: invocation._id,
							});
					}
					return saved;
				});

				const command = "printf once >> /tmp/late-persistence.txt";
				const completed = await runner.run(command, "late-persistence");
				expect(completed.metadata.exitCode).toBe(124);
				expect(completed.stderr).toContain("deadline");
				expect((await runner.run(command, "late-persistence")).metadata.exitCode).toBe(124);
				const stored = await runner.t.run((ctx) => ctx.db.query("ai_chat_bash_invocations").first());
				expect(stored?.status).toBe("interrupted");
				expect((await runner.run("cat /tmp/late-persistence.txt")).stdout).toBe("once");
			} finally {
				vi.useRealTimers();
			}
		},
	);

	test("repairs an interrupted finish whose cwd holds half a character", async () => {
		const runner = await create_bash_runner();
		const mutate = runner.runMutation.getMockImplementation()!;
		runner.runMutation.mockImplementation(async (ref, args) => {
			const result = await mutate(ref, args);
			if (
				function_name_of(ref) === "ai_chat_files:finish_bash_invocation" &&
				result !== null &&
				typeof result === "object" &&
				"_yay" in result &&
				result._yay !== null &&
				typeof result._yay === "object"
			) {
				return { _yay: { ...result._yay, result: null, deadlineAt: Date.now() - 1 } };
			}
			return result;
		});

		// `cd` into a `/tmp` name that holds half a character. The usual return goes through
		// `bash_response`, but this branch rebuilds `title` from the raw cwd after finish answers
		// with no stored result. Convex then refuses the whole return.
		const completed = await runner.run("mkdir /tmp/$(printf '\\ud83c'); cd /tmp/$(printf '\\ud83c')");
		expect(completed.metadata.exitCode).toBe(124);
		expect(completed.title.startsWith("exit 124 · /tmp/")).toBe(true);
		expect(completed.title.isWellFormed()).toBe(true);
	});

	test.each([
		{ rejoin: false, persist: "scratch" },
		{ rejoin: true, persist: "scratch" },
		{ rejoin: false, persist: "result" },
		{ rejoin: true, persist: "result" },
	])("refuses late $persist writes after membership removal (rejoin: $rejoin)", async ({ rejoin, persist }) => {
		const t = test_convex();
		const owner = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "bash-team", workspaceName: "home" }),
		);
		const member = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
		);
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
		const asMember = t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId });
		const inviteArgs = {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userIdToAdd: member.userId,
		};
		expect(
			(await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, inviteArgs))._nay,
		).toBeUndefined();
		const membership = await t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", owner.workspaceId).eq("userId", member.userId).eq("active", true),
				)
				.unique(),
		);
		if (!membership) throw new Error("Expected invited membership");
		const ownerRunner = await create_bash_runner({ shared: { t, seeded: owner } });
		expect((await ownerRunner.run("printf before > /tmp/member.txt")).metadata.exitCode).toBe(0);
		const runner = await create_bash_runner({
			shared: { t, seeded: { ...owner, userId: member.userId, membershipId: membership._id } },
			threadId: ownerRunner.threadId,
		});
		const mutate = runner.runMutation.getMockImplementation()!;
		let removal: Promise<void> | undefined;
		const writes: Promise<unknown>[] = [];
		runner.runMutation.mockImplementation(async (ref, args) => {
			const name = function_name_of(ref);
			const isFinalWrite =
				persist === "result"
					? name === "ai_chat_files:finish_bash_invocation"
					: name === "ai_chat_files:patch_thread_tmp_files" || name === "ai_chat:save_shell";
			if (!isFinalWrite) return await mutate(ref, args);
			removal ??= (async () => {
				expect(
					(
						await asMember.mutation(api.organizations.remove_user_from_organization, {
							organizationId: owner.organizationId,
							userIdToRemove: member.userId,
						})
					)._nay,
				).toBeUndefined();
				if (rejoin)
					expect(
						(await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, inviteArgs))._nay,
					).toBeUndefined();
			})();
			await removal;
			const write = mutate(ref, args);
			writes.push(write);
			return await write;
		});

		const command = persist === "result" ? "printf ready" : "printf late > /tmp/member.txt; cd /tmp";
		const outcome = await runner.run(command, "removed-member").catch((error: unknown) => error);
		const settled = await Promise.allSettled(writes);
		expect(outcome).toBeInstanceOf(Error);
		expect(settled).toHaveLength(persist === "result" ? 1 : 2);
		if (persist === "scratch") expect(settled.every((write) => write.status === "rejected")).toBe(true);
		const invocation = await t.run((ctx) =>
			ctx.db
				.query("ai_chat_bash_invocations")
				.withIndex("by_thread_toolCall", (q) => q.eq("threadId", runner.threadId).eq("toolCallId", "removed-member"))
				.unique(),
		);
		expect(invocation?.status).toBe("interrupted");
		expect(invocation?.result).toBeUndefined();
		const stored = await t.query(internal.ai_chat_files.load_thread_tmp_files, { threadId: ownerRunner.threadId });
		const file = stored.file_nodes.find((node) => node.path === "/member.txt");
		expect(new TextDecoder().decode(stored.file_nodes_content_dict[file!._id].bytes)).toBe("before");
		expect((await get_shell(t, ownerRunner.threadId))?.cwd).toBe(test_db_files_mount);
		expect((await ownerRunner.run("cat /tmp/member.txt")).stdout).toBe("before");
		if (rejoin) {
			runner.runMutation.mockImplementation(mutate);
			expect((await runner.run("printf after > /tmp/member.txt; cd /tmp")).metadata.exitCode).toBe(0);
			expect((await runner.run("cat /tmp/member.txt")).stdout).toBe("after");
		}
	});

	test("guides unknown commands toward supported bash commands", async () => {
		const { run } = await create_bash_runner();

		const result = await run("notrealcmd");
		const swallowed = await run("notrealcmd 2>&1 || true");
		const compound = await run("notrealcmd; true");

		expect(result.metadata.exitCode).toBe(127);
		expect(result.stderr).toContain("command not found");
		expect(result.stderr).toContain("run 'help' to list available commands");
		expect(result.stderr).toContain("use search/grep for content and find/ls for paths");
		expect(swallowed.metadata.exitCode).toBe(0);
		expect(swallowed.stdout).toContain("command not found");
		expect(swallowed.stderr).toContain("run 'help' to list available commands");
		expect(compound.metadata.exitCode).toBe(0);
		expect(compound.stderr).toContain("command not found");
		expect(compound.stderr).toContain("run 'help' to list available commands");
	});

	test("runs strict-mode boilerplate", async () => {
		const { run } = await create_bash_runner();

		const result = await run("set -euo pipefail\nprintf hi > /tmp/a.txt\ncat /tmp/a.txt");

		expect(result.stderr).toBe("");
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("hi");

		// The three options are honored, not just accepted: errexit stops the script, nounset
		// refuses the unset read, and pipefail reports the failing side of the pipe.
		const errexit = await run("set -e\nfalse\necho reached");
		expect(errexit.metadata.exitCode).toBe(1);
		expect(errexit.stdout).not.toContain("reached");

		const nounset = await run('set +e\nset -u\necho "$NEVER_SET_VAR"');
		expect(nounset.metadata.exitCode).toBe(1);
		expect(nounset.stderr).toContain("unbound variable");

		const pipefail = await run("set +u\nset -o pipefail\nfalse | cat\necho code=$?");
		expect(pipefail.stdout).toContain("code=1");
	});

	test("a timeout keeps the earlier output and drops the output of the command it stopped", async () => {
		const { run } = await create_bash_runner();

		// The engine stops a timed-out command by aborting it, and after that abort it refuses to
		// collect any more output. So the statements that already ran must keep theirs, while the
		// command that was stopped reports only exit 124.
		const result = await run("printf 'kept\\n'; timeout 1 sleep 5; printf 'code=%s\\n' \"$?\"");

		expect(result.stderr).toBe("");
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe("kept\ncode=124\n");
	});

	test("seq past the loop-iteration limit says so instead of returning a short sequence", async () => {
		const { run } = await create_bash_runner();

		// seq counts against the shell's loop-iteration limit. An older engine stopped at its own
		// hard-coded cap and returned the shorter sequence with exit 0, which let a model read a
		// truncated list as the whole answer.
		const result = await run("seq 1 20000 | tail -n 1");

		expect(result.metadata.exitCode).not.toBe(0);
		expect(result.stderr).toContain("seq: iteration limit exceeded (10000)");
	});

	test("restores app-command guidance that the shell swallowed", async () => {
		const { run } = await create_bash_runner();

		// `2>/dev/null` drops the `Try:` line and the pipe turns exit 2 into head's exit 0, so
		// without the restore the model sees an empty successful result and reports "not found".
		const blinded = await run(`find ${test_db_files_mount} -type f -iname 'readme*' 2>/dev/null | head -n 5`);

		expect(blinded.metadata.exitCode).toBe(0);
		expect(blinded.stdout).toBe("");
		expect(blinded.stderr).toContain("find exited 2 and its stderr was discarded");
		expect(blinded.stderr).toContain("-name/-iname use indexed app-file path word search");
		expect(blinded.stderr).toContain("or use words like `readme`");
	});

	test("does not repeat app-command guidance for a path that holds half a character", async () => {
		const { run } = await create_bash_runner();

		// The guidance is recorded as the command printed it, so the search for it has to run against
		// the same raw text. Repairing the output before this point made the search miss: the guidance
		// was printed a second time, and raw, so the call still sent Convex half a character.
		const broken = await run(`cat "$(printf 'a\\ud83c')/f.md"`);

		expect(broken.metadata.exitCode).toBe(1);
		expect(broken.stderr).toContain("No such file or directory");
		expect(broken.stderr).not.toContain("its stderr was discarded");
		expect(broken.stderr.isWellFormed()).toBe(true);
	});

	test("does not repeat app-command guidance that is already visible", async () => {
		const { run } = await create_bash_runner();

		const plain = await run(`find ${test_db_files_mount} -type f -iname 'readme*'`);
		const merged = await run(`find ${test_db_files_mount} -type f -iname 'readme*' 2>&1 || true`);

		expect(plain.metadata.exitCode).toBe(2);
		expect(plain.stderr).toContain("-name/-iname use indexed app-file path word search");
		expect(plain.stderr).not.toContain("its stderr was discarded");
		// `2>&1` keeps the guidance, just on stdout, so it must not be printed a second time.
		expect(merged.stdout).toContain("-name/-iname use indexed app-file path word search");
		expect(merged.stderr).not.toContain("its stderr was discarded");
	});

	test("does not treat file content as an unknown command", async () => {
		const literalPath = "/docs/command-not-found.md";
		const { run } = await create_bash_runner({
			extraFiles: [{ path: literalPath, content: "example: command not found\n" }],
		});

		const catResult = await run(`cat ${test_db_files_mount}${literalPath}`);
		const grepResult = await run(`grep "command not found" ${test_db_files_mount}${literalPath}`);

		expect(catResult.stdout).toContain("example: command not found");
		expect(catResult.stderr).not.toContain("run 'help' to list available commands");
		expect(grepResult.stdout).toContain("example: command not found");
		expect(grepResult.stderr).not.toContain("run 'help' to list available commands");
	});

	test("reads markdown files through the chunk-backed file content query", async () => {
		const { run, runQuery, runAction, seeded } = await create_bash_runner();

		const result = await run(`cat ${test_db_files_mount}/docs/readme.md`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("# Readme");
		expect(
			runQuery.mock.calls.some(
				([ref, queryArgs]) =>
					function_name_of(ref) === "files_nodes:read_file_content_from_chunks" &&
					queryArgs?.path === "/docs/readme.md" &&
					queryArgs?.userId === seeded.userId,
			),
		).toBe(true);
		expect(
			runAction.mock.calls.some(
				([ref]) => function_name_of(ref) === "files_nodes_content:get_file_last_available_text_content_by_path",
			),
		).toBe(false);
	});

	test("supports cat end-of-options marker for dash-leading operands", async () => {
		const { run } = await create_bash_runner({
			initialCwd: test_db_files_mount,
			extraFiles: [
				{ path: "/-dash.md", content: "dash file\n" },
				{ path: "/--help", content: "help file\n" },
			],
		});

		const dashFile = await run("cat -- -dash.md");
		const stdin = await run("printf stdin-ok | cat -- -");
		const helpFile = await run("cat -- --help");

		expect(dashFile.metadata.exitCode).toBe(0);
		expect(dashFile.stdout).toBe("dash file\n");
		expect(stdin.metadata.exitCode).toBe(0);
		expect(stdin.stdout).toBe("stdin-ok");
		expect(helpFile.metadata.exitCode).toBe(0);
		expect(helpFile.stdout).toBe("help file\n");
	});

	test("delegates cat help to the built-in command", async () => {
		const { run } = await create_bash_runner();

		const result = await run("cat --help");

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("Usage: cat [OPTION]... [FILE]...");
		expect(result.stderr).toBe("");
	});

	test("treats missing stdin as empty input for cat", async () => {
		const { run } = await create_bash_runner();

		const plain = await run("cat");
		const numbered = await run("cat -n");
		const explicitStdin = await run("cat -- -");

		expect(plain.metadata.exitCode).toBe(0);
		expect(plain.stdout).toBe("");
		expect(numbered.metadata.exitCode).toBe(0);
		expect(numbered.stdout).toBe("");
		expect(explicitStdin.metadata.exitCode).toBe(0);
		expect(explicitStdin.stdout).toBe("");
	});

	test("does not fall back to full-content action when cat chunks are unavailable", async () => {
		const { run, runAction } = await create_bash_runner({
			extraFiles: [{ path: "/docs/unmaterialized.md", content: "hidden fallback\n", materialized: false }],
		});

		const result = await run(`cat ${test_db_files_mount}/docs/unmaterialized.md`);

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("content is not available from materialized chunks");
		expect(result.stderr).toContain(`${test_db_files_mount}/docs/unmaterialized.md`);
		expect(
			runAction.mock.calls.some(
				([ref]) => function_name_of(ref) === "files_nodes_content:get_file_last_available_text_content_by_path",
			),
		).toBe(false);
	});

	test("caches markdown file content within one bash invocation", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run(`cat ${test_db_files_mount}/docs/readme.md && cat ${test_db_files_mount}/docs/readme.md`);
		const readCalls = runQuery.mock.calls.filter(
			([ref, queryArgs]) =>
				function_name_of(ref) === "files_nodes:read_file_content_from_chunks" && queryArgs?.path === "/docs/readme.md",
		);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout.split("# Readme").length - 1).toBe(2);
		expect(readCalls).toHaveLength(1);
	});

	test("cat does not serve stale cached content after a same-call mv", async () => {
		const runner = await create_bash_runner();

		// The mv vacates the old path mid-call, so the second cat must fail instead of
		// replaying the first cat's cached content.
		const chained = await runner.run(
			`cat ${test_db_files_mount}/docs/readme.md && mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/moved.md && cat ${test_db_files_mount}/docs/readme.md`,
		);
		expect(chained.metadata.exitCode).not.toBe(0);
		expect(chained.stderr).toContain("No such file or directory");
		// Only the first cat prints the content.
		expect(chained.stdout.split("# Readme").length - 1).toBe(1);

		// cat at the NEW path in the same call serves the moved content.
		const movedChain = await runner.run(
			`cat ${test_db_files_mount}/docs/tutorial.md && mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/guide.md && cat ${test_db_files_mount}/docs/guide.md`,
		);
		expect(movedChain.stderr).toBe("");
		expect(movedChain.metadata.exitCode).toBe(0);
		expect(movedChain.stdout.split("zeta").length - 1).toBe(2);
	});

	test("readers serve a non-collaborative file from its committed chunks", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/plain.md", content: "alpha\nbeta\ngamma\n", nonCollaborative: true }],
		});

		// Prove the seed really is non-collaborative, so the reads below cannot pass through a
		// Yjs document that should not exist.
		const seededNode = await get_seeded_node(runner, "/plain.md");
		expect(seededNode.collaborationEnabled).toBe(false);
		expect(seededNode.yjsSnapshotId).toBeNull();
		expect(seededNode.yjsLastSequenceId).toBeNull();

		const printed = await runner.run(`cat ${test_db_files_mount}/plain.md`);
		expect(printed.stderr).toBe("");
		expect(printed.metadata.exitCode).toBe(0);
		expect(printed.stdout).toBe("alpha\nbeta\ngamma\n");

		const firstLines = await runner.run(`head -n 2 ${test_db_files_mount}/plain.md`);
		expect(firstLines.stderr).toBe("");
		expect(firstLines.stdout).toBe("alpha\nbeta\n");

		const counted = await runner.run(`wc -l ${test_db_files_mount}/plain.md`);
		expect(counted.stderr).toBe("");
		expect(counted.stdout.trim().startsWith("3")).toBe(true);
	});

	test("reads current app file byte size after an unsaved edit is created", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/fresh-size.md", content: "tiny base\n", withRealYjsSnapshot: true }],
		});
		const dbFilesDoc = await get_seeded_node(runner, "/fresh-size.md");
		const dbFilesDocId = dbFilesDoc._id;

		const committedStat = await runner.run(`stat -c %s ${test_db_files_mount}/fresh-size.md`);
		expect(committedStat.stderr).toBe("");
		expect(committedStat.metadata.exitCode).toBe(0);
		const committedSize = Number(committedStat.stdout.trim());
		expect(committedSize).toBeLessThan(bash_READ_INLINE_MAX_BYTES);

		await upsert_pending_update_for_test(runner, {
			target: { kind: "saved", id: dbFilesDocId },
			unstagedText: "pending text ".repeat(6000),
		});
		const pendingUpdate = await runner.t.query(internal.files_pending_updates.get_by_file_node, {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId: runner.seeded.userId,
			fileNodeId: dbFilesDocId,
		});
		if (pendingUpdate?.size == null) {
			throw new Error("expected pending update size to be set for /fresh-size.md");
		}
		runner.runQuery.mockClear();

		const currentStat = await runner.run(`stat -c %s ${test_db_files_mount}/fresh-size.md`);
		expect(currentStat.stderr).toBe("");
		expect(currentStat.metadata.exitCode).toBe(0);
		const currentSize = Number(currentStat.stdout.trim());

		expect(currentSize).toBe(pendingUpdate.size);
		expect(currentSize).toBeGreaterThan(bash_READ_INLINE_MAX_BYTES);
		expect(runner.runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "r2:get_asset_by_id")).toBe(false);
	});

	test("uses pending update size metadata without reconstructing content", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/legacy-pending.md", content: "base\n", withRealYjsSnapshot: true }],
		});
		const dbFilesDoc = await get_seeded_node(runner, "/legacy-pending.md");
		const dbFilesDocId = dbFilesDoc._id;
		await upsert_pending_update_for_test(runner, {
			target: { kind: "saved", id: dbFilesDocId },
			unstagedText: "pending body\n",
		});
		const pendingUpdate = await runner.t.query(internal.files_pending_updates.get_by_file_node, {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId: runner.seeded.userId,
			fileNodeId: dbFilesDocId,
		});
		if (pendingUpdate?.size == null) {
			throw new Error("expected pending update size to be set for /legacy-pending.md");
		}
		runner.runQuery.mockClear();
		runner.runAction.mockClear();

		const currentStat = await runner.run(`stat -c %s ${test_db_files_mount}/legacy-pending.md`);
		expect(currentStat.stderr).toBe("");
		expect(currentStat.metadata.exitCode).toBe(0);
		const size = Number(currentStat.stdout.trim());

		expect(size).toBe(pendingUpdate.size);
		expect(runner.runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "r2:get_asset_by_id")).toBe(false);
		expect(
			runner.runAction.mock.calls.some(
				([ref]) => function_name_of(ref) === "files_nodes_content:get_file_last_available_text_content_by_path",
			),
		).toBe(false);
	});

	test("pipes cat text output without corrupting Unicode", async () => {
		const unicodePath = "/docs/unicode.md";
		const content = "cafe\u0301 — snowman ☃\n";
		const { run } = await create_bash_runner({
			extraFiles: [{ path: unicodePath, content }],
		});

		const result = await run(`cat ${test_db_files_mount}${unicodePath} | cat`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe(content);
	});

	test("supports ls, find, and stat over db-files paths", async () => {
		const { run } = await create_bash_runner();

		const result = await run(
			`ls ${test_db_files_mount}/docs && find ${test_db_files_mount}/docs -maxdepth 1 -type f && stat ${test_db_files_mount}/docs/readme.md`,
		);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("readme.md");
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
	});

	test("keeps valid ls operands when another operand is missing", async () => {
		const { run } = await create_bash_runner();

		const result = await run(`ls ${test_db_files_mount}/docs ${test_db_files_mount}/missing`);

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs:`);
		expect(result.stdout).toContain("readme.md");
		expect(result.stderr).toContain(`ls: cannot access '${test_db_files_mount}/missing': No such file or directory`);
	});

	test("supports paginated ls with a continuation command", async () => {
		const runner = await create_bash_runner();
		const { run, runQuery } = runner;

		const result = await run(`ls --limit 1 ${test_db_files_mount}/docs`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("nested/");
		expect(result.stdout).toContain("Next page:");
		expect(result.stdout).toMatch(new RegExp(`ls --limit 1 --cursor \\S+ ${test_db_files_mount}/docs`, "u"));
		expect(result.stderr).not.toContain("directory listing truncated");
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					folderPath: "/docs",
					numItems: 1,
					cursor: null,
				}),
			]),
		);
	});

	test("resolves paginated ls path arguments from the current working directory", async () => {
		const runner = await create_bash_runner();
		const { run, runQuery } = runner;

		await run(`cd ${test_db_files_mount}/docs`);
		const bareResult = await run("ls --limit 10");
		const dotResult = await run("ls --limit 10 .");
		const relativeResult = await run("ls --limit 10 nested");

		expect(bareResult.metadata.exitCode).toBe(0);
		expect(bareResult.stdout).toContain("readme.md");
		expect(dotResult.metadata.exitCode).toBe(0);
		expect(dotResult.stdout).toContain("tutorial.md");
		expect(relativeResult.metadata.exitCode).toBe(0);
		expect(relativeResult.stdout).toContain("deep.md");
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					folderPath: "/docs",
					numItems: 10,
					cursor: null,
				}),
				expect.objectContaining({
					folderPath: "/docs/nested",
					numItems: 10,
					cursor: null,
				}),
			]),
		);
	});

	test("delegates bare ls to the current scratch directory outside the current workspace path", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run("cd /tmp && printf hi > scratch.txt && ls");

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("scratch.txt");
		expect(result.stdout).not.toContain("readme.md");
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toHaveLength(0);
	});

	test("keeps /tmp relative ls output outside the current workspace path", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run("cd /tmp && printf hi > relative-tmp.txt && ls relative-tmp.txt");

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("relative-tmp.txt");
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toHaveLength(0);
	});

	test("reports unknown ls cursor ids with recovery guidance", async () => {
		const { run } = await create_bash_runner();

		const result = await run(`ls --limit 1 --cursor cursor-1 ${test_db_files_mount}/docs`);

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("cursor cursor-1 expired, is unavailable, or was copied incorrectly");
		expect(result.stderr).toContain("Copy the exact --cursor value from the latest Next page command and retry");
	});

	test("resolves stored cursor ids through value_store with an explicit 24-hour TTL", async () => {
		const { run, runQuery, runMutation } = await create_bash_runner();

		const firstPage = await run(`ls --limit 1 ${test_db_files_mount}/docs`);
		const cursorId = firstPage.stdout.match(/--cursor '?([^' ]+)'?/u)?.[1];
		if (cursorId == null) {
			throw new Error("expected a cursor id in the first page stdout");
		}
		const rawCursor = runMutation.mock.calls
			.map(([ref, mutationArgs]) => (function_name_of(ref) === "value_store:put" ? mutationArgs.value : null))
			.find((value): value is string => typeof value === "string");
		if (rawCursor == null) {
			throw new Error("expected the first page cursor to be stored in value_store");
		}

		runQuery.mockClear();
		const secondPage = await run(`ls --limit 1 --cursor '${cursorId}' ${test_db_files_mount}/docs`);

		expect(secondPage.metadata.exitCode).toBe(0);
		expect(secondPage.stdout).toContain("readme.md");
		expect(runMutation).toHaveBeenCalledWith(internal.value_store.put, {
			value: rawCursor,
			ttl: 24 * 60 * 60 * 1000,
		});
		expect(runQuery).toHaveBeenCalledWith(internal.value_store.get, { id: cursorId });
		expect(runQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				cursor: rawCursor,
			}),
		);
	});

	test("rejects a removed cursor even after it has been used", async () => {
		const { run, runQuery, t } = await create_bash_runner();

		const firstPage = await run(`ls --limit 1 ${test_db_files_mount}/docs`);
		const cursorId = firstPage.stdout.match(/--cursor '?([^' ]+)'?/u)?.[1];
		if (cursorId == null) {
			throw new Error("expected a cursor id in the first page stdout");
		}
		const secondPage = await run(`ls --limit 1 --cursor '${cursorId}' ${test_db_files_mount}/docs`);
		expect(secondPage.metadata.exitCode).toBe(0);
		await t.mutation(internal.value_store.remove, { id: cursorId as Id<"value_store"> });
		runQuery.mockClear();
		const removedPage = await run(`ls --limit 1 --cursor '${cursorId}' ${test_db_files_mount}/docs`);

		expect(removedPage.metadata.exitCode).toBe(1);
		expect(removedPage.stderr).toContain("expired, is unavailable, or was copied incorrectly");
		expect(runQuery).toHaveBeenCalledWith(internal.value_store.get, { id: cursorId });
	});

	test("rejects a cursor at its 24-hour expiry", async () => {
		const { run } = await create_bash_runner();
		const now = Date.now();
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			const firstPage = await run(`ls --limit 1 ${test_db_files_mount}/docs`);
			const cursorId = firstPage.stdout.match(/--cursor '?([^' ]+)'?/u)?.[1];
			if (cursorId == null) {
				throw new Error("expected a cursor id in the first page stdout");
			}
			dateNow.mockReturnValue(now + 24 * 60 * 60 * 1000);
			const expiredPage = await run(`ls --limit 1 --cursor '${cursorId}' ${test_db_files_mount}/docs`);

			expect(expiredPage.metadata.exitCode).toBe(1);
			expect(expiredPage.stderr).toContain("expired, is unavailable, or was copied incorrectly");
		} finally {
			dateNow.mockRestore();
		}
	});

	test("reports missing cursor ids with recovery guidance", async () => {
		const { run } = await create_bash_runner();

		const result = await run(`ls --limit 1 --cursor missing ${test_db_files_mount}/docs`);

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stderr).toContain("cursor missing expired, is unavailable, or was copied incorrectly");
		expect(result.stderr).toContain("Copy the exact --cursor value from the latest Next page command and retry");
	});

	test("supports multiple ls path operands with per-directory continuation commands", async () => {
		const { run } = await create_bash_runner();

		const result = await run(
			`ls --limit 1 ${test_db_files_mount}/docs ${test_db_files_mount} ${test_db_files_mount}/docs/readme.md`,
		);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs:\nnested/`);
		expect(result.stdout).toContain(`${test_db_files_mount}:\ndocs/`);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(result.stdout.match(/Next page:/gu)).toHaveLength(2);
		const continuations = [...result.stdout.matchAll(/Next page: ls --limit 1 --cursor (\S+) (\S+)/gu)];
		expect(continuations.map((m) => m[2])).toEqual([`${test_db_files_mount}/docs`, test_db_files_mount]);
		expect(continuations[0][1]).not.toBe(continuations[1][1]);
	});

	test("supports mixed /tmp and app ls operands without a cursor", async () => {
		const { run } = await create_bash_runner();

		const tmpFirst = await run(
			`printf hi > /tmp/mixed-tmp-a.txt && printf hi > /tmp/mixed-tmp-b.txt && ls /tmp/mixed-tmp-a.txt /tmp/mixed-tmp-b.txt ${test_db_files_mount}/docs`,
		);
		const tmpAppTmp = await run(
			`printf hi > /tmp/mixed-tmp-a.txt && printf hi > /tmp/mixed-tmp-b.txt && ls /tmp/mixed-tmp-a.txt ${test_db_files_mount}/docs /tmp/mixed-tmp-b.txt`,
		);

		expect(tmpFirst.metadata.exitCode).toBe(0);
		expect(tmpFirst.stdout).toContain("/tmp/mixed-tmp-a.txt");
		expect(tmpFirst.stdout).toContain("/tmp/mixed-tmp-b.txt");
		expect(tmpFirst.stdout).toContain(`${test_db_files_mount}/docs:\nnested/`);
		expect(tmpFirst.stdout.indexOf("/tmp/mixed-tmp-a.txt")).toBeLessThan(
			tmpFirst.stdout.indexOf("/tmp/mixed-tmp-b.txt"),
		);
		expect(tmpFirst.stdout.indexOf("/tmp/mixed-tmp-b.txt")).toBeLessThan(
			tmpFirst.stdout.indexOf(`${test_db_files_mount}/docs:`),
		);
		expect(tmpFirst.stderr).not.toContain("cannot mix app file paths");

		expect(tmpAppTmp.metadata.exitCode).toBe(0);
		expect(tmpAppTmp.stdout).toContain("/tmp/mixed-tmp-a.txt");
		expect(tmpAppTmp.stdout).toContain(`${test_db_files_mount}/docs:\nnested/`);
		expect(tmpAppTmp.stdout).toContain("/tmp/mixed-tmp-b.txt");
		expect(tmpAppTmp.stdout.indexOf("/tmp/mixed-tmp-a.txt")).toBeLessThan(
			tmpAppTmp.stdout.indexOf(`${test_db_files_mount}/docs:`),
		);
		expect(tmpAppTmp.stdout.indexOf(`${test_db_files_mount}/docs:`)).toBeLessThan(
			tmpAppTmp.stdout.indexOf("/tmp/mixed-tmp-b.txt"),
		);
		expect(tmpAppTmp.stderr).not.toContain("cannot mix app file paths");
	});

	test("formats mixed /tmp and app ls directory sections consistently", async () => {
		const { run } = await create_bash_runner();

		const result = await run(
			`mkdir -p /tmp/mixed-ls-dir && printf hi > /tmp/mixed-ls-dir/tmp.txt && ls ${test_db_files_mount}/docs /tmp/mixed-ls-dir`,
		);
		const relativeResult = await run(
			`cd /tmp && mkdir -p mixed-ls-relative-dir && printf hi > mixed-ls-relative-dir/tmp.txt && ls mixed-ls-relative-dir ${test_db_files_mount}/docs`,
		);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs:\nnested/`);
		expect(result.stdout).toContain("/tmp/mixed-ls-dir:\ntmp.txt");
		expect(result.stdout.trim().split("\n\n")).toEqual([
			`${test_db_files_mount}/docs:\nnested/\nreadme.md\ntutorial.md`,
			"/tmp/mixed-ls-dir:\ntmp.txt",
		]);
		expect(relativeResult.metadata.exitCode).toBe(0);
		expect(relativeResult.stdout.trim().split("\n\n")).toEqual([
			"mixed-ls-relative-dir:\ntmp.txt",
			`${test_db_files_mount}/docs:\nnested/\nreadme.md\ntutorial.md`,
		]);
	});

	test("keeps Native Just Bash ls flags when batching adjacent /tmp operands", async () => {
		const { run } = await create_bash_runner();

		const result = await run(
			`mkdir -p /tmp/mixed-ls-a /tmp/mixed-ls-b && ls -d /tmp/mixed-ls-a /tmp/mixed-ls-b ${test_db_files_mount}/docs`,
		);

		expect(result.metadata.exitCode).toBe(0);
		// Native `ls -d` prints its operands as one block, one per line, like real bash. Only the
		// app-path operand gets its own block.
		expect(result.stdout.trim().split("\n\n")).toEqual([
			"/tmp/mixed-ls-a\n/tmp/mixed-ls-b",
			`${test_db_files_mount}/docs/`,
		]);
	});

	test("rejects ls cursor continuation with multiple operands", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run(
			`ls --limit 1 --cursor cursor-1 ${test_db_files_mount}/docs ${test_db_files_mount}/reports`,
		);
		const mixedResult = await run(`ls --limit 1 --cursor cursor-1 ${test_db_files_mount}/docs /tmp`);

		expect(result.metadata.exitCode).toBe(2);
		expect(result.stderr).toContain("--cursor can only continue one listing target");
		expect(mixedResult.metadata.exitCode).toBe(2);
		expect(mixedResult.stderr).toContain("--cursor can only continue one listing target");
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toHaveLength(0);
	});

	test("supports ls -d and lets directory mode win over recursive mode", async () => {
		const { run } = await create_bash_runner();

		const result = await run(`ls -dR ${test_db_files_mount}/docs`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe(`${test_db_files_mount}/docs/`);
		expect(result.stdout).not.toContain("readme.md");
	});

	test("supports recursive ls with full app shell paths", async () => {
		const { run } = await create_bash_runner();

		const result = await run(`ls -R --limit 10 ${test_db_files_mount}/docs`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/nested/`);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/nested/deep.md`);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
	});

	test("supports reverse ls order through the paginated query", async () => {
		const runner = await create_bash_runner();
		const { run, runQuery } = runner;

		const result = await run(`ls -r --limit 10 ${test_db_files_mount}/docs`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout.trim().split("\n")).toEqual(["tutorial.md", "readme.md", "nested/"]);
		expect(runQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				folderPath: "/docs",
				order: "desc",
			}),
		);
	});

	test("ls -t lists the workspace newest-first and supports scoped immediate-child recency", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/docs/aaa-old.md", content: "old\n", updatedAt: Date.now() - 2_000_000 },
				{ path: "/docs/zzz-new.md", content: "new\n", updatedAt: Date.now() + 10_000 },
			],
		});
		const { run, runQuery } = runner;

		const newest = await run("ls -t --limit 50");
		const oldest = await run("ls -rt --limit 50");
		const scopedNewest = await run(`ls -t --limit 10 ${test_db_files_mount}/docs`);
		const scopedOldest = await run(`ls -rt --limit 10 ${test_db_files_mount}/docs`);
		const scopedPaged = await run(`ls -t --limit 1 ${test_db_files_mount}/docs`);
		const recursiveScoped = await run(`ls -Rt ${test_db_files_mount}/docs`);
		const workspacePaged = await run("ls -t --limit 1");

		expect(newest.metadata.exitCode).toBe(0);
		// Each line is "<ISO timestamp>\t<shell path>"; assert the recency formatting + a known path.
		expect(newest.stdout).toMatch(/\dT\d.*Z\t\/home\/cloud-usr\/w\/personal\/home\/docs\/readme\.md/u);
		const recencyCalls = runQuery.mock.calls
			.map((call) => call[1])
			.filter((a) => "numItems" in a && a.mode === "recent" && a.orderBy === "updatedAt");
		expect(recencyCalls.some((a) => a.order === "desc")).toBe(true);
		expect(recencyCalls.some((a) => a.order === "asc")).toBe(true);
		expect(oldest.metadata.exitCode).toBe(0);
		expect(scopedNewest.metadata.exitCode).toBe(0);
		expect(scopedNewest.stdout.trim().split("\n").at(0)).toBe("zzz-new.md");
		expect(scopedOldest.metadata.exitCode).toBe(0);
		expect(scopedOldest.stdout.trim().split("\n").at(0)).toBe("aaa-old.md");
		expect(scopedPaged.stdout).toMatch(
			new RegExp(`Next page: ls -t --limit 1 --cursor \\S+ ${test_db_files_mount}/docs`, "u"),
		);
		expect(recursiveScoped.metadata.exitCode).toBe(2);
		expect(recursiveScoped.stderr).toContain("ls -t -R is not supported");
		expect(workspacePaged.stdout).toContain("Next page: ls -t --limit 1 --cursor");
		expect(runQuery).toHaveBeenCalledWith(
			internal.files_visible.internal_list,
			expect.objectContaining({
				folderPath: "/docs",
				orderBy: "updatedAt",
				order: "desc",
			}),
		);
	});

	test("supports app-specific long ls output", async () => {
		const { run, seeded } = await create_bash_runner();

		const result = await run(`ls -la --limit 10 ${test_db_files_mount}/docs`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toMatch(new RegExp(`folder\\t[^\\t]+Z\\tupdatedBy=${seeded.userId}\\tnested/`, "u"));
		expect(result.stdout).toMatch(
			new RegExp(
				`file\\t[^\\t]+Z\\tupdatedBy=${seeded.userId}\\tcontentType=text/markdown;charset=utf-8\\treadme\\.md`,
				"u",
			),
		);
	});

	test("accepts ls no-op presentation flags and name sort alias", async () => {
		const { run } = await create_bash_runner();

		const result = await run(`ls -1apF --sort=name --indicator-style=slash --limit 10 ${test_db_files_mount}/docs`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout.trim().split("\n")).toEqual(["nested/", "readme.md", "tutorial.md"]);
	});

	test("rejects unsupported ls sorting and size flags only when db-files paths are involved", async () => {
		const { run, runQuery } = await create_bash_runner();

		const sortResult = await run(`ls --sort=size ${test_db_files_mount}/docs`);
		const sizeResult = await run(`ls -S ${test_db_files_mount}/docs`);
		const nativeJustBashResult = await run("ls --sort=size /tmp");
		const mixedResult = await run(
			`printf hi > /tmp/unsupported-ls-tmp.txt && ls --sort=size /tmp/unsupported-ls-tmp.txt ${test_db_files_mount}/docs`,
		);

		expect(sortResult.metadata.exitCode).toBe(2);
		expect(sortResult.stderr).toContain("unsupported option --sort=size");
		expect(sortResult.stderr).toContain("/home/cloud-usr/w");
		expect(sortResult.stderr).toContain("supports name and time order only");
		expect(sizeResult.metadata.exitCode).toBe(2);
		expect(sizeResult.stderr).toContain("unsupported option -S");
		expect(nativeJustBashResult.stderr).not.toContain("/home/cloud-usr/w");
		expect(mixedResult.metadata.exitCode).toBe(2);
		expect(mixedResult.stderr).toContain("unsupported option --sort=size");
		expect(mixedResult.stderr).toContain("/home/cloud-usr/w");
		expect(mixedResult.stdout).not.toContain("unsupported-ls-tmp.txt");
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toHaveLength(0);
	});

	test("guides invented ls pagination flags back to the printed cursor command", async () => {
		const { run } = await create_bash_runner();

		const appResult = await run(`ls --limit 1 --next-page ${test_db_files_mount}/docs`);
		const nativeJustBashResult = await run("ls --next-page /tmp");

		for (const result of [appResult, nativeJustBashResult]) {
			expect(result.metadata.exitCode).toBe(2);
			expect(result.stderr).toContain("--next-page is not supported");
			expect(result.stderr).toContain("Copy the exact");
			expect(result.stderr).toContain("Next page: ls --limit N --cursor");
		}
	});

	test("supports paginated find with maxdepth and type filters", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run(`find ${test_db_files_mount}/docs -maxdepth 1 -type f --limit 10`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/tutorial.md`);
		expect(result.stdout).not.toContain(`${test_db_files_mount}/docs/nested/deep.md`);
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					folderPath: "/docs",
					numItems: 10,
					cursor: null,
					kind: "file",
					maxDepth: 1,
				}),
			]),
		);
	});

	test("handles exact file find targets locally with type depth and extension filters", async () => {
		const { run, runQuery } = await create_bash_runner();

		const plain = await run(`find ${test_db_files_mount}/docs/readme.md --limit 10`);
		const extension = await run(`find ${test_db_files_mount}/docs/readme.md --extension md --limit 10`);
		const typeFolder = await run(`find ${test_db_files_mount}/docs/readme.md -type d --limit 10`);
		const tooDeep = await run(`find ${test_db_files_mount}/docs/readme.md -mindepth 1 --limit 10`);

		expect(plain.metadata.exitCode).toBe(0);
		expect(plain.stdout.trim()).toBe(`${test_db_files_mount}/docs/readme.md`);
		expect(extension.metadata.exitCode).toBe(0);
		expect(extension.stdout.trim()).toBe(`${test_db_files_mount}/docs/readme.md`);
		expect(typeFolder.stdout.trim()).toBe("0 matches.");
		expect(tooDeep.stdout.trim()).toBe("0 matches.");
		expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:list_subtree")).toBe(false);
	});

	test("supports indexed app-file find path word search", async () => {
		// convex-test's search index splits document words on whitespace only, so the word
		// query can only land on a path segment that follows a space in the file name.
		const wordSearchPath = "/docs/word readme.md";
		const outsideWordSearchPath = "/word readme-outside.md";
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: wordSearchPath, content: "word search fixture\n" },
				{ path: outsideWordSearchPath, content: "outside word search fixture\n" },
				{ path: "/docs/scope word/child.md", content: "child under scope word\n" },
			],
		});
		const { run, runQuery } = runner;

		const nameResult = await run("find -name readme --limit 10");
		const explicitResult = await run("find --path-query readme --limit 10");
		const scopedResult = await run(`find ${test_db_files_mount}/docs -maxdepth 1 -name readme -type f --limit 10`);
		const subtreeResult = await run(`find ${test_db_files_mount}/docs -name readme --limit 10`);
		const dottedNameResult = await run(`find ${test_db_files_mount}/docs -type f -name 'word readme.md' --limit 10`);
		const scopedSelfResult = await run(`find '${test_db_files_mount}/docs/scope word' --path-query word --limit 10`);
		const scopedMindepthResult = await run(
			`find '${test_db_files_mount}/docs/scope word' -mindepth 1 --path-query word --limit 10`,
		);

		expect(nameResult.metadata.exitCode).toBe(0);
		expect(nameResult.stdout).toContain(`${test_db_files_mount}${wordSearchPath}`);
		expect(nameResult.stdout).toContain(`${test_db_files_mount}${outsideWordSearchPath}`);
		expect(explicitResult.metadata.exitCode).toBe(0);
		expect(explicitResult.stdout).toContain(`${test_db_files_mount}${wordSearchPath}`);
		expect(scopedResult.metadata.exitCode).toBe(0);
		expect(scopedResult.stdout).toContain(`${test_db_files_mount}${wordSearchPath}`);
		// Without -maxdepth, a folder scope searches the full subtree and filters out the rest.
		expect(subtreeResult.metadata.exitCode).toBe(0);
		expect(subtreeResult.stdout).toContain(`${test_db_files_mount}${wordSearchPath}`);
		expect(subtreeResult.stdout).not.toContain(`${test_db_files_mount}${outsideWordSearchPath}`);
		expect(dottedNameResult.metadata.exitCode).toBe(0);
		expect(dottedNameResult.stdout).toContain(`${test_db_files_mount}${wordSearchPath}`);
		expect(dottedNameResult.stdout).not.toContain(`${test_db_files_mount}/docs/nested/deep.md`);
		expect(scopedSelfResult.metadata.exitCode).toBe(0);
		expect(scopedSelfResult.stdout.trim().split("\n")).toContain(`${test_db_files_mount}/docs/scope word/`);
		expect(scopedMindepthResult.metadata.exitCode).toBe(0);
		expect(scopedMindepthResult.stdout.trim().split("\n")).not.toContain(`${test_db_files_mount}/docs/scope word/`);
		expect(scopedMindepthResult.stdout.trim().split("\n")).toContain(`${test_db_files_mount}/docs/scope word/child.md`);
		expect(runQuery).toHaveBeenCalledWith(
			internal.files_visible.internal_list,
			expect.objectContaining({
				pathQuery: "readme",
			}),
		);
		expect(runQuery).toHaveBeenCalledWith(
			internal.files_visible.internal_list,
			expect.objectContaining({
				folderPath: "/docs",
				mode: "children",
				kind: "file",
			}),
		);
		expect(runQuery).toHaveBeenCalledWith(
			internal.files_visible.internal_list,
			expect.objectContaining({
				pathQuery: "readme",
				folderPath: "/docs",
				mode: "subtree",
			}),
		);
	});

	test("supports find -mindepth and accepts -print as a no-op", async () => {
		const { run } = await create_bash_runner();

		const deepOnly = await run(`find ${test_db_files_mount}/docs -mindepth 2 --limit 50`);
		const directOnly = await run(`find ${test_db_files_mount}/docs -mindepth 1 -maxdepth 1 --limit 50`);
		const printed = await run(`find ${test_db_files_mount}/docs -maxdepth 1 -print --limit 50`);

		expect(deepOnly.metadata.exitCode).toBe(0);
		expect(deepOnly.stdout).toContain(`${test_db_files_mount}/docs/nested/deep.md`);
		expect(deepOnly.stdout).not.toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(directOnly.metadata.exitCode).toBe(0);
		expect(directOnly.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(directOnly.stdout).toContain(`${test_db_files_mount}/docs/nested/`);
		expect(directOnly.stdout).not.toContain(`${test_db_files_mount}/docs/nested/deep.md`);
		expect(printed.metadata.exitCode).toBe(0);
		expect(printed.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
	});

	test("rejects a non-integer find -mindepth and round-trips it in the continuation", async () => {
		const { run } = await create_bash_runner();

		const invalid = await run(`find ${test_db_files_mount}/docs -mindepth x --limit 10`);
		const paged = await run(`find ${test_db_files_mount}/docs -mindepth 1 --limit 1`);

		expect(invalid.metadata.exitCode).toBe(2);
		expect(invalid.stderr).toContain("-mindepth must be a non-negative integer");
		expect(paged.metadata.exitCode).toBe(0);
		expect(paged.stdout).toContain("Next page: find");
		expect(paged.stdout).toContain("-mindepth 1");
	});

	test("rejects find --prefix combined with depth flags", async () => {
		const { run, runQuery } = await create_bash_runner();

		const maxResult = await run(`find --prefix ${test_db_files_mount}/docs -maxdepth 1 --limit 10`);
		const minResult = await run(`find --prefix ${test_db_files_mount}/docs -mindepth 2 --limit 10`);

		expect(maxResult.metadata.exitCode).toBe(2);
		expect(maxResult.stderr).toContain("--prefix cannot be combined with -maxdepth/-mindepth");
		expect(minResult.metadata.exitCode).toBe(2);
		expect(minResult.stderr).toContain("--prefix cannot be combined with -maxdepth/-mindepth");
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toHaveLength(0);
	});

	test("supports indexed app-file find extension search and simple extension glob recovery", async () => {
		const { run, runQuery } = await create_bash_runner();

		const globName = await run("find -name '*.md' --limit 10");
		const extension = await run(`find ${test_db_files_mount}/docs --extension md --limit 10`);
		const pathGlob = await run(`find ${test_db_files_mount}/docs/*.md --limit 1`);

		expect(globName.metadata.exitCode).toBe(0);
		expect(globName.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(extension.metadata.exitCode).toBe(0);
		expect(extension.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(pathGlob.metadata.exitCode).toBe(0);
		expect(pathGlob.stdout).toContain(`${test_db_files_mount}/docs/nested/deep.md`);
		expect(pathGlob.stdout).toMatch(
			new RegExp(`Next page: find ${test_db_files_mount}/docs --extension md --limit 1 --cursor \\S+`, "u"),
		);
		expect(runQuery).toHaveBeenCalledWith(
			internal.files_nodes.list_subtree,
			expect.objectContaining({
				folderPath: "/docs",
				kind: "file",
				lowercaseExtension: "md",
			}),
		);
	});

	test("rejects find combinations that still cannot stay indexed", async () => {
		const { run } = await create_bash_runner();

		const scopedDepth = await run(`find ${test_db_files_mount}/docs -maxdepth 2 -name readme --limit 10`);
		const tokenGlobName = await run("find -type f -name '*readme*' --limit 10");
		const prefixExtensionGlobName = await run(`find ${test_db_files_mount}/docs -type f -name 'readme*.md' --limit 10`);
		const complexGlobName = await run("find -name 'read.*.md' --limit 10");
		const pathQueryGlob = await run("find --path-query '.*readme.*' --limit 10");
		const combinedPathQueryExtension = await run(
			`find ${test_db_files_mount}/docs -type f --extension md --path-query readme --limit 10`,
		);
		const recursivePathQuery = await run(
			`find ${test_db_files_mount} -maxdepth 5 -type f --path-query readme --limit 10`,
		);
		const regexPathPredicate = await run(`find ${test_db_files_mount}/docs -type f -regex '.*readme.*' --limit 10`);

		expect(scopedDepth.metadata.exitCode).toBe(2);
		expect(scopedDepth.stderr).toContain("full subtree (omit -maxdepth) or immediate children with -maxdepth 1");
		expect(scopedDepth.stderr).toContain(`Try: find ${test_db_files_mount}/docs --path-query readme --limit 10`);
		expect(tokenGlobName.metadata.exitCode).toBe(2);
		expect(tokenGlobName.stderr).toContain(`Try: find ${test_db_files_mount} -type f --path-query readme --limit 10`);
		expect(prefixExtensionGlobName.metadata.exitCode).toBe(2);
		expect(prefixExtensionGlobName.stderr).toContain(
			`Try: find ${test_db_files_mount}/docs -type f --path-query readme --limit 10`,
		);
		expect(complexGlobName.metadata.exitCode).toBe(2);
		expect(complexGlobName.stderr).toContain("not glob patterns");
		expect(complexGlobName.stderr).toContain("Try `find <dir> -type f --extension md");
		expect(pathQueryGlob.metadata.exitCode).toBe(2);
		expect(pathQueryGlob.stderr).toContain("--path-query uses indexed app-file path word search");
		expect(pathQueryGlob.stderr).toContain(`Try: find ${test_db_files_mount} --path-query readme --limit 10`);
		expect(combinedPathQueryExtension.metadata.exitCode).toBe(2);
		expect(combinedPathQueryExtension.stderr).toContain(
			`Try: find ${test_db_files_mount}/docs -type f --path-query readme --limit 10`,
		);
		expect(combinedPathQueryExtension.stderr).toContain(
			`For extension-only search, use: find ${test_db_files_mount}/docs -type f --extension md --limit 10`,
		);
		expect(recursivePathQuery.metadata.exitCode).toBe(2);
		expect(recursivePathQuery.stderr).toContain(
			`Try: find ${test_db_files_mount} -type f --path-query readme --limit 10`,
		);
		expect(regexPathPredicate.metadata.exitCode).toBe(2);
		expect(regexPathPredicate.stderr).toContain(
			`Try: find ${test_db_files_mount}/docs -type f --path-query readme --limit 10`,
		);
	});

	test("filters non-search find pages before pagination", async () => {
		const { run } = await create_bash_runner();

		const result = await run(`find ${test_db_files_mount}/docs -maxdepth 1 -type f --limit 1`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(result.stdout).not.toContain("No matches in this page; more pages exist.");
		expect(result.stdout).toContain("Next page:");
	});

	test("rejects unsupported find predicates when pagination is requested", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run(`find ${test_db_files_mount}/docs -delete --limit 10`);
		const regexResult = await run(
			`find ${test_db_files_mount}/docs -regextype posix-extended -regex '.*readme.*' --limit 10`,
		);
		const nativeJustBashResult = await run("find /tmp -mtime 1 --limit 1");

		expect(result.metadata.exitCode).toBe(2);
		expect(result.stderr).toContain("unsupported predicate -delete");
		expect(result.stderr).toContain("/home/cloud-usr/w");
		expect(result.stderr).toContain("use -name QUERY");
		expect(result.stderr).toContain("Usage: find");
		expect(regexResult.metadata.exitCode).toBe(2);
		expect(regexResult.stderr).toContain("unsupported predicate -regextype");
		expect(regexResult.stderr).toContain("--path-query with plain path words");
		expect(regexResult.stderr).toContain(`Try: find ${test_db_files_mount}/docs --path-query readme --limit 10`);
		expect(regexResult.stderr).not.toContain("supports one path only");
		expect(nativeJustBashResult.stderr).not.toContain("/home/cloud-usr/w");
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toHaveLength(0);
	});

	test("ignores app pagination options outside the app file mount without Convex queries", async () => {
		const { run, runQuery } = await create_bash_runner();

		const lsResult = await run("ls --limit 1 /tmp");
		const lsCursorResult = await run("ls /tmp --cursor missing");
		const findResult = await run("find /tmp --limit 1");
		const findCursorResult = await run("find /tmp --cursor missing");
		const plainTreeResult = await run("tree /tmp");
		const treeResult = await run("tree /tmp --limit 1");
		const treeCursorResult = await run("tree /tmp --cursor missing");
		const malformedLimitResult = await run("ls --limit nope /tmp");

		expect(lsResult.metadata.exitCode).toBe(0);
		expect(lsCursorResult.metadata.exitCode).toBe(0);
		expect(findResult.metadata.exitCode).toBe(0);
		expect(findCursorResult.metadata.exitCode).toBe(0);
		expect(treeResult.metadata.exitCode).toBe(plainTreeResult.metadata.exitCode);
		expect(treeResult.stdout).toBe(plainTreeResult.stdout);
		expect(treeResult.stderr).toBe(plainTreeResult.stderr);
		expect(treeCursorResult.metadata.exitCode).toBe(plainTreeResult.metadata.exitCode);
		expect(treeCursorResult.stdout).toBe(plainTreeResult.stdout);
		expect(treeCursorResult.stderr).toBe(plainTreeResult.stderr);
		expect(malformedLimitResult.metadata.exitCode).toBe(2);
		expect(malformedLimitResult.stderr).toContain("ls: --limit must be an integer");
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toHaveLength(0);
	});

	test("resolves exact parent folders through db-files path lookups", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run(`cd ${test_db_files_mount}/reports && pwd`);
		const reportsLookupCalls = runQuery.mock.calls.filter((call) => {
			const queryArgs = call[1];
			return (
				queryArgs &&
				typeof queryArgs === "object" &&
				!("maxDepth" in queryArgs) &&
				"path" in queryArgs &&
				queryArgs.path === "/reports"
			);
		});

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe(`${test_db_files_mount}/reports`);
		expect(reportsLookupCalls.length).toBeGreaterThan(0);
	});

	test("rejects app glob patterns without falling back to capped enumeration", async () => {
		const { run } = await create_bash_runner();

		const result = await run(`ls ${test_db_files_mount}/docs/*.md`);

		expect(result.metadata.exitCode).toBe(2);
		expect(result.metadata.pathIndexTruncated).toBe(false);
		expect(result.stderr).toContain("app file glob patterns are not supported");
		expect(result.stderr).toContain(`Try: find ${test_db_files_mount}/docs -type f --extension md --limit 20`);
	});

	test("expands scratch globs but rejects app globs after cwd resolution", async () => {
		const { run } = await create_bash_runner();

		const writeTmp = await run("printf 'alpha\\n' > /tmp/a.txt && printf 'beta\\n' > /tmp/b.txt");
		const cdTmp = await run("cd /tmp");
		const tmpGlob = await run("cat *.txt");
		const cdApp = await run(`cd ${test_db_files_mount}/docs`);
		const appGlob = await run("ls *.md");

		expect(writeTmp.metadata.exitCode).toBe(0);
		expect(cdTmp.metadata.exitCode).toBe(0);
		expect(tmpGlob.metadata.exitCode).toBe(0);
		expect(tmpGlob.stdout).toContain("alpha\n");
		expect(tmpGlob.stdout).toContain("beta\n");
		expect(tmpGlob.stderr).not.toContain("app file glob patterns are not supported");
		expect(cdApp.metadata.exitCode).toBe(0);
		expect(appGlob.metadata.exitCode).toBe(2);
		expect(appGlob.stderr).toContain("app file glob patterns are not supported");
		expect(appGlob.stderr).toContain("Try: find . -type f --extension md --limit 20");
	});

	test("does not alias root listing to app files", async () => {
		const { run } = await create_bash_runner();

		const result = await run("ls /");

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).not.toContain("docs");
		expect(result.stdout).not.toContain("source.pdf");
		expect(result.stdout).toContain("home");
		expect(result.stdout).toContain("tmp");
	});

	test("does not expose the removed legacy mount", async () => {
		const { run } = await create_bash_runner();
		const legacyMount = "/work" + "space";

		const result = await run(`ls ${legacyMount}`);

		expect(result.metadata.exitCode).not.toBe(0);
		expect(result.stdout).not.toContain("readme.md");
	});

	test("explains unreadable uploaded source files through bash cat", async () => {
		const { run } = await create_bash_runner();

		const result = await run(`cat ${test_db_files_mount}/source.pdf`);

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("content type is 'application/pdf'");
		expect(result.stderr).toContain("Bash can read editable text files only");
		expect(result.stderr).toContain(`${test_db_files_mount}/source.pdf.md`);
		expect(result.stderr).toContain(`${test_db_files_mount}/source.md`);
		expect(result.stderr).toContain(`${test_db_files_mount}/source.txt`);
	});

	test("keeps unreadable cat advisories out of pipelines", async () => {
		const { run } = await create_bash_runner();

		const result = await run(`cat ${test_db_files_mount}/source.pdf | grep application/pdf`);

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("content type is 'application/pdf'");
	});

	test("does not suggest rereading the same unreadable file path", async () => {
		const { run } = await create_bash_runner();

		const result = await run(`cat ${test_db_files_mount}/uploaded.md`);
		const suggestionLine = result.stderr
			.split("\n")
			.find((line) => line.startsWith("To read generated text output for this file"));

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(suggestionLine).toBeDefined();
		// The advisory must suggest readable siblings, never re-reading the same unreadable path.
		expect(suggestionLine).not.toContain(`${test_db_files_mount}/uploaded.md,`);
		expect(suggestionLine?.endsWith(`${test_db_files_mount}/uploaded.md`)).toBe(false);
		expect(suggestionLine).toContain(`${test_db_files_mount}/uploaded.md.md`);
		expect(suggestionLine).toContain(`${test_db_files_mount}/uploaded.txt`);
	});

	test("app redirect writes become pending proposals and same-thread /tmp scratch files persist", async () => {
		const { run, runMutation } = await create_bash_runner();

		const organizationWrite = await run(`echo nope > ${test_db_files_mount}/docs/new.md`);
		expect(organizationWrite.metadata.exitCode).toBe(0);
		expect(organizationWrite.stderr).toBe("");

		const tmpWrite = await run("printf hi > /tmp/a.txt");
		expect(tmpWrite.metadata.exitCode).toBe(0);

		const nextInvocation = await run("cat /tmp/a.txt");
		expect(nextInvocation.metadata.exitCode).toBe(0);
		expect(nextInvocation.stdout).toBe("hi");

		// Only the tmp write flushes; the app proposal write and the read do not.
		const patchCalls = runMutation.mock.calls.filter(
			([ref]) => function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files",
		);
		expect(patchCalls).toHaveLength(1);
	});

	test("flushes only changed /tmp paths as a delta", async () => {
		const { run, runMutation } = await create_bash_runner();

		await run("printf one > /tmp/a.txt && printf two > /tmp/b.txt");
		const update = await run("printf ONE > /tmp/a.txt");

		expect(update.metadata.exitCode).toBe(0);

		const patchCalls = runMutation.mock.calls.filter(
			([ref]) => function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files",
		);
		const lastPatchArgs = patchCalls.at(-1)?.[1] as
			| {
					fileNodes: ai_chat_files_patch_thread_tmp_files_Args["fileNodes"];
					fileNodesContent: ai_chat_files_patch_thread_tmp_files_Args["fileNodesContent"];
					deletePaths: string[];
			  }
			| undefined;
		expect(lastPatchArgs?.fileNodes.map((tmpFile) => tmpFile.path)).toEqual(["/a.txt"]);
		expect(lastPatchArgs?.fileNodesContent).toEqual([{ path: "/a.txt", content: expect.any(ArrayBuffer) }]);
		expect(lastPatchArgs?.deletePaths).toEqual([]);

		const read = await run("cat /tmp/a.txt /tmp/b.txt");
		expect(read.stdout).toBe("ONEtwo");
	});

	test("flushes a /tmp file whose name is not ASCII and one that holds half a character", async () => {
		const { run, runMutation } = await create_bash_runner();

		// Convex allows only printable ASCII field names, so while this payload kept the content in a
		// record keyed by path, one file named `café.txt` failed the whole call. A name can also hold
		// half a character, which Convex refuses anywhere. That one is repaired on its way out, like the
		// output is.
		const wrote = await run(`printf hi > /tmp/café.txt && printf hi > "/tmp/$(printf 'a\\ud83c').txt"`);
		expect(wrote.metadata.exitCode, wrote.stderr).toBe(0);

		const patchCalls = runMutation.mock.calls.filter(
			([ref]) => function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files",
		);
		const lastPatchArgs = patchCalls.at(-1)?.[1] as
			| {
					fileNodes: ai_chat_files_patch_thread_tmp_files_Args["fileNodes"];
					fileNodesContent: ai_chat_files_patch_thread_tmp_files_Args["fileNodesContent"];
			  }
			| undefined;
		expect(lastPatchArgs?.fileNodes.map((tmpFile) => tmpFile.path).sort()).toEqual(["/a�.txt", "/café.txt"]);
		expect(lastPatchArgs?.fileNodesContent.map((entry) => entry.path).sort()).toEqual(["/a�.txt", "/café.txt"]);
	});

	test("keeps one /tmp node when two names repair to the same path", async () => {
		const { run, runMutation } = await create_bash_runner();

		// Every half of a character is repaired to the same U+FFFD, so these two names leave the call as
		// one path. Only one node may be sent for it. Two would write two docs for one path, and the next
		// call could not even build the filesystem: `mkdir` refuses a path a file already holds, so every
		// later call in the thread would fail before it ran a command.
		const wrote = await run(`printf hi > "/tmp/$(printf 'a\\ud83c').txt" && mkdir "/tmp/$(printf 'a\\udf89').txt"`);
		expect(wrote.metadata.exitCode, wrote.stderr).toBe(0);

		const patchCalls = runMutation.mock.calls.filter(
			([ref]) => function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files",
		);
		const lastPatchArgs = patchCalls.at(-1)?.[1] as
			| { fileNodes: ai_chat_files_patch_thread_tmp_files_Args["fileNodes"] }
			| undefined;
		expect(lastPatchArgs?.fileNodes.map((tmpFile) => tmpFile.path)).toEqual(["/a�.txt"]);

		// The thread still works: the next call reads the /tmp it just wrote.
		expect((await run("ls /tmp")).metadata.exitCode).toBe(0);
	});
	test("flushes /tmp removals as delete-only deltas", async () => {
		const { run, runMutation } = await create_bash_runner();

		await run("printf one > /tmp/a.txt && printf two > /tmp/b.txt");
		const remove = await run("rm /tmp/a.txt");

		expect(remove.metadata.exitCode).toBe(0);

		const patchCalls = runMutation.mock.calls.filter(
			([ref]) => function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files",
		);
		const lastPatchArgs = patchCalls.at(-1)?.[1] as { fileNodes: unknown[]; deletePaths: string[] } | undefined;
		expect(lastPatchArgs?.fileNodes).toEqual([]);
		expect(lastPatchArgs?.deletePaths).toEqual(["/a.txt"]);
	});

	test("persists nested /tmp creates and recursive deletes through deltas", async () => {
		const { run } = await create_bash_runner();

		const create = await run("mkdir -p /tmp/a/b && printf nested > /tmp/a/b/c.txt");
		expect(create.metadata.exitCode).toBe(0);

		const hydratedRead = await run("cat /tmp/a/b/c.txt");
		expect(hydratedRead.metadata.exitCode).toBe(0);
		expect(hydratedRead.stdout).toBe("nested");

		const remove = await run("rm -r /tmp/a");
		expect(remove.metadata.exitCode).toBe(0);

		const missing = await run("cat /tmp/a/b/c.txt");
		expect(missing.metadata.exitCode).not.toBe(0);
		expect(missing.stderr).toContain("No such file");
	});

	test("persists /tmp copy and move changes through deltas", async () => {
		const { run } = await create_bash_runner();

		await run("mkdir -p /tmp/src && printf copied > /tmp/src/a.txt && printf moved > /tmp/to-move.txt");
		const copyMove = await run("cp -r /tmp/src /tmp/copy && mv /tmp/to-move.txt /tmp/moved.txt");

		expect(copyMove.metadata.exitCode).toBe(0);

		const read = await run("cat /tmp/src/a.txt /tmp/copy/a.txt /tmp/moved.txt");
		expect(read.stdout).toBe("copiedcopiedmoved");
	});

	test("persists /tmp copy and move into existing directories through real destination paths", async () => {
		const { run, runMutation } = await create_bash_runner();

		await run(
			"mkdir -p /tmp/src /tmp/copy-dir /tmp/move-dir && printf copied > /tmp/src/a.txt && printf moved > /tmp/to-move.txt",
		);
		runMutation.mockClear();

		const copyMove = await run("cp /tmp/src/a.txt /tmp/copy-dir && mv /tmp/to-move.txt /tmp/move-dir");

		expect(copyMove.metadata.exitCode).toBe(0);
		const patchCalls = runMutation.mock.calls.filter(
			([ref]) => function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files",
		);
		const lastPatchArgs = patchCalls.at(-1)?.[1] as
			| {
					fileNodes: ai_chat_files_patch_thread_tmp_files_Args["fileNodes"];
					fileNodesContent: ai_chat_files_patch_thread_tmp_files_Args["fileNodesContent"];
					deletePaths: string[];
			  }
			| undefined;
		expect(lastPatchArgs?.fileNodes.map((tmpFile) => tmpFile.path)).toEqual([
			"/copy-dir/a.txt",
			"/move-dir/to-move.txt",
		]);
		expect(lastPatchArgs?.fileNodesContent).toEqual([
			{ path: "/copy-dir/a.txt", content: expect.any(ArrayBuffer) },
			{ path: "/move-dir/to-move.txt", content: expect.any(ArrayBuffer) },
		]);
		expect(lastPatchArgs?.deletePaths).toEqual(["/to-move.txt"]);

		const read = await run("cat /tmp/copy-dir/a.txt /tmp/move-dir/to-move.txt");
		expect(read.stdout).toBe("copiedmoved");
	});

	test("scopes durable /tmp scratch files by thread", async () => {
		const writer = await create_bash_runner();
		await writer.run("printf thread-a > /tmp/scope.txt");
		const shared = { t: writer.t, seeded: writer.seeded };

		const sameScope = await create_bash_runner({ shared, threadId: writer.threadId });
		const sameScopeRead = await sameScope.run("cat /tmp/scope.txt");
		expect(sameScopeRead.metadata.exitCode).toBe(0);
		expect(sameScopeRead.stdout).toBe("thread-a");

		const otherThread = await create_bash_runner({ shared });
		const otherThreadRead = await otherThread.run("cat /tmp/scope.txt");
		expect(otherThreadRead.metadata.exitCode).not.toBe(0);
		expect(otherThreadRead.stderr).toContain("No such file");

		const otherUserSeeded = await writer.t.run((ctx) => test_mocks_fill_db_with.membership(ctx, {}));
		const sameThreadOtherUser = await create_bash_runner({
			shared,
			threadId: writer.threadId,
			userId: otherUserSeeded.userId,
		});
		await expect(sameThreadOtherUser.run("cat /tmp/scope.txt")).rejects.toThrow("Unauthorized");
	});

	test("merges parallel same-thread /tmp writes through deltas", async () => {
		const { run } = await create_bash_runner();

		const [aResult, bResult] = await Promise.all([run("printf a > /tmp/a.txt"), run("printf b > /tmp/b.txt")]);
		expect(aResult.metadata.exitCode).toBe(0);
		expect(bResult.metadata.exitCode).toBe(0);

		const read = await run("cat /tmp/a.txt /tmp/b.txt");
		expect(read.metadata.exitCode).toBe(0);
		expect(read.stdout).toBe("ab");
	});

	test("evicts the oldest /tmp scratch paths beyond the path cap", async () => {
		const { run } = await create_bash_runner();

		await run("printf old > /tmp/old.txt");
		// The path cap is private to bash.ts and small in dev. 20 new paths are enough to go over it.
		// The exact eviction count is asserted by the in-source tmp_fs_evict_to_limits tests.
		const paths = Array.from({ length: 20 }, (_, index) => `/tmp/p-${index}.txt`).join(" ");
		const overflow = await run(`touch ${paths}`);
		expect(overflow.metadata.exitCode).toBe(0);
		// old.txt was written by an earlier call, so it is the oldest path and is listed first.
		expect(overflow.stderr).toContain("oldest path(s) to fit: /tmp/old.txt");

		const list = await run("ls /tmp");
		expect(list.stdout).toContain("p-");
		expect(list.stdout).not.toContain("old.txt");
	});

	test("evicts the oldest /tmp scratch files beyond the byte cap", async () => {
		const { run } = await create_bash_runner();

		// Each seq output is ~1.7KB: under the per-file cap, but three together pass the 4KB session cap.
		const first = await run("seq 1 470 > /tmp/a.txt");
		expect(first.stderr).toBe("");
		const overflow = await run("seq 1 470 > /tmp/b.txt && seq 1 470 > /tmp/c.txt");
		expect(overflow.metadata.exitCode).toBe(0);
		expect(overflow.stderr).toContain("evicted the 1 oldest path(s) to fit: /tmp/a.txt");

		const evictedRead = await run("cat /tmp/a.txt");
		expect(evictedRead.metadata.exitCode).not.toBe(0);
		const survivorsRead = await run("cat /tmp/b.txt /tmp/c.txt");
		expect(survivorsRead.metadata.exitCode).toBe(0);
	});

	test("evicts only the offending /tmp file beyond the per-file cap", async () => {
		const { run } = await create_bash_runner();

		// seq 1 1000 is ~3.9KB, past the 2KB per-file cap.
		const result = await run("seq 1 1000 > /tmp/big.txt && printf keep > /tmp/keep.txt");
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stderr).toContain("discarded 1 oversized file(s): /tmp/big.txt");

		const read = await run("cat /tmp/keep.txt && cat /tmp/big.txt");
		expect(read.stdout).toBe("keep");
		expect(read.metadata.exitCode).not.toBe(0);
	});

	test("creates persistent app file tree folders through bash mkdir when allowed", async () => {
		const { run, runMutation, seeded } = await create_bash_runner({ allowDbFilesMkdir: true });

		const result = await run(
			`mkdir ${test_db_files_mount}/bash-created && stat ${test_db_files_mount}/bash-created && ls ${test_db_files_mount}`,
		);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("drwx");
		expect(result.stdout).toContain("bash-created");
		expect(runMutation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				path: "/bash-created",
				userId: seeded.userId,
			}),
		);
	});

	test("blocks app file tree folder creation through bash mkdir when not allowed", async () => {
		const { run, runMutation } = await create_bash_runner({ allowDbFilesMkdir: false });

		const result = await run(`mkdir ${test_db_files_mount}/ask-denied`);

		expect(result.metadata.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Agent mode");
		expect(result.stderr).toContain("Scratch space does not create durable folders");
		expect(runMutation).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				path: "/ask-denied",
			}),
		);
	});

	test("normalizes the skills folder through bash mkdir", async () => {
		const { run, runMutation } = await create_bash_runner({ allowDbFilesMkdir: true });
		const result = await run(`mkdir -p ${test_db_files_mount}/.AGENTS/skills/one`);
		expect(result.metadata.exitCode).toBe(0);
		expect(runMutation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ path: "/.agents/skills/one" }),
		);
	});

	test("runs indexed search with options before the query", async () => {
		const { run, runQuery, seeded } = await create_bash_runner();

		const result = await run("search --limit 5 unique-token");

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("unique-token");
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(runQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				userId: seeded.userId,
				query: "unique-token",
				numItems: 5,
				cursor: null,
			}),
		);
	});

	test("runs indexed search with equals-form options", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run(`search --path=${test_db_files_mount}/docs --limit=5 unique-token`);

		expect(result.metadata.exitCode).toBe(0);
		expect(runQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				query: "unique-token",
				numItems: 5,
				pathPrefix: "/docs",
			}),
		);
	});

	test("annotates broad full-text results for exact hyphenated token searches", async () => {
		// The broad fixture's intraword bold breaks the literal token in the markdown chunk while
		// the plain-text search index still matches it; the hit stays in the page with a
		// word-level note instead of being filtered out.
		const { run } = await create_bash_runner({
			extraFiles: [
				{ path: "/search-fixtures/hyphen.md", content: "exact-hyphen-token-2026 inside\n" },
				{ path: "/search-fixtures/broad.md", content: "broad mention exact-hyphen-to**ken-2026ish** here\n" },
			],
		});

		const result = await run("search --limit 5 exact-hyphen-token-2026");

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain(
			"Found 2 results (exact matches: 1, word-level-only matches: 1; see per-hit notes)",
		);
		expect(result.stdout).toMatch(/search-fixtures\/hyphen\.md .+\[contains exact 'exact-hyphen-token-2026'\]/u);
		expect(result.stdout).toMatch(
			/search-fixtures\/broad\.md .+\[word-level match; chunk does not contain 'exact-hyphen-token-2026'\]/u,
		);
	});

	test("finds content whose phrase spans a chunk boundary", async () => {
		// Chunks are cut at a hard character offset with no overlap (see OVERLAP in
		// files-markdown-chunking-mastra.ts), so a phrase across the cut lives in no single chunk.
		// Recall must not depend on overlap: the per-chunk term index still has to surface the file.
		const phrase = "quarterly revenue reconciliation";
		const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ";
		const { run } = await create_bash_runner({
			extraFiles: [
				{
					path: "/split/boundary.md",
					content: `# Report\n\n${filler.repeat(20).slice(0, 1190)}${phrase} tail words follow.\n`,
				},
			],
		});

		const result = await run(`search --limit 5 "${phrase}"`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("Found 1 results");
		expect(result.stdout).toContain("/split/boundary.md");
		// The snippet shows the side of the cut that holds most of the phrase, and flags the rest.
		expect(result.stdout).toContain("revenue reconciliation tail words follow.");
		expect(result.stdout).toContain("... more content above");
	});

	test("keeps word-level-only search pages full and the continuation reachable", async () => {
		// Broad file is seeded first so the limit-1 first page holds only the word-level hit;
		// the exact match lives on the next page and must stay reachable via Next page.
		const { run } = await create_bash_runner({
			extraFiles: [
				{ path: "/search-fixtures/broad.md", content: "broad mention exact-hyphen-to**ken-2026ish** here\n" },
				{ path: "/search-fixtures/hyphen.md", content: "exact-hyphen-token-2026 inside\n" },
			],
		});

		const firstPage = await run("search --limit 1 exact-hyphen-token-2026");

		expect(firstPage.metadata.exitCode).toBe(0);
		expect(firstPage.stdout).toContain(
			"Found 1 results (exact matches: 0, word-level-only matches: 1; see per-hit notes)",
		);
		expect(firstPage.stdout).toMatch(
			/search-fixtures\/broad\.md .+\[word-level match; chunk does not contain 'exact-hyphen-token-2026'\]/u,
		);
		expect(firstPage.stdout).toMatch(/Next page: search --limit 1 --cursor \S+ exact-hyphen-token-2026/u);
		expect(firstPage.stdout.indexOf("Next page: search")).toBeLessThan(
			firstPage.stdout.indexOf(`${test_db_files_mount}/search-fixtures/broad.md`),
		);
		expect(firstPage.stdout).toContain("run the exact Next page command before answering");

		const continuation = firstPage.stdout.match(/Next page: (search .+)/u)?.[1];
		if (continuation == null) {
			throw new Error("expected a search continuation in the first page stdout");
		}
		const secondPage = await run(continuation);

		expect(secondPage.metadata.exitCode).toBe(0);
		expect(secondPage.stdout).toContain("exact-hyphen-token-2026 inside");
		expect(secondPage.stdout).toMatch(/search-fixtures\/hyphen\.md .+\[contains exact 'exact-hyphen-token-2026'\]/u);
	});

	test("rejects indexed search invalid limit values", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run("search --limit nope unique-token");

		expect(result.metadata.exitCode).toBe(2);
		expect(result.stderr).toContain("search: --limit must be an integer");
		expect(runQuery.mock.calls.some(([, queryArgs]) => "query" in queryArgs)).toBe(false);
	});

	test("prints a search continuation when indexed search has another db page", async () => {
		const { run, runQuery } = await create_bash_runner({
			extraFiles: [
				{ path: "/docs/paged-a.md", content: "paged-token alpha\n" },
				{ path: "/docs/paged-b.md", content: "paged-token beta\n" },
			],
		});

		const firstPage = await run("search --limit 1 paged-token");
		const complete = await run("search --limit 5 unique-token");

		expect(firstPage.metadata.exitCode).toBe(0);
		expect(firstPage.stdout).toContain("Found 1 results");
		expect(firstPage.stdout).toMatch(/Next page: search --limit 1 --cursor \S+ paged-token/u);
		expect(complete.stdout).not.toContain("Next page: search");
		const pageProbeCalls = runQuery.mock.calls.filter(
			([, args]) => "query" in args && "cursor" in args && !("numItems" in args),
		);
		expect(pageProbeCalls).toHaveLength(0);
	});

	test("reports unknown indexed search cursor ids", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run("search --limit 1 --cursor cursor-1 paged-token");

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("cursor cursor-1 expired, is unavailable, or was copied incorrectly");
		expect(result.stderr).toContain("Copy the exact --cursor value from the latest Next page command and retry");
		expect(runQuery).toHaveBeenCalledWith(internal.value_store.get, { id: "cursor-1" });
	});

	test("does not probe scoped search continuations because Convex filters paginate results", async () => {
		const { run, runQuery } = await create_bash_runner({
			extraFiles: [
				{ path: "/docs/paged-a.md", content: "paged-token alpha\n" },
				{ path: "/docs/paged-b.md", content: "paged-token beta\n" },
			],
		});

		const result = await run(`search --path ${test_db_files_mount}/docs --limit 1 paged-token`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("Next page: search --path");
		expect(result.stdout).not.toContain("No matches in this page; more pages exist.");
		expect(runQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ query: "paged-token", pathPrefix: "/docs", numItems: 1 }),
		);
		const pageProbeCalls = runQuery.mock.calls.filter(
			([, args]) => "query" in args && "cursor" in args && !("numItems" in args),
		);
		expect(pageProbeCalls).toHaveLength(0);
	});

	test("rejects db-files path operands in indexed search instead of folding them into the query", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run(`search --limit 5 unique-token ${test_db_files_mount}`);

		expect(result.metadata.exitCode).toBe(2);
		expect(result.stderr).toContain("path operands are not supported");
		expect(result.stderr).toContain("search --path <folder>");
		expect(runQuery.mock.calls.some(([, queryArgs]) => "query" in queryArgs)).toBe(false);
	});

	test("scopes indexed search to a folder with --path", async () => {
		const { run, runQuery } = await create_bash_runner();

		// In-scope folder -> hit, and the db-files path is passed through to the query.
		const inScope = await run(`search --path ${test_db_files_mount}/docs unique-token`);
		expect(inScope.metadata.exitCode).toBe(0);
		expect(inScope.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(inScope.stdout).toContain(`under ${test_db_files_mount}/docs`);
		expect(runQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }),
		);

		// Bare search follows the current app cwd so "cd dir && search term" stays db-scoped.
		const cwdScope = await run(`cd ${test_db_files_mount}/docs && search unique-token`);
		expect(cwdScope.metadata.exitCode).toBe(0);
		expect(cwdScope.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(cwdScope.stdout).toContain(`under ${test_db_files_mount}/docs`);
		const searchCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "query" in args);
		expect(searchCalls.at(-1)).toEqual(expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }));

		// Relative --path (including `.`) resolves against the current working directory.
		const relScope = await run(`cd ${test_db_files_mount} && search --path docs unique-token`);
		expect(relScope.metadata.exitCode).toBe(0);
		expect(relScope.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(relScope.stdout).toContain(`under ${test_db_files_mount}/docs`);

		const dotScope = await run(`cd ${test_db_files_mount}/docs && search --path . unique-token`);
		expect(dotScope.metadata.exitCode).toBe(0);
		expect(dotScope.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		const relCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "query" in args);
		expect(relCalls.at(-1)).toEqual(expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }));

		// Explicit --path scopes must be real app folders.
		const missingScope = await run(`search --path ${test_db_files_mount}/other unique-token`);
		expect(missingScope.metadata.exitCode).toBe(1);
		expect(missingScope.stderr).toContain("--path folder does not exist");

		const fileScope = await run(`search --path ${test_db_files_mount}/docs/readme.md unique-token`);
		expect(fileScope.metadata.exitCode).toBe(2);
		expect(fileScope.stderr).toContain("--path must be a folder");

		// A --path outside currentWorkspacePath (and outside any mount) is rejected.
		const bad = await run("search --path /etc unique-token");
		expect(bad.metadata.exitCode).toBe(2);
		expect(bad.stderr).toContain("--path must be a folder under");
	});

	test("textgrep scans one file's rendered plain text and maps -R to indexed search", async () => {
		const { run, runQuery } = await create_bash_runner({
			extraFiles: [{ path: "/docs/textgrep.md", content: "# Notice\n\n**critical** alert\n" }],
		});
		const filePath = `${test_db_files_mount}/docs/textgrep.md`;

		// Single-file regex over rendered plain text: no line numbers, no separators.
		const singleFile = await run(`textgrep 'critical\\s+alert' ${filePath}`);
		expect(singleFile.metadata.exitCode).toBe(0);
		expect(singleFile.stdout).toBe("critical alert\n");
		expect(singleFile.stderr).toBe("");

		// -F treats regex metacharacters literally, so "critical.alert" does not match.
		const fixed = await run(`textgrep -F 'critical.alert' ${filePath}`);
		expect(fixed.metadata.exitCode).toBe(1);
		expect(fixed.stdout).toBe("");

		// -c counts matching lines; an absent pattern still prints 0 (exit 1).
		const count = await run(`textgrep -c 'critical' ${filePath}`);
		expect(count.metadata.exitCode).toBe(0);
		expect(count.stdout).toBe("1\n");
		const countAbsent = await run(`textgrep -c 'absent-token' ${filePath}`);
		expect(countAbsent.metadata.exitCode).toBe(1);
		expect(countAbsent.stdout).toBe("0\n");

		// -l prints the path when there is a match.
		const list = await run(`textgrep -l 'critical' ${filePath}`);
		expect(list.metadata.exitCode).toBe(0);
		expect(list.stdout).toBe(`${filePath}\n`);

		// -v keeps non-matching lines.
		const invert = await run(`textgrep -v 'critical' ${filePath}`);
		expect(invert.metadata.exitCode).toBe(0);
		expect(invert.stdout).not.toContain("critical alert");

		// -R folder scan routes to indexed full-text search, mirroring grep -R.
		const recursive = await run(`textgrep -R unique-token ${test_db_files_mount}/docs`);
		expect(recursive.metadata.exitCode).toBe(0);
		expect(recursive.stdout).toContain("uses indexed full-text search");
		expect(recursive.stdout).toContain(`Found 1 results under ${test_db_files_mount}/docs`);
		expect(recursive.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:text_search_files")).toBe(true);
		expect(runQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }),
		);

		// Invalid regex over a single file is reported.
		const invalid = await run(`textgrep '[' ${filePath}`);
		expect(invalid.metadata.exitCode).toBe(2);
		expect(invalid.stderr).toContain("invalid regex");

		// -n is rejected with a pointer to grep.
		const lineNumbers = await run(`textgrep -n 'critical' ${filePath}`);
		expect(lineNumbers.metadata.exitCode).toBe(2);
		expect(lineNumbers.stderr).toContain("grep -n");
	});

	test("textgrep parses extended grep flags and rejects unsupported / recursive-fixed-string forms", async () => {
		const { run, runQuery } = await create_bash_runner({
			extraFiles: [{ path: "/docs/textgrep.md", content: "# Notice\n\n**critical** alert\n" }],
		});
		const filePath = `${test_db_files_mount}/docs/textgrep.md`;
		const folder = `${test_db_files_mount}/docs`;

		// -e / --regexp supply the pattern explicitly.
		const dashE = await run(`textgrep -e 'critical' ${filePath}`);
		expect(dashE.metadata.exitCode).toBe(0);
		expect(dashE.stdout).toBe("critical alert\n");
		const longRegexp = await run(`textgrep --regexp='critical' ${filePath}`);
		expect(longRegexp.metadata.exitCode).toBe(0);
		expect(longRegexp.stdout).toBe("critical alert\n");

		// Combined short flags: -iF (ignore-case + fixed string), -cl (count + list → list wins).
		const combinedIF = await run(`textgrep -iF 'CRITICAL' ${filePath}`);
		expect(combinedIF.metadata.exitCode).toBe(0);
		expect(combinedIF.stdout).toBe("critical alert\n");
		const combinedCL = await run(`textgrep -cl 'critical' ${filePath}`);
		expect(combinedCL.metadata.exitCode).toBe(0);
		expect(combinedCL.stdout).toBe(`${filePath}\n`);

		// Long aliases mirror their short forms.
		const longFixed = await run(`textgrep --fixed-strings 'critical.alert' ${filePath}`);
		expect(longFixed.metadata.exitCode).toBe(1);
		expect(longFixed.stdout).toBe("");
		const longInvert = await run(`textgrep --invert-match 'critical' ${filePath}`);
		expect(longInvert.metadata.exitCode).toBe(0);
		expect(longInvert.stdout).not.toContain("critical alert");
		const longCount = await run(`textgrep --count 'critical' ${filePath}`);
		expect(longCount.metadata.exitCode).toBe(0);
		expect(longCount.stdout).toBe("1\n");
		const longList = await run(`textgrep --files-with-matches 'critical' ${filePath}`);
		expect(longList.metadata.exitCode).toBe(0);
		expect(longList.stdout).toBe(`${filePath}\n`);

		// Context flags are rejected with a pointer to grep.
		for (const contextFlag of ["-A 1", "-B 1", "-C 1", "--context=2"]) {
			const contextRes = await run(`textgrep ${contextFlag} 'critical' ${filePath}`);
			expect(contextRes.metadata.exitCode).toBe(2);
			expect(contextRes.stderr).toContain("context windows");
		}

		// Markdown scan-window flags are rejected.
		const startLine = await run(`textgrep --start-line 2 'critical' ${filePath}`);
		expect(startLine.metadata.exitCode).toBe(2);
		expect(startLine.stderr).toContain("scan-window");
		const startIndex = await run(`textgrep --start-index 0 'critical' ${filePath}`);
		expect(startIndex.metadata.exitCode).toBe(2);
		expect(startIndex.stderr).toContain("scan-window");

		// Removed folder-regex flags now surface as unsupported options.
		for (const removedFlag of ["--path", "--limit", "--cursor"]) {
			const removed = await run(`textgrep ${removedFlag} 'critical' ${filePath}`);
			expect(removed.metadata.exitCode).toBe(2);
			expect(removed.stderr).toContain(`unsupported option ${removedFlag}`);
		}

		// Recursive -c / -l / -v fall to single-file guidance, never indexed search.
		for (const recursiveFlag of ["-c", "-l", "-v"]) {
			const recursive = await run(`textgrep -R ${recursiveFlag} 'critical' ${folder}`);
			expect(recursive.metadata.exitCode).toBe(2);
			expect(recursive.stdout).toContain("textgrep regex runs over ONE app file");
		}

		// Recursive -F is rejected: indexed scans cannot do exact fixed-string matching.
		const recursiveFixed = await run(`textgrep -R -F 'critical' ${folder}`);
		expect(recursiveFixed.metadata.exitCode).toBe(2);
		expect(recursiveFixed.stderr).toContain("does not support exact fixed-string");

		// None of the rejected/guidance forms above reached indexed full-text search.
		expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:text_search_files")).toBe(false);
	});

	test("meta searches indexed frontmatter and inspects one file", async () => {
		const { run, runQuery } = await create_bash_runner({
			extraFiles: [
				{
					path: "/docs/meta-email.md",
					content:
						"---\nfrom: alice@example.com\ncc:\n  - Bob\n  - Jane\namount: 125\nreviewed: true\nsentAt: 2026-07-29T14:30:00Z\n---\n# Email\n",
				},
				{
					path: "/docs/meta-tags.md",
					content: "---\ntopic:\n  - alpha\n  - atlas\n---\n# Tags\n",
				},
			],
		});

		const paths = await run(`meta search --where '{"eq":["frontmatter.from","alice@example.com"]}' --limit 5`);
		const json = await run(`meta search --format json --where '{"range":["frontmatter.amount",{"gte":100}]}'`);
		const jsonExists = await run(`meta search --format json --where '{"exists":"frontmatter.cc"}'`);
		const jsonDateRange = await run(
			`meta search --format json --where '{"range":["frontmatter.sentAt",{"gte":"2026-07-27","lt":"2026-08-02"}]}'`,
		);
		const dedupedPrefix = await run(`meta search --where '{"prefix":["frontmatter.topic","a"]}' --limit 5`);
		const scoped = await run(`cd ${test_db_files_mount}/docs && meta search --where '{"exists":"frontmatter.cc"}'`);
		const get = await run(`meta get ${test_db_files_mount}/docs/meta-email.md`);
		const invalid = await run(`meta search --where '{"eq":["from","alice@example.com"]}'`);

		expect(paths.metadata.exitCode).toBe(0);
		expect(paths.stdout).toBe(`${test_db_files_mount}/docs/meta-email.md\n`);
		expect(paths.stderr).toBe("");
		expect(
			runQuery.mock.calls.some(
				([ref, args]) => function_name_of(ref) === "files_metadata:search" && (args as { plan?: unknown }).plan != null,
			),
		).toBe(true);

		expect(json.metadata.exitCode).toBe(0);
		expect(json.stderr).toBe("");
		const parsedJson = JSON.parse(json.stdout) as {
			results: Array<{ path: string; field: string; valueKind: string; matchedValue: unknown }>;
			nextCursor: string | null;
		};
		expect(parsedJson.results).toEqual([
			expect.objectContaining({
				path: `${test_db_files_mount}/docs/meta-email.md`,
				field: "frontmatter.amount",
				valueKind: "number",
				matchedValue: 125,
			}),
		]);
		expect(parsedJson.nextCursor).toBeNull();

		expect(jsonExists.metadata.exitCode).toBe(0);
		expect(jsonExists.stderr).toBe("");
		const parsedExistsJson = JSON.parse(jsonExists.stdout) as {
			results: Array<{ path: string; field: string; valueKind: string; matchedValue?: unknown }>;
		};
		expect(parsedExistsJson.results).toEqual([
			expect.objectContaining({
				path: `${test_db_files_mount}/docs/meta-email.md`,
				field: "frontmatter.cc",
				valueKind: "none",
			}),
		]);
		expect(parsedExistsJson.results[0]).not.toHaveProperty("matchedValue");

		expect(jsonDateRange.metadata.exitCode).toBe(0);
		expect(jsonDateRange.stderr).toBe("");
		const parsedDateRangeJson = JSON.parse(jsonDateRange.stdout) as {
			results: Array<{ path: string; field: string; valueKind: string; matchedValue: unknown }>;
		};
		// Confirm that string bounds match the maybe_date companion doc and render as an ISO string.
		expect(parsedDateRangeJson.results).toEqual([
			expect.objectContaining({
				path: `${test_db_files_mount}/docs/meta-email.md`,
				field: "frontmatter.sentAt",
				valueKind: "maybe_date",
				matchedValue: "2026-07-29T14:30:00.000Z",
			}),
		]);

		expect(dedupedPrefix.metadata.exitCode).toBe(0);
		expect(dedupedPrefix.stderr).toBe("");
		expect(dedupedPrefix.stdout).toBe(`${test_db_files_mount}/docs/meta-tags.md\n`);

		expect(scoped.metadata.exitCode).toBe(0);
		expect(scoped.stdout).toBe(`${test_db_files_mount}/docs/meta-email.md\n`);
		expect(
			runQuery.mock.calls.some(
				([ref, args]) =>
					function_name_of(ref) === "files_metadata:search" && (args as { pathPrefix?: string }).pathPrefix === "/docs",
			),
		).toBe(true);

		expect(get.metadata.exitCode).toBe(0);
		expect(get.stdout).toContain("source: committed");
		expect(get.stdout).toContain("frontmatter.cc");
		expect(get.stdout).toContain('frontmatter.from = "alice@example.com"');
		// A date-like string produces two lines. Only the maybe_date line carries the marker, so the
		// agent can tell them apart and see that the field supports range filters.
		expect(get.stdout).toContain('frontmatter.sentAt = "2026-07-29T14:30:00Z"\n');
		expect(get.stdout).toContain('frontmatter.sentAt = "2026-07-29T14:30:00.000Z" (maybe_date)');

		expect(invalid.metadata.exitCode).toBe(2);
		expect(invalid.stderr).toContain("must be qualified");
	});

	test("reads and searches a folder map written by the metadata tool", async () => {
		const runner = await create_bash_runner();
		const tool = ai_chat_tool_create_set_file_metadata(runner.ctx, runner.ctxData);
		const written = await tool.execute?.(
			{
				path: "/docs",
				set: [
					{ key: "plugin-name", value: "chitchat" },
					{ key: "reviewed", value: false },
				],
				remove: [],
			},
			{ toolCallId: "folder-metadata", messages: [] },
		);
		expect(written).toMatchObject({ metadata: { path: "/docs" } });

		const get = await runner.run(`meta get ${test_db_files_mount}/docs`);
		expect(get.metadata.exitCode).toBe(0);
		expect(get.stdout).toContain('metadata.plugin-name = "chitchat"');
		expect(get.stdout).toContain("metadata.reviewed = false");
		expect(get.stdout).not.toContain("frontmatter.");
		const json = await runner.run(`meta get ${test_db_files_mount}/docs --format json`);
		expect(json.metadata.exitCode).toBe(0);
		expect(JSON.parse(json.stdout)).toMatchObject({
			path: `${test_db_files_mount}/docs`,
			fields: ["metadata.plugin-name", "metadata.reviewed"],
			values: [
				{ field: "metadata.plugin-name", valueKind: "string", value: "chitchat" },
				{ field: "metadata.reviewed", valueKind: "boolean", value: false },
			],
		});
		const search = await runner.run(`meta search --where '{"eq":["metadata.plugin-name","chitchat"]}'`);
		expect(search.metadata.exitCode).toBe(0);
		expect(search.stdout).toBe(`${test_db_files_mount}/docs\n`);

		await tool.execute?.(
			{ path: "/docs", set: [], remove: ["plugin-name", "reviewed"] },
			{ toolCallId: "remove-folder-metadata", messages: [] },
		);
		const empty = await runner.run(`meta get ${test_db_files_mount}/docs --format json`);
		expect(empty.metadata.exitCode).toBe(0);
		expect(JSON.parse(empty.stdout)).toMatchObject({ fields: [], values: [] });
	});

	test("does not scan markdown files when indexed search misses", async () => {
		const { run, runAction } = await create_bash_runner();

		const result = await run("search --limit 5 zzz-absent-token");

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("No content matches found");
		expect(result.stdout).toContain("find --path-query QUERY");
		expect(result.stdout).toContain("meta search");
		expect(runAction).not.toHaveBeenCalled();
	});

	test("rejects chunk-type filters for indexed search", async () => {
		const { run, runQuery } = await create_bash_runner();

		const code = await run("search --code code-token");
		const table = await run("search --table table-token");
		const noCode = await run("search --no-code unique-token");

		expect(code.metadata.exitCode).toBe(2);
		expect(table.metadata.exitCode).toBe(2);
		expect(noCode.metadata.exitCode).toBe(2);
		expect(code.stderr).toContain("--code is not supported");
		expect(table.stderr).toContain("--table is not supported");
		expect(noCode.stderr).toContain("--no-code is not supported");
		expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:text_search_files")).toBe(false);
	});

	test("maps simple recursive app grep to indexed search", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run(`grep -R unique-token ${test_db_files_mount}/docs`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("uses indexed full-text search");
		expect(result.stdout).toContain(`Found 1 results under ${test_db_files_mount}/docs`);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(runQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }),
		);
	});

	test("rejects grep -R -F over an app folder instead of routing to indexed search", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run(`grep -R -F unique-token ${test_db_files_mount}/docs`);

		expect(result.metadata.exitCode).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("does not support exact fixed-string");
		expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:text_search_files")).toBe(false);
	});

	test("annotates broad full-text results for exact hyphenated grep -R patterns", async () => {
		// Same intraword-bold trick as the search annotation tests: the index matches broad.md
		// but its markdown chunk lacks the literal token, so its hit carries the word-level note.
		const { run } = await create_bash_runner({
			extraFiles: [
				{ path: "/grep-fixtures/hyphen.md", content: "exact-hyphen-token-2026 inside\n" },
				{ path: "/grep-fixtures/broad.md", content: "broad mention exact-hyphen-to**ken-2026ish** here\n" },
			],
		});

		const result = await run(`grep -R exact-hyphen-token-2026 ${test_db_files_mount}/grep-fixtures`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain(
			`Found 2 results under ${test_db_files_mount}/grep-fixtures (exact matches: 1, word-level-only matches: 1; see per-hit notes)`,
		);
		expect(result.stdout).toMatch(/grep-fixtures\/hyphen\.md .+\[contains exact 'exact-hyphen-token-2026'\]/u);
		expect(result.stdout).toMatch(
			/grep-fixtures\/broad\.md .+\[word-level match; chunk does not contain 'exact-hyphen-token-2026'\]/u,
		);
	});

	test("keeps a grep -R page whose hits are only word-level matches", async () => {
		const { run } = await create_bash_runner({
			extraFiles: [{ path: "/grep-fixtures/broad.md", content: "broad mention exact-hyphen-to**ken-2026ish** here\n" }],
		});

		const result = await run(`grep -R exact-hyphen-token-2026 ${test_db_files_mount}/grep-fixtures`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain(
			`Found 1 results under ${test_db_files_mount}/grep-fixtures (exact matches: 0, word-level-only matches: 1; see per-hit notes)`,
		);
		expect(result.stdout).toMatch(
			/grep-fixtures\/broad\.md .+\[word-level match; chunk does not contain 'exact-hyphen-token-2026'\]/u,
		);
	});

	test("greps a single app file (regex by default, -F substring, optional line numbers, -i), guidance otherwise", async () => {
		const { run } = await create_bash_runner();

		// Single app file prints raw matching lines by default, like native grep.
		const hit = await run(`grep unique-token ${test_db_files_mount}/docs/readme.md`);
		expect(hit.metadata.exitCode).toBe(0);
		expect(hit.stdout).toBe("unique-token here\nmore unique-token below\n");

		// Single-file app grep supports regex because it scans one bounded chunk stream.
		const regexHit = await run(`grep 'unique.*below' ${test_db_files_mount}/docs/readme.md`);
		expect(regexHit.metadata.exitCode).toBe(0);
		expect(regexHit.stdout).toBe("more unique-token below\n");

		const invalidRegex = await run(`grep '[' ${test_db_files_mount}/docs/readme.md`);
		expect(invalidRegex.metadata.exitCode).toBe(2);
		expect(invalidRegex.stderr).toContain("invalid regex");

		// -F switches back to fixed-string semantics.
		const fixedMiss = await run(`grep -F 'unique.*below' ${test_db_files_mount}/docs/readme.md`);
		expect(fixedMiss.metadata.exitCode).toBe(1);
		expect(fixedMiss.stdout).toBe("");

		// -n switches to 1-based line numbers.
		const numberedHit = await run(`grep -n unique-token ${test_db_files_mount}/docs/readme.md`);
		expect(numberedHit.metadata.exitCode).toBe(0);
		expect(numberedHit.stdout).toBe("2:unique-token here\n3:more unique-token below\n");

		const dashPattern = await run(`grep -- -token ${test_db_files_mount}/docs/readme.md`);
		expect(dashPattern.metadata.exitCode).toBe(0);
		expect(dashPattern.stdout).toBe("unique-token here\nmore unique-token below\n");

		const piped = await run(`cat ${test_db_files_mount}/docs/readme.md | head -n 20 | grep -n unique-token`);
		expect(piped.metadata.exitCode).toBe(0);
		expect(piped.stdout).toBe("2:unique-token here\n3:more unique-token below\n");

		const pipedRegex = await run(`cat ${test_db_files_mount}/docs/readme.md | grep 'unique.*below'`);
		expect(pipedRegex.metadata.exitCode).toBe(0);
		expect(pipedRegex.stdout).toBe("more unique-token below\n");

		const pipedFixedMiss = await run(`cat ${test_db_files_mount}/docs/readme.md | grep -F 'unique.*below'`);
		expect(pipedFixedMiss.metadata.exitCode).toBe(1);
		expect(pipedFixedMiss.stdout).toBe("");

		// Case-insensitive.
		const ci = await run(`grep -i ALPHA ${test_db_files_mount}/docs/tutorial.md`);
		expect(ci.metadata.exitCode).toBe(0);
		expect(ci.stdout).toBe("alpha\nALPHA\n");

		// No match → exit 1, no output (real grep semantics).
		const none = await run(`grep zzz-nope ${test_db_files_mount}/docs/readme.md`);
		expect(none.metadata.exitCode).toBe(1);
		expect(none.stdout).toBe("");

		// Multiple files → falls back to guidance (we only handle one file).
		const multi = await run(`grep token ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/tutorial.md`);
		expect(multi.metadata.exitCode).toBe(2);
		expect(multi.stdout).toContain("is not supported");

		const unsupportedSingleFileFlag = await run(`grep -o token ${test_db_files_mount}/docs/readme.md`);
		expect(unsupportedSingleFileFlag.metadata.exitCode).toBe(2);
		expect(unsupportedSingleFileFlag.stderr).toContain("unsupported option -o");
		expect(unsupportedSingleFileFlag.stderr).toContain("Supported: grep [-n] [-i] [-F]");

		// -c counts matching lines ("token" is on lines 2 and 3).
		const counted = await run(`grep -c token ${test_db_files_mount}/docs/readme.md`);
		expect(counted.metadata.exitCode).toBe(0);
		expect(counted.stdout).toBe("2\n");

		// Multiple -e patterns (OR semantics we don't reproduce) → guidance, not a silent
		// single-pattern match.
		const multiE = await run(`grep -e token -e other ${test_db_files_mount}/docs/readme.md`);
		expect(multiE.metadata.exitCode).toBe(2);

		// Combined short flags: -in (= -i -n) takes the single-file fast path, case-insensitively.
		const combined = await run(`grep -in ALPHA ${test_db_files_mount}/docs/tutorial.md`);
		expect(combined.metadata.exitCode).toBe(0);
		expect(combined.stdout).toBe("2:alpha\n3:ALPHA\n");

		const fixedCombined = await run(`grep -Fin alpha ${test_db_files_mount}/docs/tutorial.md`);
		expect(fixedCombined.metadata.exitCode).toBe(0);
		expect(fixedCombined.stdout).toBe("2:alpha\n3:ALPHA\n");

		// -iv (= -i -v) inverts: only line 1 lacks "token" (case-insensitively).
		const combinedV = await run(`grep -iv token ${test_db_files_mount}/docs/readme.md`);
		expect(combinedV.metadata.exitCode).toBe(0);
		expect(combinedV.stdout).toBe("# Readme\n");

		// -l prints the file path when it has a match, and exits 1 (no output) when it does not.
		const listed = await run(`grep -l unique-token ${test_db_files_mount}/docs/readme.md`);
		expect(listed.metadata.exitCode).toBe(0);
		expect(listed.stdout).toBe(`${test_db_files_mount}/docs/readme.md\n`);
		const listedNone = await run(`grep -l zzz-nope ${test_db_files_mount}/docs/readme.md`);
		expect(listedNone.metadata.exitCode).toBe(1);
		expect(listedNone.stdout).toBe("");

		// -B N adds leading context. Without -n, both matching and context lines are raw text.
		const before = await run(`grep -B 1 ALPHA ${test_db_files_mount}/docs/tutorial.md`);
		expect(before.metadata.exitCode).toBe(0);
		expect(before.stdout).toBe("alpha\nALPHA\n");

		// With -n, context lines use "-" and selected lines use ":".
		const beforeNumbered = await run(`grep -n -B 1 ALPHA ${test_db_files_mount}/docs/tutorial.md`);
		expect(beforeNumbered.metadata.exitCode).toBe(0);
		expect(beforeNumbered.stdout).toBe("2-alpha\n3:ALPHA\n");

		// -v without context stays native-like: non-contiguous selected lines are printed directly.
		const invertGap = await run(`grep -v alpha ${test_db_files_mount}/docs/tutorial.md`);
		expect(invertGap.metadata.exitCode).toBe(0);
		expect(invertGap.stdout).toBe("zeta\nALPHA\n");

		const pipedInvertGap = await run(`cat ${test_db_files_mount}/docs/tutorial.md | grep -v alpha`);
		expect(pipedInvertGap.metadata.exitCode).toBe(0);
		expect(pipedInvertGap.stdout).toBe("zeta\nALPHA\n");
	});

	test("supports app grep line and slice continuation windows", async () => {
		const latePath = "/docs/late-grep.md";
		const longPath = "/docs/long-line-grep.md";
		const longPrefix = "x".repeat(256 * 1024);
		const { run } = await create_bash_runner({
			extraFiles: [
				{
					path: latePath,
					content: ["first line", "late-window-token", "third line"].join("\n"),
				},
				{
					path: longPath,
					content: `${longPrefix}needle-after-long-prefix\n`,
				},
			],
		});

		const lineWindow = await run(
			`grep --start-line 3 --max-lines 1 unique-token ${test_db_files_mount}/docs/readme.md`,
		);
		expect(lineWindow.metadata.exitCode).toBe(0);
		expect(lineWindow.stdout).toBe("more unique-token below\n");

		const capped = await run(`grep --start-line 1 --max-lines 1 late-window-token ${test_db_files_mount}${latePath}`);
		expect(capped.metadata.exitCode).toBe(1);
		expect(capped.stdout).toBe("");
		expect(capped.stderr).toContain("line scan cap reached");
		expect(capped.stderr).toContain(
			`Next scan: grep --start-line 2 --max-lines 1 late-window-token ${test_db_files_mount}${latePath}`,
		);

		const continued = await run(
			`grep --start-line 2 --max-lines 1 late-window-token ${test_db_files_mount}${latePath}`,
		);
		expect(continued.metadata.exitCode).toBe(0);
		expect(continued.stdout).toBe("late-window-token\n");

		const byteCapped = await run(`grep needle-after-long-prefix ${test_db_files_mount}${longPath}`);
		expect(byteCapped.metadata.exitCode).toBe(1);
		expect(byteCapped.stdout).toBe("");
		expect(byteCapped.stderr).toContain("byte scan cap reached");
		const byteContinuationCommand = byteCapped.stderr.match(
			/Next scan: (grep --start-index 0 --max-chars \d+ needle-after-long-prefix [^\n]+)/u,
		)?.[1];
		expect(byteContinuationCommand?.startsWith("grep --start-index 0 --max-chars ")).toBe(true);
		expect(byteContinuationCommand).toContain(` needle-after-long-prefix ${test_db_files_mount}${longPath}`);

		const slice = await run(
			`grep --start-index ${longPrefix.length - 8} --max-chars 128 needle-after-long-prefix ${test_db_files_mount}${longPath}`,
		);
		expect(slice.metadata.exitCode).toBe(0);
		expect(slice.stdout).toBe(`xxxxxxxxneedle-after-long-prefix\n`);
		expect(slice.stderr).toContain("slice mode scans a text slice");
	});

	test("uses regex for single-file app grep patterns that look like regex", async () => {
		const { run } = await create_bash_runner();

		const anchored = await run(`grep '^# Readme' ${test_db_files_mount}/docs/readme.md`);
		const wildcard = await run(`grep 'unique.*token' ${test_db_files_mount}/docs/readme.md`);
		const fixed = await run(`grep -F '^# Readme' ${test_db_files_mount}/docs/readme.md`);

		expect(anchored.metadata.exitCode).toBe(0);
		expect(anchored.stdout).toBe("# Readme\n");
		expect(anchored.stderr).toBe("");
		expect(wildcard.metadata.exitCode).toBe(0);
		expect(wildcard.stdout).toBe("unique-token here\nmore unique-token below\n");
		expect(fixed.metadata.exitCode).toBe(1);
		expect(fixed.stdout).toBe("");
		expect(fixed.stderr).toBe("");
	});

	test("warns when app grep output is capped", async () => {
		const path = "/docs/capped-grep.md";
		const { run } = await create_bash_runner({
			extraFiles: [
				{
					path,
					content: Array.from({ length: 105 }, (_, index) => `cap-token ${index + 1}`).join("\n"),
				},
			],
		});

		const capped = await run(`grep cap-token ${test_db_files_mount}${path}`);

		expect(capped.metadata.exitCode).toBe(0);
		expect(capped.stdout.split("\n").filter(Boolean)).toHaveLength(100);
		expect(capped.stderr).toContain("match cap reached");
		expect(capped.stderr).toContain("Next scan:");
	});

	test("treats chunk-unavailable app grep as no match", async () => {
		const path = "/docs/large-grep.md";
		const { run } = await create_bash_runner({
			extraFiles: [
				{
					path,
					content: `match-token\n${"filler-line\n".repeat(800)}`,
					brokenChunks: true,
				},
			],
		});
		const shellPath = `${test_db_files_mount}${path}`;

		const match = await run(`grep match-token ${shellPath}`);
		const noMatch = await run(`grep missing-token ${shellPath}`);

		for (const result of [match, noMatch]) {
			expect(result.metadata.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
		}
		expect(noMatch.stdout).toBe("");
	});

	test("uses prefix find and renders app tree pages", async () => {
		const { run } = await create_bash_runner();
		const scopedRunner = await create_bash_runner({ initialCwd: `${test_db_files_mount}/docs` });

		const prefixResult = await run("find --prefix /docs --limit 20 -type f");
		const relativePrefixResult = await scopedRunner.run("find --prefix nested --limit 1");
		const treeResult = await run(`tree ${test_db_files_mount}/docs --limit 2`);

		expect(prefixResult.metadata.exitCode).toBe(0);
		expect(prefixResult.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(prefixResult.stdout).toContain(`${test_db_files_mount}/docs/tutorial.md`);
		expect(relativePrefixResult.metadata.exitCode).toBe(0);
		expect(relativePrefixResult.stdout).toMatch(
			new RegExp(`Next page: find --prefix ${test_db_files_mount}/docs/nested --limit 1 --cursor \\S+`, "u"),
		);
		expect(treeResult.metadata.exitCode).toBe(0);
		expect(treeResult.stdout).toContain(test_db_files_mount + "/docs");
		expect(treeResult.stdout).toContain("|-- nested/");
		expect(treeResult.stdout).toContain("|   |-- deep.md");
		expect(treeResult.stdout).toMatch(
			new RegExp(`Next page: tree ${test_db_files_mount}/docs --limit 2 --cursor \\S+`, "u"),
		);
	});

	test("tree continuation pages remind agents to stop after one requested continuation", async () => {
		const { run } = await create_bash_runner({
			extraFiles: [
				{ path: "/tree-stop/a.md", content: "a\n" },
				{ path: "/tree-stop/b.md", content: "b\n" },
				{ path: "/tree-stop/c.md", content: "c\n" },
			],
		});

		const firstPage = await run(`tree ${test_db_files_mount}/tree-stop --limit 1`);
		const continuation = firstPage.stdout.match(/Next page: (tree .+)/u)?.[1];
		if (continuation == null) {
			throw new Error("expected a tree continuation in the first page stdout");
		}

		const secondPage = await run(continuation);

		expect(secondPage.metadata.exitCode).toBe(0);
		expect(secondPage.stdout).toContain("Next page: tree");
		expect(secondPage.stdout).toContain("if the user asked for exactly one continuation, stop here");
	});

	test("renders exact file tree targets without subtree pagination", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run(`tree ${test_db_files_mount}/docs/readme.md --limit 2`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe(`${test_db_files_mount}/docs/readme.md`);
		expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:list_subtree")).toBe(false);
	});

	test("keeps tree app-only option guidance out of /tmp paths", async () => {
		const { run, runQuery } = await create_bash_runner();

		const nativeJustBashResult = await run(
			"mkdir -p /tmp/tree-tmp && printf hi > /tmp/tree-tmp/a.md && tree -P '*.md' /tmp/tree-tmp",
		);
		const appResult = await run(`tree -P '*.md' ${test_db_files_mount}/docs`);
		const nativeJustBashNextPage = await run("tree --next-page /tmp");
		const appNextPage = await run(`tree --next-page ${test_db_files_mount}/docs`);

		expect(nativeJustBashResult.stderr).not.toContain("/home/cloud-usr/w");
		expect(appResult.metadata.exitCode).toBe(2);
		expect(appResult.stderr).toContain("unsupported option -P");
		expect(appResult.stderr).toContain("/home/cloud-usr/w");
		for (const result of [nativeJustBashNextPage, appNextPage]) {
			expect(result.metadata.exitCode).toBe(2);
			expect(result.stderr).toContain("--next-page is not supported");
			expect(result.stderr).toContain("Copy the exact");
		}
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toHaveLength(0);
	});

	test("supports exact reader commands while keeping unreadable app content out of generic readers", async () => {
		const { run } = await create_bash_runner();

		const result = await run(
			[
				`head -n 1 ${test_db_files_mount}/docs/readme.md`,
				`tail -n +2 ${test_db_files_mount}/docs/readme.md`,
				`wc -c ${test_db_files_mount}/docs/readme.md`,
				`stat -c "%F %n" ${test_db_files_mount}/docs/readme.md`,
			].join(" && "),
		);
		const unreadableHead = await run(`head ${test_db_files_mount}/source.pdf`);
		const unreadableTail = await run(`tail ${test_db_files_mount}/source.pdf`);
		const unreadableWc = await run(`wc ${test_db_files_mount}/source.pdf`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("# Readme");
		expect(result.stdout).toContain("unique-token");
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(result.stdout).toContain("regular file");
		for (const unreadable of [unreadableHead, unreadableTail, unreadableWc]) {
			expect(unreadable.metadata.exitCode).toBe(1);
			expect(unreadable.stdout).toBe("");
			expect(unreadable.stderr).toContain("Bash can read editable text files only");
			expect(unreadable.stderr).toContain(`${test_db_files_mount}/source.pdf.md`);
		}
	});

	test("supports stat long format options and dash-leading operands after --", async () => {
		const { run } = await create_bash_runner();
		const readmePath = `${test_db_files_mount}/docs/readme.md`;

		const shortFormat = await run(`stat -c "%F %n" ${readmePath}`);
		const longFormat = await run(`stat --format "%F %n" ${readmePath}`);
		const equalsFormat = await run(`stat --format=%F ${readmePath}`);
		const literalPercent = await run(`stat -c "%% %F" ${readmePath}`);
		const dashLeadingTmp = await run("printf hi > /tmp/-dash-stat && stat -- /tmp/-dash-stat");

		expect(shortFormat.metadata.exitCode).toBe(0);
		expect(longFormat.metadata.exitCode).toBe(0);
		expect(equalsFormat.metadata.exitCode).toBe(0);
		expect(literalPercent.metadata.exitCode).toBe(0);
		expect(dashLeadingTmp.metadata.exitCode).toBe(0);
		expect(longFormat.stdout).toBe(shortFormat.stdout);
		expect(equalsFormat.stdout).toBe("regular file\n");
		expect(literalPercent.stdout).toBe("% regular file\n");
		expect(dashLeadingTmp.stdout).toContain("File: /tmp/-dash-stat");
		expect(dashLeadingTmp.stdout).not.toContain("app files track");
	});

	test("warns about unsupported app stat format tokens without changing stdout", async () => {
		const { run } = await create_bash_runner();
		const readmePath = `${test_db_files_mount}/docs/readme.md`;

		const appResult = await run(`stat -c "%i %b %s %%" ${readmePath}`);
		const tmpResult = await run('printf hi > /tmp/stat-format.txt && stat -c "%i %b %s %%" /tmp/stat-format.txt');

		expect(appResult.metadata.exitCode).toBe(0);
		expect(appResult.stdout).toContain("%i %b ");
		expect(appResult.stdout).toContain(" %\n");
		expect(appResult.stderr).toContain("app files support only");
		expect(appResult.stderr).toContain("inode, blocks, device, and filesystem fields are not tracked");
		expect(tmpResult.metadata.exitCode).toBe(0);
		expect(tmpResult.stderr).not.toContain("app files support only");
	});

	test("does not recursively expand stat format tokens introduced by file names", async () => {
		const { run } = await create_bash_runner({
			extraFiles: [{ path: "/docs/%s-%F.md", content: "token name\n" }],
		});
		const tokenPath = `${test_db_files_mount}/docs/%s-%F.md`;

		const result = await run(`stat -c "%n" '${tokenPath}'`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe(`${tokenPath}\n`);
	});

	test("keeps stat glob guidance scoped to app paths", async () => {
		const { run } = await create_bash_runner();

		const tmpGlob = await run("printf hi > '/tmp/star*.txt' && stat '/tmp/star*.txt'");
		const appGlob = await run(`stat '${test_db_files_mount}/docs/*.md'`);

		expect(tmpGlob.metadata.exitCode).toBe(0);
		expect(tmpGlob.stdout).toContain("File: /tmp/star*.txt");
		expect(tmpGlob.stderr).not.toContain("app file glob patterns are not supported");
		expect(appGlob.metadata.exitCode).not.toBe(0);
		expect(appGlob.stderr).toContain("app file glob patterns are not supported");
		expect(appGlob.stderr).toContain("find");
	});

	test("renders app stat metadata without fake block counts", async () => {
		const { run } = await create_bash_runner();

		const result = await run(`stat ${test_db_files_mount}/docs/readme.md`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("  Size: ");
		expect(result.stdout).not.toContain("Blocks:");
		expect(result.stdout).toContain("not POSIX permissions, owner, group, inode, or blocks");
	});

	test("stat reports non-editable asset size through the shared size helper", async () => {
		const { run, runQuery } = await create_bash_runner();
		const sourcePath = `${test_db_files_mount}/source.pdf`;
		runQuery.mockClear();

		const result = await run(`stat -c %s ${sourcePath}`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe("4096\n");
		expect(runQuery.mock.calls.filter(([ref]) => function_name_of(ref) === "r2:get_asset_by_id")).toHaveLength(1);
	});

	test("stat reports unsaved edit size before the committed asset size", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/draft-stat.md", content: "tiny base\n", withRealYjsSnapshot: true }],
		});
		const draftNodeId = await get_seeded_node_id(runner, "/draft-stat.md");
		await upsert_pending_update_for_test(runner, {
			target: { kind: "saved", id: draftNodeId },
			unstagedText: Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join("\n\n"),
		});
		const pendingUpdate = await runner.t.query(internal.files_pending_updates.get_by_file_node, {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId: runner.seeded.userId,
			fileNodeId: draftNodeId,
		});
		if (pendingUpdate?.size == null) {
			throw new Error("expected pending update size to be set for /draft-stat.md");
		}
		const draftPath = `${test_db_files_mount}/draft-stat.md`;
		runner.runQuery.mockClear();

		const result = await runner.run(`stat -c %s ${draftPath}`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe(`${pendingUpdate.size}\n`);
		expect(runner.runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "r2:get_asset_by_id")).toBe(false);
	});

	test("stat reports the committed size after a pure move", async () => {
		const runner = await create_bash_runner({ extraFiles: [big_md_file] });
		const bigNode = await get_seeded_node(runner, "/big.md");
		if (bigNode.assetId == null) {
			throw new Error("expected /big.md to have a committed asset");
		}
		const asset = await runner.t.query(internal.r2.get_asset_by_id, {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			assetId: bigNode.assetId,
		});
		if (asset?.size == null) {
			throw new Error("expected a committed asset size for /big.md");
		}
		expect(asset.size).toBeGreaterThan(bash_READ_INLINE_MAX_BYTES);

		const moved = await runner.run(`mv ${test_db_files_mount}/big.md ${test_db_files_mount}/renamed-big.md`);
		expect(moved.metadata.exitCode).toBe(0);

		// The move-only pending update doc stores size 0; stat must report the committed asset size, not 0.
		const result = await runner.run(`stat -c %s ${test_db_files_mount}/renamed-big.md`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe(`${asset.size}\n`);
	});

	test("rejects stat format options without a value", async () => {
		const { run } = await create_bash_runner();

		const shortFormat = await run("stat -c");
		const longFormat = await run("stat --format");

		expect(shortFormat.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(longFormat.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(shortFormat.stderr).toContain("stat: -c requires a value");
		expect(longFormat.stderr).toContain("stat: --format requires a value");
		expect(shortFormat.stderr).toContain("Usage: stat [-c FORMAT] [--] FILE...");
		expect(longFormat.stderr).toContain("Usage: stat [-c FORMAT] [--] FILE...");
	});

	describe("shells", () => {
		const transcript_of = async (runner: Awaited<ReturnType<typeof create_bash_runner>>, name: string) => {
			const shell = await get_shell(runner.t, runner.threadId, name);
			if (!shell) throw new Error(`Expected shell ${name}`);
			const entries = await runner.t.run((ctx) =>
				ctx.db
					.query("ai_chat_bash_shell_transcripts")
					.withIndex("by_shell_seq", (q) => q.eq("shellId", shell._id))
					.collect(),
			);
			return { shell, entries };
		};

		const transcript_reads = (runner: Awaited<ReturnType<typeof create_bash_runner>>) =>
			runner.runQuery.mock.calls.filter(([ref]) => function_name_of(ref) === "ai_chat_files:read_shell_transcript")
				.length;

		test("creates a named shell and runs the command in one call", async () => {
			const runner = await create_bash_runner();
			const result = await runner.run("pwd", undefined, "work");
			expect(result.metadata.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toBe(`${test_db_files_mount}\n`);
			const shells = await runner.t.run((ctx) =>
				ctx.db
					.query("ai_chat_bash_shells")
					.withIndex("by_thread_name", (q) => q.eq("threadId", runner.threadId))
					.collect(),
			);
			expect(shells.map((shell) => shell.name)).toEqual(["work"]);
		});

		test("refuses the 11th shell and names the existing ones", async () => {
			const runner = await create_bash_runner();
			for (let i = 0; i < 10; i++) {
				expect((await runner.run("true", undefined, `s${i}`)).metadata.exitCode).toBe(0);
			}
			await expect(runner.run("true", undefined, "s10")).rejects.toThrow(
				"This thread already has 10 shells (s0, s1, s2, s3, s4, s5, s6, s7, s8, s9). Reuse one of them.",
			);
			const shells = await runner.t.run((ctx) =>
				ctx.db
					.query("ai_chat_bash_shells")
					.withIndex("by_thread_name", (q) => q.eq("threadId", runner.threadId))
					.collect(),
			);
			expect(shells).toHaveLength(10);
		});

		test("keeps a variable for the next call in the same shell only", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("x=5")).metadata.exitCode).toBe(0);
			expect((await runner.run("echo $x")).stdout).toBe("5\n");
			expect((await runner.run("echo $x", undefined, "other")).stdout).toBe("\n");
		});

		test("keeps the saved state when the call leaves cwd inside /tmp", async () => {
			const runner = await create_bash_runner();

			// /tmp is per-thread scratch with its own caps, so a cwd left there is the case most
			// likely to lose the rest of the shell state on the way back.
			expect(
				(await runner.run("kept=yes; fruits=(apple pear); mkdir -p /tmp/scratch-cwd; cd /tmp/scratch-cwd")).metadata
					.exitCode,
			).toBe(0);

			const read = await runner.run('printf "%s|%s|%s\\n" "$kept" "${#fruits[@]}" "$(pwd)"');
			expect(read.stderr).toBe("");
			expect(read.stdout).toBe("yes|2|/tmp/scratch-cwd\n");
		});

		test("keeps an indexed and an associative array for the next call", async () => {
			const runner = await create_bash_runner();

			// Arrays live outside env in the engine state, so they need their own place in the saved
			// snapshot. Without it a later call sees the names as unset.
			expect((await runner.run("fruits=(apple pear plum); declare -A ages; ages[ana]=31")).metadata.exitCode).toBe(0);

			const read = await runner.run('printf "%s|%s|%s\\n" "${fruits[1]}" "${#fruits[@]}" "${ages[ana]}"');
			expect(read.stderr).toBe("");
			expect(read.stdout).toBe("pear|3|31\n");

			// A different shell in the same thread starts without them.
			expect((await runner.run('printf "%s\\n" "${#fruits[@]}"', undefined, "other")).stdout).toBe("0\n");
		});

		test("still saves the variable when the call ends with exit 0", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("x=5; exit 0")).metadata.exitCode).toBe(0);
			expect((await runner.run("echo $x")).stdout).toBe("5\n");
		});

		test("keeps a function for the next call", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("hi() { echo hi from $1; }")).metadata.exitCode).toBe(0);
			const called = await runner.run("hi later");
			expect(called.metadata.exitCode, called.stderr).toBe(0);
			expect(called.stdout).toBe("hi from later\n");
		});

		test("keeps set -e for the next call", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("set -e")).metadata.exitCode).toBe(0);
			const stopped = await runner.run("false; echo after");
			expect(stopped.metadata.exitCode).toBe(1);
			expect(stopped.stdout).toBe("");
		});

		test("an Ask-mode call still saves the snapshot into the shared shell", async () => {
			const runner = await create_bash_runner({ allowDbFilesMkdir: false });
			expect((await runner.run("x=5; f() { echo fn; }")).metadata.exitCode).toBe(0);
			expect((await runner.run("echo $x; f")).stdout).toBe("5\nfn\n");
		});

		test("cd in one shell does not move another", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("cd docs", undefined, "a")).metadata.nextCwd).toBe(`${test_db_files_mount}/docs`);
			expect((await runner.run("pwd", undefined, "b")).stdout).toBe(`${test_db_files_mount}\n`);
			expect((await runner.run("pwd", undefined, "a")).stdout).toBe(`${test_db_files_mount}/docs\n`);
		});

		test("warns about a file descriptor left open and does not restore it", async () => {
			const runner = await create_bash_runner();
			const opened = await runner.run("exec 3>/tmp/fd.txt; echo hi");
			expect(opened.metadata.exitCode).toBe(0);
			expect(opened.stderr).toContain("bash: file descriptor 3 was closed\n");
			const reused = await runner.run("echo again >&3");
			expect(reused.metadata.exitCode).not.toBe(0);
			expect(reused.stderr).toMatch(/bad file descriptor/i);
		});

		test("does not save a snapshot over 128 KiB and keeps the previous state", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("x=1")).metadata.exitCode).toBe(0);
			const grown = await runner.run("big=a; for i in $(seq 18); do big=$big$big; done; echo ${#big}");
			expect(grown.metadata.exitCode, grown.stderr).toBe(0);
			expect(grown.stdout).toBe("262144\n");
			expect(grown.stderr).toContain(
				"bash: the shell state is larger than 128 KiB and was not saved; the previous state stays.\n",
			);
			expect((await runner.run("echo ${#big} $x")).stdout).toBe("0 1\n");
		});

		test("appends one transcript entry per call, in order, with the header", async () => {
			const runner = await create_bash_runner();
			await runner.run("echo one");
			await runner.run("cd docs; echo two; echo err >&2");
			const { shell, entries } = await transcript_of(runner, "default");
			expect(entries.map((entry) => entry.seq)).toEqual([0, 1]);
			expect(entries[0]!.text).toMatch(
				new RegExp(`^\\$ \\[\\d{4}-\\d\\d-\\d\\dT[^\\]]+Z\\] \\(exit 0\\) ${test_db_files_mount}\necho one\none\n\n$`),
			);
			expect(entries[1]!.text).toMatch(
				new RegExp(
					`^\\$ \\[[^\\]]+\\] \\(exit 0\\) ${test_db_files_mount}\ncd docs; echo two; echo err >&2\ntwo\n\nerr\n$`,
				),
			);
			expect(shell).toMatchObject({
				transcriptEntries: 2,
				transcriptSeq: 2,
				transcriptBytes: entries[0]!.bytes + entries[1]!.bytes,
			});
		});

		test("output with half a character reaches the result and the transcript as U+FFFD", async () => {
			const runner = await create_bash_runner();
			// A character outside the basic range is two code units, and `printf` can write one of them
			// on its own. Convex refuses a mutation argument that holds such a string, so the whole call
			// used to fail with "Invalid arguments provided" and the model saw no output at all.
			const result = await runner.run(`printf 'A\\ud83cB'`);
			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toBe("A�B");
			const { entries } = await transcript_of(runner, "default");
			expect(entries[0]!.text).toContain("A�B");
			expect(entries[0]!.text.isWellFormed()).toBe(true);
		});

		test("mounts the transcripts read-only under /shells and reads one only when asked", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("echo hi", undefined, "a")).metadata.exitCode).toBe(0);
			const listed = await runner.run("ls /shells", undefined, "b");
			expect(listed.metadata.exitCode, listed.stderr).toBe(0);
			expect(listed.stdout).toBe("a\nb\n");
			expect(transcript_reads(runner)).toBe(0);

			const detailed = await runner.run("ls -l /shells/a", undefined, "b");
			expect(detailed.metadata.exitCode, detailed.stderr).toBe(0);
			expect(detailed.stdout).toContain("transcript");
			expect(transcript_reads(runner)).toBe(1);

			const read = await runner.run("cat /shells/a/transcript", undefined, "b");
			expect(read.metadata.exitCode, read.stderr).toBe(0);
			expect(read.stdout).toContain("echo hi\nhi\n");
			expect(transcript_reads(runner)).toBe(2);

			const written = await runner.run("echo x > /shells/a/transcript", undefined, "b");
			expect(written.metadata.exitCode).not.toBe(0);
			expect(written.stderr).toMatch(/read-only/i);
			expect((await runner.run("rm /shells/a/transcript", undefined, "b")).metadata.exitCode).not.toBe(0);
			expect((await transcript_of(runner, "a")).entries).toHaveLength(1);
		});

		test("persists cd /shells/<name>", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("true", undefined, "a")).metadata.exitCode).toBe(0);
			const entered = await runner.run("cd /shells/a");
			expect(entered.metadata.exitCode, entered.stderr).toBe(0);
			expect(entered.metadata.nextCwd).toBe("/shells/a");
			expect(entered.stderr).toBe("");
			expect((await runner.run("pwd")).stdout).toBe("/shells/a\n");
		});

		test("a replayed call with another shell is refused, and a job: id never reaches the lookup", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("pwd", "same-call", "a")).metadata.exitCode).toBe(0);
			await expect(runner.run("pwd", "same-call", "b")).rejects.toThrow(
				"This Bash call already has a different command.",
			);
			await expect(runner.run("pwd", "job:x:1")).rejects.toThrow("Invalid Bash call identity.");
		});
	});

	describe("jobs", () => {
		const activity_of = async (runner: Awaited<ReturnType<typeof create_bash_runner>>, jobNumber: number) => {
			const row = await job_row(runner, jobNumber);
			return await runner.t.run((ctx) =>
				ctx.db
					.query("activities")
					.withIndex("by_source_id", (q) => q.eq("source.id", row._id))
					.unique(),
			);
		};

		// The pool is mocked, so a job runs only when the test runs its worker.
		const run_job = async (runner: Awaited<ReturnType<typeof create_bash_runner>>, jobNumber: number) => {
			const row = await job_row(runner, jobNumber);
			await bash_run_job(runner.ctx, { invocationId: row._id });
			return await job_row(runner, jobNumber);
		};

		const mutation_calls = (runner: Awaited<ReturnType<typeof create_bash_runner>>, name: string) =>
			runner.runMutation.mock.calls.filter(([ref]) => function_name_of(ref) === name).length;

		test("starts a job on stderr with $? 0, runs it with the shell state and stores its output", async () => {
			const runner = await create_bash_runner();
			const launched = await runner.run('x=7; echo hi $x & echo "rc=$? job=$!"');
			expect(launched.metadata.exitCode, launched.stderr).toBe(0);
			expect(launched.stdout).toBe("rc=0 job=1\n");
			expect(launched.stderr).toBe(
				"bash: started job 1 in shell default. Follow it with `jobs`, or in the Notifications panel.\n",
			);
			expect((await runner.run("echo $!")).stdout).toBe("0\n");

			const queued = await job_row(runner, 1);
			expect(queued.job).toMatchObject({
				jobNumber: 1,
				script: "echo hi $x",
				startCwd: test_db_files_mount,
				startCwdTarget: null,
				allowDbFilesMkdir: true,
				workId: "work_bash_test_billing_event",
			});
			expect(await activity_of(runner, 1)).toMatchObject({ status: "queued", feedVisible: true });

			const finished = await run_job(runner, 1);
			expect(finished.status).toBe("finished");
			expect(finished.result).toMatchObject({ stdout: "hi 7\n", stderr: "", metadata: { exitCode: 0 } });
			expect(finished.job).toMatchObject({ script: null, shellState: null });
			expect(await activity_of(runner, 1)).toMatchObject({ status: "succeeded" });

			const entries = await runner.t.run(async (ctx) =>
				(await ctx.db.query("ai_chat_bash_shell_transcripts").collect()).sort((a, b) => a.seq - b.seq),
			);
			// The launch entry lands during the call, before the call's own entry.
			expect(entries.map((entry) => entry.text)).toEqual([
				expect.stringMatching(/^\[[^\]]+\] job 1 started in shell default: echo hi \$x$/),
				expect.stringMatching(/^\$ \[[^\]]+\] \(exit 0\) /),
				expect.stringMatching(/^\$ \[[^\]]+\] \(exit 0\) /),
				expect.stringMatching(
					/^\$ \[[^\]]+\] job 1 finished \(exit 0\) in shell default, started \d\d:\d\d:\d\d\necho hi \$x\nhi 7\n\n$/,
				),
			]);
		});

		test("jobs, jobs -a and jobs -o read the job back", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("echo one &")).metadata.exitCode).toBe(0);
			expect((await runner.run("{ echo two >&2; false; } &")).metadata.exitCode).toBe(0);

			const live = await runner.run("jobs");
			expect(live.metadata.exitCode).toBe(3);
			expect(live.stdout).toBe("[2] queued    default  { echo two >&2; false; }\n[1] queued    default  echo one\n");
			expect((await runner.run("jobs -o 1")).metadata.exitCode).toBe(3);
			expect((await runner.run("jobs -o 9")).stderr).toContain("bash: jobs: no such job 9\n");

			await run_job(runner, 1);
			await run_job(runner, 2);
			const all = await runner.run("jobs -a");
			expect(all.metadata.exitCode, all.stderr).toBe(0);
			expect(all.stdout).toBe("[2] failed    default  { echo two >&2; false; }\n[1] done      default  echo one\n");
			expect((await runner.run("jobs")).stdout).toBe("");

			const output = await runner.run("jobs -o 2");
			expect(output.metadata.exitCode).toBe(0);
			expect(output.stdout).toBe("");
			expect(output.stderr).toBe("two\n[job 2 exit 1]\n");

			const row = await job_row(runner, 1);
			await runner.t.run((ctx) => ctx.db.patch("ai_chat_bash_invocations", row._id, { result: undefined }));
			const stripped = await runner.run("jobs -o 1");
			expect(stripped.metadata.exitCode).toBe(1);
			expect(stripped.stdout).toBe("");
			// The row lost its result, so the message answers from the Activity's own outcome instead.
			expect(stripped.stderr).toBe("bash: jobs: job 1 done and stored no output; read the shell transcript\n");
		});

		test("jobs -o spends no read budget on a job that is still live", async () => {
			const runner = await create_bash_runner();
			// The budget check sits after the live check, so reading a live job three times in the call
			// that launched it must not spend the two reads the call may make.
			const read = await runner.run("sleep 60 & jobs -o 1; jobs -o 1; jobs -o 1; echo done");
			expect(read.metadata.exitCode).toBe(0);
			expect(read.stdout).toBe("done\n");
			// The pool is mocked, so job 1 never starts and each read prints only its status marker.
			expect(read.stderr).toBe(
				"bash: started job 1 in shell default. Follow it with `jobs`, or in the Notifications panel.\n" +
					"[job 1 queued]\n[job 1 queued]\n[job 1 queued]\n",
			);
		});

		test("jobs -o still prints a live job's head after the row's deadline passes", async () => {
			const runner = await create_bash_runner();
			// The pool is mocked, so job 1 stays queued. Give it a flushed head and put its deadline in
			// the past: the invocation row then calls itself interrupted, which happens minutes before the
			// watchdog settles the job. `jobs` and `wait` read the Activity, so this command must agree
			// with them instead of calling the job ended and dropping the head.
			expect((await runner.run("sleep 60 &")).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			if (!row.job) throw new Error("Expected the job row");
			const job = row.job;
			await runner.t.run((ctx) =>
				ctx.db.patch("ai_chat_bash_invocations", row._id, {
					deadlineAt: Date.now() - 1,
					job: {
						...job,
						liveOutput: { stdout: "half\n", stderr: "", stdoutTruncated: false, stderrTruncated: false },
					},
				}),
			);
			const read = await runner.run("jobs -o 1");
			expect(read.metadata.exitCode).toBe(3);
			expect(read.stdout).toBe("half\n");
			expect(read.stderr).toBe("[job 1 queued]\n");
		});

		test("jobs -o and wait report the same code for a job that stored a late result", async () => {
			const runner = await create_bash_runner();
			// The watchdog settles a job at its deadline while a slow worker is still storing the result
			// of a script that finished on its own. The job then holds a `timed_out` Activity and a
			// stored exit code of 0. `jobs -a` and the note say "timed out", so both commands must too.
			expect((await runner.run("echo late &")).metadata.exitCode).toBe(0);
			expect((await run_job(runner, 1)).result).toMatchObject({ metadata: { exitCode: 0 } });
			const activity = await activity_of(runner, 1);
			if (!activity) throw new Error("Expected the job Activity");
			await runner.t.run((ctx) => ctx.db.patch("activities", activity._id, { status: "timed_out" }));

			const read = await runner.run("jobs -o 1");
			expect(read.metadata.exitCode).toBe(0);
			expect(read.stdout).toBe("late\n");
			expect(read.stderr.endsWith("[job 1 exit 124]\n")).toBe(true);
			expect((await runner.run("wait 1")).metadata.exitCode).toBe(124);
		});

		test("another member's jobs stay out of this member's list", async () => {
			const owner = await create_bash_runner();
			expect((await owner.run("sleep 60 &")).metadata.exitCode).toBe(0);
			const member = await owner.t.run(async (ctx) => {
				const userId = await ctx.db.insert("users", { clerkUserId: "jobs-list-member" });
				await test_mocks_fill_db_with.plan(ctx, { userId, plan: "Pay As You Go" });
				const membershipId = await ctx.db.insert("organizations_workspaces_users", {
					organizationId: owner.seeded.organizationId,
					workspaceId: owner.seeded.workspaceId,
					userId,
					active: true,
					updatedAt: Date.now(),
				});
				await access_control_db_ensure_role_assignment(ctx, {
					organizationId: owner.seeded.organizationId,
					workspaceId: owner.seeded.workspaceId,
					userId,
					role: "member",
					now: Date.now(),
				});
				return { userId, membershipId };
			});
			// The job index carries the user as well as the thread, so a second member on the same
			// thread sees none of the first member's jobs and cannot name one either.
			const runner = await create_bash_runner({
				threadId: owner.threadId,
				shared: { t: owner.t, seeded: { ...owner.seeded, ...member } },
			});
			const listed = await runner.run("jobs -a");
			expect(listed.metadata.exitCode, listed.stderr).toBe(0);
			expect(listed.stdout).toBe("");
			expect((await runner.run("kill 1")).stderr).toBe("bash: kill: no such job 1\n");
			expect((await runner.run("jobs -o 1")).stderr).toBe("bash: jobs: no such job 1\n");
			expect((await runner.run("wait 1")).stderr).toBe("bash: wait: 1: no such job\n");
		});

		test("jobs keeps a space after the widest shell name", async () => {
			const runner = await create_bash_runner();
			// A shell name may be 32 characters. Padding the column to 9 would add nothing at that
			// width, so the name would run straight into the script.
			const widest = "a".repeat(32);
			expect((await runner.run("echo one &", "bash-widest", widest)).metadata.exitCode).toBe(0);
			expect((await runner.run("jobs", "bash-widest-list", widest)).stdout).toBe(`[1] queued    ${widest} echo one\n`);
		});

		test("jobs -o reads one 32k page per stream and refuses a third read in one call", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("seq 1 10000 &")).metadata.exitCode).toBe(0);
			await run_job(runner, 1);
			const read = await runner.run("jobs -o 1; jobs -o 1; jobs -o 1");
			expect(read.metadata.exitCode).toBe(1);
			expect(read.stdout.startsWith("1\n2\n3\n")).toBe(true);
			expect(read.stdout).toContain("\n[truncated]\n");
			expect(read.stderr).toBe(
				"bash: job 1 done. Output: /shells/default/transcript\n[job 1 exit 0]\n[job 1 exit 0]\nbash: jobs: this call already read job output twice; read the shell transcript\n",
			);
		});

		test("jobs -o shows the output a running job flushed so far, with exit 3", async () => {
			const runner = await create_bash_runner();
			// A long `sleep $t` runs inline and keeps the worker busy. A literal `sleep 60` would pause the job
			// instead (see the pause tests below). The tests below use the same form for the same reason.
			expect((await runner.run("{ echo first; echo warn >&2; t=60; sleep $t; echo last; } &")).metadata.exitCode).toBe(
				0,
			);
			const row = await job_row(runner, 1);
			vi.useFakeTimers();
			try {
				const worker = bash_run_job(runner.ctx, { invocationId: row._id });
				// Before the first poll tick nothing is flushed, so the read costs nothing and prints
				// only the status marker.
				await vi.advanceTimersByTimeAsync(1_000);
				const early = await runner.run("jobs -o 1");
				expect(early.metadata.exitCode).toBe(3);
				expect(early.stdout).toBe("");
				expect(early.stderr).toBe("[job 1 running]\n");

				// The tick flushes the head; the mutation runs off the timer, so wait for the row.
				await vi.advanceTimersByTimeAsync(5_000);
				await vi.waitFor(async () => expect((await job_row(runner, 1)).job?.liveOutput).toBeDefined());
				expect((await job_row(runner, 1)).job?.liveOutput).toEqual({
					stdout: "first\n",
					stderr: "warn\n",
					stdoutTruncated: false,
					stderrTruncated: false,
				});
				const partial = await runner.run("jobs -o 1");
				expect(partial.metadata.exitCode).toBe(3);
				expect(partial.stdout).toBe("first\n");
				expect(partial.stderr).toBe("warn\n[job 1 running]\n");

				// The job's `sleep` runs on the real clock (see the permission test below), so end the
				// job with a Stop instead of waiting for it.
				expect((await runner.run("kill 1")).metadata.exitCode).toBe(0);
				await vi.advanceTimersByTimeAsync(5_000);
				await worker;
			} finally {
				vi.useRealTimers();
			}
			// The finish drops the head; the result and the transcript carry the output.
			const finished = await job_row(runner, 1);
			expect(finished.job?.liveOutput).toBeUndefined();
			expect(finished.result).toMatchObject({ stdout: "first\n", metadata: { exitCode: 143 } });
			const done = await runner.run("jobs -o 1");
			expect(done.metadata.exitCode).toBe(0);
			expect(done.stdout).toBe("first\n");
			expect(done.stderr.startsWith("bash: job 1 stopped. Output: /shells/default/transcript\nwarn\n")).toBe(true);
			expect(done.stderr.endsWith("[job 1 exit 143]\n")).toBe(true);
		});

		test("the head cut drops half a character instead of storing it", async () => {
			const runner = await create_bash_runner();
			// The engine hands over each statement's output on its own, so a character whose two halves
			// come from two statements is cut where the head fills up. Convex refuses a mutation
			// argument that holds half a character, so the flush would fail for the rest of the job.
			const script = `{ awk 'BEGIN{for(i=0;i<32767;i++)printf "x"}'; printf '\\ud83c'; printf '\\udf89'; sleep 30; }`;
			expect((await runner.run(`${script} &`)).metadata.exitCode).toBe(0);
			const paused = await run_job(runner, 1);
			const head = paused.job?.liveOutput?.stdout ?? "";
			expect(head.isWellFormed()).toBe(true);
			// The cut backs off to the last whole character, so it keeps 32767 units, not 32768 with a
			// replacement character in the last slot.
			expect(head.length).toBe(32_767);
			expect(head.endsWith("x")).toBe(true);
			expect(paused.job?.liveOutput?.stdoutTruncated).toBe(true);
		});

		test("a head the script itself left half a character in is stored with U+FFFD", async () => {
			const runner = await create_bash_runner();
			// No cut is involved here: the script prints one half of a character. Convex refuses to
			// store it, so the flush and the pause repair the head before they hand it over.
			expect((await runner.run(`{ printf 'A\\ud83cB'; sleep 30; } &`)).metadata.exitCode).toBe(0);
			const paused = await run_job(runner, 1);
			expect(paused.job?.liveOutput?.stdout).toBe("A�B");
		});

		test("prints the finished-job note once, on the next fresh call only", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("true", "before")).metadata.exitCode).toBe(0);
			expect((await runner.run("echo bg &")).metadata.exitCode).toBe(0);
			await run_job(runner, 1);
			const rejoined = await runner.run("true", "before");
			expect(rejoined.stderr).toBe("");
			const noted = await runner.run("echo fg");
			expect(noted.stdout).toBe("fg\n");
			expect(noted.stderr).toBe("bash: job 1 done. Output: /shells/default/transcript\n");
			expect((await runner.run("true")).stderr).toBe("");
		});

		test("prints the finished-job note on a fresh call after losing the begin reply", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("echo bg &")).metadata.exitCode).toBe(0);
			await run_job(runner, 1);

			const mutate = runner.runMutation.getMockImplementation()!;
			let lostReply = false;
			runner.runMutation.mockImplementation(async (ref, args) => {
				const result = await mutate(ref, args);
				if (!lostReply && function_name_of(ref) === "ai_chat_files:begin_bash_invocation") {
					lostReply = true;
					throw new Error("Lost begin reply");
				}
				return result;
			});
			const lost = await runner.run("echo lost", "lost-begin");
			expect(lost.metadata.exitCode).toBe(3);
			expect(lost.stdout).toBe("");
			expect(lost.stderr).not.toContain("bash: job 1 done");

		const second = await runner.run("echo fresh");
		expect(second.stdout).toBe("fresh\n");
		expect(second.stderr).toBe("bash: job 1 done. Output: /shells/default/transcript\n");
		expect((await runner.run("true")).stderr).toBe("");
	});

	test("prints the finished-job note on a fresh call after losing the finish reply", async () => {
		const runner = await create_bash_runner();
		expect((await runner.run("echo bg &")).metadata.exitCode).toBe(0);
		await run_job(runner, 1);
		vi.setSystemTime(Date.now() + 1000);

		// The shell save lands but the finish never does, so the notes printed into the lost
		// result never reach the agent. The cursor must stay put and the notes must print again.
		const mutate = runner.runMutation.getMockImplementation()!;
		let lostReply = false;
		runner.runMutation.mockImplementation(async (ref, args) => {
			if (!lostReply && function_name_of(ref) === "ai_chat_files:finish_bash_invocation") {
				lostReply = true;
				throw new Error("Lost finish reply");
			}
			return await mutate(ref, args);
		});
		const lost = await runner.run("echo lost", "lost-finish").catch((error: unknown) => error);
		expect(lost).toBeInstanceOf(Error);

		const second = await runner.run("echo fresh");
		expect(second.stdout).toBe("fresh\n");
		expect(second.stderr).toBe("bash: job 1 done. Output: /shells/default/transcript\n");
		expect((await runner.run("true")).stderr).toBe("");
	});

	test("a job cannot change its shell and starts in the live cwd of the &", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("cd docs; { x=1; cd nested; pwd; } & cd ..")).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			expect(row.job?.startCwd).toBe(`${test_db_files_mount}/docs`);
			expect(row.job?.startCwdTarget).toMatchObject({ kind: "saved" });
			const finished = await run_job(runner, 1);
			expect(finished.result?.stdout).toBe(`${test_db_files_mount}/docs/nested\n`);
			expect((await runner.run("pwd; echo x=$x")).stdout).toBe(`${test_db_files_mount}\nx=\n`);
		});

		test("refuses the 5th live job across the workspace and stops querying after 3 refusals", async () => {
			const runner = await create_bash_runner();
			for (let n = 1; n <= 4; n++) expect((await runner.run("sleep 1 &")).metadata.exitCode).toBe(0);
			const refused = await runner.run("sleep 1 & echo rc=$?");
			expect(refused.stdout).toBe("rc=1\n");
			expect(refused.stderr).toBe(
				"bash: cannot start a job: 4 jobs are already active across your workspace (queued, running or stopping). Some may be in another chat, where `jobs` and `wait` cannot name them. Wait for one of this chat's jobs, or start more in a later call.\n",
			);
			const before = mutation_calls(runner, "ai_chat_files:start_bash_job");
			const many = await runner.run("true & true & true & true & true &");
			expect(mutation_calls(runner, "ai_chat_files:start_bash_job") - before).toBe(3);
			expect(many.stderr).toContain("3 launches in a row were refused in this call");
			expect((await runner.run("set -e; true & echo after")).stdout).toBe("");
		});

		test("a launch that succeeds lets the call be refused three more times", async () => {
			const runner = await create_bash_runner();
			// A script over 64 KiB is refused every time, whatever the live jobs are, so one call can
			// mix refusals with a launch that works. Two refusals, a success, two more refusals: the
			// count only ever reaches two in a row, so the sixth launch must still ask the door.
			const tooBig = `true '${"a".repeat(66_000)}' &`;
			const before = mutation_calls(runner, "ai_chat_files:start_bash_job");
			const mixed = await runner.run(`${tooBig} ${tooBig} true & ${tooBig} ${tooBig} true & echo rc=$?; jobs -a`);
			expect(mutation_calls(runner, "ai_chat_files:start_bash_job") - before).toBe(6);
			expect(mixed.stdout).toBe("rc=0\n[2] queued    default  true\n[1] queued    default  true\n");
			expect(mixed.stderr).toContain("bash: started job 2 in shell default");
			expect(mixed.stderr).not.toContain("in a row were refused");
		});

		test("a wait for a job that had already ended leaves the local block in place", async () => {
			const runner = await create_bash_runner();
			// Job 1 ended in an earlier call, so the cap was already not blocking this call while
			// these launches were refused, and this wait resets nothing. Without that rule
			// `true & wait 1` in a loop asks the door on every turn: `&` costs no command budget,
			// so this count is what stops that flat run.
			expect((await runner.run("echo one &")).metadata.exitCode).toBe(0);
			await run_job(runner, 1);
			const tooBig = `true '${"a".repeat(66_000)}' &`;
			const before = mutation_calls(runner, "ai_chat_files:start_bash_job");
			const blocked = await runner.run(`${tooBig} ${tooBig} ${tooBig} wait 1; ${tooBig} echo rc=$?`);
			expect(mutation_calls(runner, "ai_chat_files:start_bash_job") - before).toBe(3);
			expect(blocked.stdout).toBe("rc=1\n");
			expect(blocked.stderr).toContain("3 launches in a row were refused in this call");
		});

		test("a wait that waited for nothing leaves the local block in place", async () => {
			const runner = await create_bash_runner();
			// A loop of `cmd & wait` starts nothing and waits for nothing, so it must not be able to keep
			// asking the door. Only a wait that saw a live job end lifts the local block.
			const tooBig = `true '${"a".repeat(66_000)}' &`;
			const before = mutation_calls(runner, "ai_chat_files:start_bash_job");
			const blocked = await runner.run(`${tooBig} ${tooBig} ${tooBig} wait; ${tooBig} echo rc=$?`);
			expect(mutation_calls(runner, "ai_chat_files:start_bash_job") - before).toBe(3);
			expect(blocked.stdout).toBe("rc=1\n");
			expect(blocked.stderr).toContain("3 launches in a row were refused in this call");
		});

		test("a wait that gave up with its job still live leaves the local block in place", async () => {
			const runner = await create_bash_runner();
			// The wait returns 3 with job 1 still queued, so no slot was freed. The reset has to sit
			// after that return: a reset before it would lift the block on a wait that ended nothing.
			for (let n = 1; n <= 4; n++) expect((await runner.run("sleep 1 &")).metadata.exitCode).toBe(0);
			const before = mutation_calls(runner, "ai_chat_files:start_bash_job");
			const blocked = await runner.run("sleep 1 & sleep 1 & sleep 1 & wait -t 1 1; sleep 1 & echo rc=$?");
			expect(mutation_calls(runner, "ai_chat_files:start_bash_job") - before).toBe(3);
			expect(blocked.stdout).toBe("rc=1\n");
			expect(blocked.stderr).toContain("3 launches in a row were refused in this call");
		});

		test("a wait that saw a live job end lifts the local block", async () => {
			const runner = await create_bash_runner();
			// Four live jobs from earlier calls, then three cap refusals. The wait finds job 1 live,
			// the wrapper ends it after that first list, and the launch after the wait must ask the
			// door again. Deleting the `if (waitedOnLive)` reset leaves every other door test green.
			for (let n = 1; n <= 4; n++) expect((await runner.run("sleep 1 &")).metadata.exitCode).toBe(0);
			const query = runner.runQuery.getMockImplementation()!;
			let ended = false;
			runner.runQuery.mockImplementation(async (ref, args) => {
				const result = await query(ref, args);
				if (
					!ended &&
					function_name_of(ref) === "ai_chat_files:list_thread_jobs" &&
					(args as { select?: { kind?: string } }).select?.kind === "numbers"
				) {
					ended = true;
					const row = await job_row(runner, 1);
					await runner.t.mutation(internal.ai_chat_files.finish_bash_job, {
						invocationId: row._id,
						result: {
							title: "job",
							output: "done\n",
							stdout: "done\n",
							stderr: "",
							metadata: {
								command: "sleep 1",
								cwd: "/",
								nextCwd: "/",
								exitCode: 0,
								stdoutTruncated: false,
								stderrTruncated: false,
								stdoutLength: 5,
								stderrLength: 0,
								pathIndexTruncated: false,
								observedPaths: [],
								observedPathsTruncated: false,
							},
						},
					});
				}
				return result;
			});
			const wait_lists = () =>
				runner.runQuery.mock.calls.filter(
					([ref, queryArgs]) =>
						function_name_of(ref) === "ai_chat_files:list_thread_jobs" &&
						(queryArgs as { select?: { kind?: string } }).select?.kind === "numbers",
				).length;
			const before = mutation_calls(runner, "ai_chat_files:start_bash_job");
			vi.useFakeTimers();
			try {
				// `wait` lists once, then sleeps. Hold the rest of the call until that first list, so
				// the wrapper can end job 1 while `wait` still sees it live. Then run out the `-t`
				// bound: `wait` has already returned by then, and a wait that never looked again
				// would hang this test.
				const waiting = runner.run("sleep 1 & sleep 1 & sleep 1 & wait -t 5 1; sleep 1 & echo rc=$?");
				while (wait_lists() === 0) await vi.advanceTimersByTimeAsync(100);
				await vi.advanceTimersByTimeAsync(5_000);
				const reset = await waiting;
				expect(mutation_calls(runner, "ai_chat_files:start_bash_job") - before).toBe(4);
				expect(reset.stdout).toBe("rc=0\n");
				expect(reset.stderr).toContain("started job");
				expect(reset.stderr).not.toContain("in a row were refused");
			} finally {
				vi.useRealTimers();
			}
		});

		test("wait reports 1 when a job row disappears while it polls", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("{ t=600; sleep $t; } &")).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			const query = runner.runQuery.getMockImplementation()!;
			let deleted = false;
			runner.runQuery.mockImplementation(async (ref, args) => {
				const result = await query(ref, args);
				if (
					!deleted &&
					function_name_of(ref) === "ai_chat_files:list_thread_jobs" &&
					(args as { select?: { kind?: string } }).select?.kind === "numbers"
				) {
					deleted = true;
					await runner.t.run(async (ctx) => {
						await ai_chat_files_db_delete_job_batch(ctx, { invocationId: row._id, batchSize: 8 });
					});
				}
				return result;
			});
			const wait_lists = () =>
				runner.runQuery.mock.calls.filter(
					([ref, queryArgs]) =>
						function_name_of(ref) === "ai_chat_files:list_thread_jobs" &&
						(queryArgs as { select?: { kind?: string } }).select?.kind === "numbers",
				).length;
			vi.useFakeTimers();
			try {
				// `wait` lists once, then sleeps. The first list still sees the row, so the missing
				// check passes. The wrapper then deletes it. The second list is empty. Asking
				// `read_job_exit_codes` for that empty list reports 0; asking for the number `wait`
				// started with reports 1.
				const waiting = runner.run("wait -t 5 1");
				while (wait_lists() === 0) await vi.advanceTimersByTimeAsync(100);
				await vi.advanceTimersByTimeAsync(5_000);
				expect((await waiting).metadata.exitCode).toBe(1);
			} finally {
				vi.useRealTimers();
			}
		});

		test("a nested job counts against the cap and survives its parent's stop", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("{ echo nested & } &")).metadata.exitCode).toBe(0);
			const parent = await run_job(runner, 1);
			expect(parent.result?.stderr).toContain("bash: started job 2 in shell default.");
			expect(await activity_of(runner, 2)).toMatchObject({ status: "queued", source: { parentJobNumber: 1 } });
			expect((await runner.run("jobs")).stdout).toBe("[2] queued    default  echo nested   (from job 1)\n");
			const child = await run_job(runner, 2);
			expect(child.result?.stdout).toBe("nested\n");
		});

		test("pauses before a top-level sleep, keeps its state and cwd, and finishes in a later run", async () => {
			const runner = await create_bash_runner();
			const script = "{ x=1; echo before $x; cd docs; sleep 30; x=$((x + 1)); echo after $x; pwd; }";
			expect((await runner.run(`${script} &`)).metadata.exitCode).toBe(0);

			// The first run stops before the sleep: the rest, the state, the cwd and the output head
			// go on the row, the Activity waits as `queued`, and the next run is due after the sleep.
			const paused = await run_job(runner, 1);
			expect(paused.status).toBe("running");
			expect(paused.job).toMatchObject({
				script,
				resumeScript: "x=$((x + 1))\necho after $x\npwd",
				startCwd: `${test_db_files_mount}/docs`,
				liveOutput: { stdout: "before 1\n", stderr: "", stdoutTruncated: false, stderrTruncated: false },
			});
			expect(paused.job?.shellState?.env).toContainEqual({ name: "x", value: "1" });
			const pausedActivity = await activity_of(runner, 1);
			expect(pausedActivity).toMatchObject({ status: "queued" });
			expect(vi.mocked(Workpool.prototype).enqueueAction.mock.calls.at(-1)?.[3]).toMatchObject({ runAfter: 30_000 });
			const partial = await runner.run("jobs -o 1");
			expect(partial.metadata.exitCode).toBe(3);
			expect(partial.stdout).toBe("before 1\n");
			// The marker word comes from the Activity, so a paused job reads `queued` here too.
			expect(partial.stderr).toBe("[job 1 queued]\n");

			// The next run continues with the saved state and prints the whole job's output.
			const finished = await run_job(runner, 1);
			expect(finished.status).toBe("finished");
			expect(finished.job).toMatchObject({ script: null, shellState: null });
			expect(finished.job?.resumeScript).toBeUndefined();
			expect(finished.result).toMatchObject({
				stdout: `before 1\nafter 2\n${test_db_files_mount}/docs\n`,
				stderr: "",
				metadata: { exitCode: 0 },
			});
			expect(await activity_of(runner, 1)).toMatchObject({ status: "succeeded", startedAt: pausedActivity?.startedAt });
			const entries = await runner.t.run(async (ctx) =>
				(await ctx.db.query("ai_chat_bash_shell_transcripts").collect())
					.sort((a, b) => a.seq - b.seq)
					.map((entry) => entry.text),
			);
			expect(entries.find((entry) => entry.includes("job 1 paused"))).toMatch(
				/^\$ \[[^\]]+\] job 1 paused \(exit 0\) in shell default: sleep 30s, continues at [^\n]+\nbefore 1\n\n$/,
			);
			expect(entries.at(-1)).toMatch(
				/^\$ \[[^\]]+\] job 1 finished \(exit 0\) in shell default, started \d\d:\d\d:\d\d\n\{ x=1; [^\n]+\nbefore 1\nafter 2\n/,
			);
		});

		test("pauses when the run budget is nearly used and continues at once", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("{ sleep 1; echo one; echo two; } &")).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			vi.useFakeTimers({ toFake: ["Date"] });
			try {
				const start = Date.now();
				const worker = bash_run_job(runner.ctx, { invocationId: row._id });
				// The first statement sleeps on the real clock; meanwhile the run budget runs out.
				await new Promise((resolve) => setTimeout(resolve, 300));
				vi.setSystemTime(start + 7 * 60 * 1000);
				await worker;
			} finally {
				vi.useRealTimers();
			}
			const paused = await job_row(runner, 1);
			expect(paused.status).toBe("running");
			expect(paused.job).toMatchObject({ resumeScript: "echo one\necho two" });
			expect(paused.job?.liveOutput).toBeUndefined();
			// Nothing was printed yet, so the marker is the whole answer; it still costs no read budget.
			const partial = await runner.run("jobs -o 1");
			expect(partial.metadata.exitCode).toBe(3);
			expect(partial.stdout).toBe("");
			expect(partial.stderr).toBe("[job 1 queued]\n");
			expect(vi.mocked(Workpool.prototype).enqueueAction.mock.calls.at(-1)?.[3]).toMatchObject({ runAfter: 0 });
			const entries = await runner.t.run(async (ctx) =>
				(await ctx.db.query("ai_chat_bash_shell_transcripts").collect()).map((entry) => entry.text),
			);
			expect(
				entries.some((entry) =>
					entry.includes("job 1 paused (exit 0) in shell default: run budget used, continues at once\n"),
				),
			).toBe(true);

			const finished = await run_job(runner, 1);
			expect(finished.result).toMatchObject({ stdout: "one\ntwo\n", metadata: { exitCode: 0 } });
		});

		test("a dropped sleep leaves $? at 0, like a sleep that ran", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("{ false; sleep 30; echo rc=$?; } &")).metadata.exitCode).toBe(0);
			await run_job(runner, 1);
			const finished = await run_job(runner, 1);
			expect(finished.result?.stdout).toBe("rc=0\n");
		});

		test("a pause tells jobs -o about the dropped /tmp writes and the closed descriptors", async () => {
			const runner = await create_bash_runner();
			const script = "{ exec 3>/tmp/log; echo one > /tmp/keep; sleep 30; echo two; }";
			expect((await runner.run(`${script} &`)).metadata.exitCode).toBe(0);
			expect((await run_job(runner, 1)).status).toBe("running");

			// The notes are added after the engine returned, so only this prepares them for the head
			// `jobs -o` reads; the run's own result reaches the transcript instead.
			const partial = await runner.run("jobs -o 1");
			expect(partial.metadata.exitCode).toBe(3);
			expect(partial.stderr).toContain("bash: /tmp writes are dropped when a job pauses:");
			expect(partial.stderr).toContain("bash: file descriptor 3 was closed\n");
			expect(partial.stderr.endsWith("[job 1 queued]\n")).toBe(true);
		});

		test("a job whose state is too big to pause runs on and says so", async () => {
			const runner = await create_bash_runner();
			// 133000 characters in one variable put the snapshot over the 128 KiB cap, so the sleep
			// cannot pause and runs for real.
			const script = '{ x=$(printf "%133000s" ""); sleep 5; echo done; }';
			expect((await runner.run(`${script} &`)).metadata.exitCode).toBe(0);
			const finished = await run_job(runner, 1);
			expect(finished.status).toBe("finished");
			expect(finished.result?.stdout).toBe("done\n");
			expect(finished.result?.stderr).toContain(
				"bash: the shell state is larger than 128 KiB, so the job cannot pause",
			);
		});

		test("a pause says nothing about an earlier statement that was too big to pause", async () => {
			const runner = await create_bash_runner();
			// The first sleep cannot pause, because the variable is over the cap. `unset` shrinks the
			// state, so the second sleep pauses, and the warning would contradict that pause.
			const script = '{ x=$(printf "%133000s" ""); sleep 5; unset x; sleep 5; echo done; }';
			expect((await runner.run(`${script} &`)).metadata.exitCode).toBe(0);
			const paused = await run_job(runner, 1);
			expect(paused.status).toBe("running");
			// The first sleep really could not pause: the stored rest starts after the second sleep, so
			// this run walked past the first one instead of stopping there.
			expect(paused.job?.resumeScript).toBe("echo done");

			const partial = await runner.run("jobs -o 1");
			expect(partial.stderr).not.toContain("the shell state is larger than 128 KiB");
			expect(partial.stderr.endsWith("[job 1 queued]\n")).toBe(true);
		});

		test("stops pausing once the job used its whole lifetime", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("{ sleep 30; echo after; } &")).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			vi.useFakeTimers({ toFake: ["Date"] });
			try {
				// The claim arms a fresh run budget from this moment, so only the job's age can end
				// this run. A 25-hour-old job is past the 24-hour lifetime.
				vi.setSystemTime(row._creationTime + 25 * 60 * 60 * 1000);
				await bash_run_job(runner.ctx, { invocationId: row._id });
			} finally {
				vi.useRealTimers();
			}
			const finished = await job_row(runner, 1);
			expect(finished.status).toBe("finished");
			expect(finished.result?.metadata.exitCode).toBe(124);
			expect(finished.job?.resumeScript).toBeUndefined();
			expect(await activity_of(runner, 1)).toMatchObject({ status: "timed_out" });
		});

		test("a launch after a pause starts a new job instead of finding the earlier one", async () => {
			const runner = await create_bash_runner();
			// A launch is stored under a synthetic tool-call id made of the job row and the command
			// number, so a replayed launch finds the row it already made. Each run counts its own
			// commands, so the count has to survive the pause: otherwise both `&` statements are
			// command 0, and the second launch finds job 2 again and starts nothing.
			expect((await runner.run("{ echo one & sleep 30; echo two & } &")).metadata.exitCode).toBe(0);
			await run_job(runner, 1);
			expect((await job_row(runner, 2)).job?.script).toBe("echo one");

			const finished = await run_job(runner, 1);
			expect(finished.status).toBe("finished");
			expect(finished.result?.stderr).toContain("bash: started job 3 in shell default.");
			expect((await job_row(runner, 3)).job?.script).toBe("echo two");
		});

		test("a bare wait after a pause still waits for the jobs the earlier run started", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("{ echo one & sleep 30; wait -t 1; } &")).metadata.exitCode).toBe(0);
			await run_job(runner, 1);
			// The pool is mocked, so job 2 is still queued. A bare `wait` that lost the numbers of
			// the earlier run would wait for nothing and return 0 instead of 3.
			const finished = await run_job(runner, 1);
			expect(finished.result?.metadata.exitCode).toBe(3);
		});

		test("a launch before a pause still answers wait $! in the next run", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("sleep 1 & { echo one & sleep 30; wait -t 1 $!; } &")).metadata.exitCode).toBe(0);
			// A job starts with `$!` at 0: job 1 belongs to the call that started it, not to job 2.
			expect((await job_row(runner, 2)).job?.shellState?.lastBackgroundPid).toBeUndefined();
			// The shell the call leaves behind keeps no `$!` either, so the next call reads 0. That is
			// what the tool prompt promises, and storing the call's snapshot unchanged breaks it.
			expect((await runner.run("echo $!")).stdout).toBe("0\n");

			const paused = await run_job(runner, 2);
			// `$!` is part of the shell state the pause stored. A state that dropped it would run
			// `wait -t 1 0`, which names no job, instead of waiting for the still-queued job 3.
			expect(paused.job?.shellState?.lastBackgroundPid).toBe(3);
			const finished = await run_job(runner, 2);
			expect(finished.result?.metadata.exitCode).toBe(3);
		});

		test("a bare wait takes the newest job numbers when a job started more than one wait may name", async () => {
			const runner = await create_bash_runner();
			// Twelve finished jobs. The cap counts live jobs, so launch four and run those four to the
			// end before the next four. Job 1 exits 7 and is the oldest number the slice keeps, so a wait
			// that kept eleven numbers, or numbers from the wrong end, cannot print 7 below.
			for (let round = 0; round < 3; round++) {
				const launches = round === 0 ? "exit 7 & echo b & echo c & echo d &" : "echo a & echo b & echo c & echo d &";
				expect((await runner.run(launches)).metadata.exitCode).toBe(0);
				for (let jobNumber = round * 4 + 1; jobNumber <= round * 4 + 4; jobNumber++) {
					expect((await run_job(runner, jobNumber)).status).toBe("finished");
				}
			}

			expect((await runner.run("{ sleep 5; wait; echo rc=$?; } &")).metadata.exitCode).toBe(0);
			const paused = await run_job(runner, 13);
			expect(paused.job?.resumeScript).toBe("wait\necho rc=$?");
			// A job that ran several statements across pauses can have started more jobs than one
			// `wait` may name. Fourteen numbers, and the two oldest name no row: a read of more than
			// twelve is refused whole, and a slice from the wrong end asks for 998 and gets "no such
			// job" instead of waiting.
			await runner.t.run((ctx) =>
				ctx.db.patch("ai_chat_bash_invocations", paused._id, {
					job: { ...paused.job!, resumeLaunchedJobNumbers: [998, 999, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
				}),
			);

			// The bare `wait` keeps the newest twelve, which all finished, so it waits for nothing and
			// prints the worst exit code among them, which is job 1's 7. The job's own exit code is the
			// `echo`'s.
			const finished = await run_job(runner, 13);
			expect(finished.result?.stderr).toBe("");
			expect(finished.result?.stdout).toBe("rc=7\n");
			expect(finished.result?.metadata.exitCode).toBe(0);
		});

		test("a pause stores only the newest job numbers when a job started more than the row may keep", async () => {
			const runner = await create_bash_runner();
			// Three launches per run is the room the job has: the 4-jobs cap counts the job itself, and
			// each round's jobs must finish before the next round may start. Five rounds launch fifteen
			// jobs, which is more than the twelve numbers a row may keep.
			const round = "echo a & echo b & echo c & sleep 5; ";
			expect((await runner.run(`{ ${round.repeat(5)}echo done; } &`)).metadata.exitCode).toBe(0);
			for (let pass = 0; pass < 5; pass++) {
				expect((await run_job(runner, 1)).job?.resumeScript).toBeDefined();
				for (let jobNumber = pass * 3 + 2; jobNumber <= pass * 3 + 4; jobNumber++) {
					expect((await run_job(runner, jobNumber)).status).toBe("finished");
				}
			}

			// The newest twelve of the fifteen. Without the cap the stored array would grow with every
			// pause of a job that keeps launching jobs, for as long as the job lives.
			const paused = await job_row(runner, 1);
			expect(paused.job?.resumeScript).toBe("echo done");
			expect(paused.job?.resumeLaunchedJobNumbers).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
		});

		test("a settled job keeps no script and no paused state", async () => {
			const runner = await create_bash_runner();
			const script = "{ x=1; sleep 30; echo done; }";
			expect((await runner.run(`${script} &`)).metadata.exitCode).toBe(0);
			const paused = await run_job(runner, 1);
			expect(paused.job?.resumeScript).toBe("echo done");
			expect(paused.job?.shellState?.env).toContainEqual({ name: "x", value: "1" });

			// The watchdog settles the paused row, and nothing will ever run it again. So the script and
			// the state it stored for the next run must not sit on the row until the row is deleted.
			vi.useFakeTimers({ toFake: ["Date"] });
			try {
				vi.setSystemTime(paused.deadlineAt + 1);
				await runner.t.mutation(internal.ai_chat_files.timeout_bash_job, {
					invocationId: paused._id,
					expectedDeadlineAt: paused.deadlineAt,
				});
			} finally {
				vi.useRealTimers();
			}
			const settled = await job_row(runner, 1);
			expect(settled.status).toBe("interrupted");
			expect(settled.job).toMatchObject({ script: null, shellState: null });
			expect(settled.job?.resumeScript).toBeUndefined();
			expect(settled.job?.resumeCommandNumber).toBeUndefined();
			expect(settled.job?.resumeLaunchedJobNumbers).toBeUndefined();
			// The finish entry still names the script, because the settle writes it from the copy it
			// read before the patch. Read it off that entry: the launching call and the start entry
			// print the same text, so searching the whole transcript would pass without it.
			const lines = (await runner.run("cat /shells/default/transcript")).stdout.split("\n");
			const finishHeader = lines.findIndex((line) => line.includes("job 1 finished (exit 124)"));
			expect(finishHeader).toBeGreaterThan(-1);
			expect(lines[finishHeader + 1]).toBe(script);
		});

		test("a Stop lands at the next statement boundary, not only at the next 5-second tick", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("{ sleep 1.2; echo after; } &")).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			const worker = bash_run_job(runner.ctx, { invocationId: row._id });
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect((await runner.run("kill 1")).metadata.exitCode).toBe(0);
			// Without the boundary poll `echo after` would run at 1.2 s, well before the 5-second tick.
			await worker;
			const finished = await job_row(runner, 1);
			expect(finished.result).toMatchObject({ stdout: "", metadata: { exitCode: 143 } });
			expect(await activity_of(runner, 1)).toMatchObject({ status: "canceled" });
		});

		test("a call with the wake flag arms the jobs it starts, and a job a job starts is never armed", async () => {
			const runner = await create_bash_runner({ wakeAgent: { modelId: "gpt-5.4-nano" } });
			expect((await runner.run("{ echo nested & } &")).metadata.exitCode).toBe(0);
			expect((await job_row(runner, 1)).job?.wakeAgent).toEqual({ modelId: "gpt-5.4-nano" });
			// The worker's own jobContext carries no wake flag.
			await run_job(runner, 1);
			expect((await job_row(runner, 2)).job?.wakeAgent).toBeUndefined();
		});

		test("wait in a call with the wake flag arms the live jobs and stops polling", async () => {
			const launcher = await create_bash_runner();
			expect((await launcher.run("sleep 600 &")).metadata.exitCode).toBe(0);
			expect((await launcher.run("true &")).metadata.exitCode).toBe(0);
			await run_job(launcher, 2);
			expect((await job_row(launcher, 1)).job?.wakeAgent).toBeUndefined();
			// A plain `wait` polls and reports nothing about waking.
			const polled = await launcher.run("wait -t 1 1");
			expect(polled.metadata.exitCode).toBe(3);
			expect(polled.metadata.waitingForJobs).toBeUndefined();

			const waiter = await create_bash_runner({
				shared: { t: launcher.t, seeded: launcher.seeded },
				threadId: launcher.threadId,
				wakeAgent: { modelId: "gpt-5.4-mini" },
			});
			const waited = await waiter.run("wait 1 2");
			expect(waited.stderr).toBe(
				"bash: waiting for job 1: end this turn. The finish then starts your next run, or leaves its result in the shell transcript.\n",
			);
			expect(waited.metadata.exitCode).toBe(3);
			expect(waited.metadata.waitingForJobs).toEqual([1]);
			expect((await job_row(launcher, 1)).job?.wakeAgent).toEqual({ modelId: "gpt-5.4-mini" });
			// A finished job is never armed, and a wait on it alone reads its result as usual.
			expect((await job_row(launcher, 2)).job?.wakeAgent).toBeUndefined();
			const done = await waiter.run("wait 2");
			expect(done.metadata.exitCode).toBe(0);
			expect(done.metadata.waitingForJobs).toBeUndefined();
		});

		test("kill stops a running job with 143, also inside a sleep, and never ends the call", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("{ echo before; t=60; sleep $t; } &")).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			vi.useFakeTimers();
			try {
				const worker = bash_run_job(runner.ctx, { invocationId: row._id });
				await vi.advanceTimersByTimeAsync(1_000);
				const killed = await runner.run("kill 1; echo after");
				expect(killed.stdout).toBe("after\n");
				expect(killed.stderr).toBe("bash: kill: stop requested for job 1\n");
				expect(killed.metadata.exitCode).toBe(0);
				await vi.advanceTimersByTimeAsync(5_000);
				await worker;
			} finally {
				vi.useRealTimers();
			}
			const stopped = await job_row(runner, 1);
			expect(stopped.result).toMatchObject({ stdout: "before\n", metadata: { exitCode: 143 } });
			expect(stopped.result?.stderr).toContain("bash: job stopped. Remaining commands were stopped.");
			// `sleep` runs through the /tmp-only delegate, so a Stop ends it non-zero. `sleep` never
			// reads an app file, so the stored output must not tell the user about db-backed paths.
			expect(stopped.result?.stderr).not.toContain("cannot access app files directly");
			expect(await activity_of(runner, 1)).toMatchObject({ status: "canceled" });
			// The stopped job's note comes first: this is the next fresh call after it finished.
			const missing = await runner.run("kill 9; kill 1");
			expect(missing.stderr).toBe(
				"bash: job 1 stopped. Output: /shells/default/transcript\nbash: kill: no such job 9\nbash: kill: no such job 1\n",
			);
			expect(missing.metadata.exitCode).toBe(1);
		});

		test("an Ask-mode member can kill its own job", async () => {
			const owner = await create_bash_runner();
			const member = await owner.t.run(async (ctx) => {
				const userId = await ctx.db.insert("users", { clerkUserId: "ask-kill-member" });
				await test_mocks_fill_db_with.plan(ctx, { userId, plan: "Pay As You Go" });
				const membershipId = await ctx.db.insert("organizations_workspaces_users", {
					organizationId: owner.seeded.organizationId,
					workspaceId: owner.seeded.workspaceId,
					userId,
					active: true,
					updatedAt: Date.now(),
				});
				await access_control_db_ensure_role_assignment(ctx, {
					organizationId: owner.seeded.organizationId,
					workspaceId: owner.seeded.workspaceId,
					userId,
					role: "viewer",
					now: Date.now(),
				});
				return { userId, membershipId };
			});
			// Ask mode cannot write app files, so the `kill` door needs `content.read` only. Give the
			// member the one role that holds read and nothing else, so a door that asked for write
			// instead would fail here. A member who does not own the organization must still be able to
			// stop their own job.
			const runner = await create_bash_runner({
				allowDbFilesMkdir: false,
				shared: { t: owner.t, seeded: { ...owner.seeded, ...member } },
			});
			expect((await runner.run("{ t=60; sleep $t; } &")).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			expect(row.job?.allowDbFilesMkdir).toBe(false);
			vi.useFakeTimers();
			try {
				const worker = bash_run_job(runner.ctx, { invocationId: row._id });
				await vi.advanceTimersByTimeAsync(1_000);
				const killed = await runner.run("kill 1");
				expect(killed.metadata.exitCode, killed.stderr).toBe(0);
				expect(killed.stderr).toBe("bash: kill: stop requested for job 1\n");
				await vi.advanceTimersByTimeAsync(10_000);
				// Run out the job's whole 8-minute budget too. The stop has already been served by now.
				// If the `kill` door had refused an Ask-mode stop, the job would report 124 here instead
				// of hanging the test.
				await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
				await worker;
			} finally {
				vi.useRealTimers();
			}
			expect((await job_row(runner, 1)).result?.metadata.exitCode).toBe(143);
			expect(await activity_of(runner, 1)).toMatchObject({ status: "canceled" });
		});

		test("a running job stops when its write permission is taken away", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("{ echo before; t=60; sleep $t; } &")).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			// Only an Agent-mode job is checked for `content.write`, so say that out loud here. Without
			// this the test would go red with a puzzling 124 if the runner's default ever flipped.
			expect(row.job?.allowDbFilesMkdir).toBe(true);
			vi.useFakeTimers();
			try {
				const worker = bash_run_job(runner.ctx, { invocationId: row._id });
				await vi.advanceTimersByTimeAsync(1_000);
				// The runner's user created the organization, so they own it, and the owner passes every
				// permission check. Hand the organization to somebody else and leave the user a role with
				// no `content.write`. This job runs in Agent mode, so it could still write app files.
				// The next poll must stop it.
				await runner.t.run(async (ctx) => {
					const otherOwnerId = await ctx.db.insert("users", { clerkUserId: null });
					await ctx.db.patch("organizations", runner.seeded.organizationId, { ownerUserId: otherOwnerId });
					// `ensure` returns an existing assignment unchanged, so patch the role as well. A user
					// who already held a `member` row would otherwise keep `content.write`, and this test
					// would pass without ever taking the permission away.
					const assignmentId = await access_control_db_ensure_role_assignment(ctx, {
						organizationId: runner.seeded.organizationId,
						workspaceId: runner.seeded.workspaceId,
						userId: runner.seeded.userId,
						role: "member",
						now: Date.now(),
					});
					await ctx.db.patch("access_control_role_assignments", assignmentId, { role: "viewer" });
				});
				await vi.advanceTimersByTimeAsync(10_000);
				// Run out the job's whole 8-minute budget too. The poll has already stopped the job by now.
				// If a poll had skipped the permission check, the job would report 124 here instead of
				// hanging the test.
				await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
				await worker;
			} finally {
				vi.useRealTimers();
			}
			const stopped = await job_row(runner, 1);
			expect(stopped.result).toMatchObject({ stdout: "before\n", metadata: { exitCode: 143 } });
			expect(await activity_of(runner, 1)).toMatchObject({ status: "canceled" });
		});

		test("an Ask-mode job keeps running when its write permission is taken away", async () => {
			const runner = await create_bash_runner({ allowDbFilesMkdir: false });
			expect((await runner.run("{ echo before; t=600; sleep $t; } &")).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			expect(row.job?.allowDbFilesMkdir).toBe(false);
			// Only the poll can stop a job, so count its turns to prove it really ran.
			const poll_count = () =>
				runner.runQuery.mock.calls.filter(([ref]) => function_name_of(ref) === "ai_chat_files:poll_bash_job").length;
			vi.useFakeTimers();
			try {
				const worker = bash_run_job(runner.ctx, { invocationId: row._id });
				await vi.advanceTimersByTimeAsync(1_000);
				const pollsBeforeHandover = poll_count();
				// The same handover as the Agent-mode test above. An Ask-mode job cannot write app files,
				// so its poll asks for read only and must leave this job alone.
				await runner.t.run(async (ctx) => {
					const otherOwnerId = await ctx.db.insert("users", { clerkUserId: null });
					await ctx.db.patch("organizations", runner.seeded.organizationId, { ownerUserId: otherOwnerId });
					// `ensure` returns an existing assignment unchanged, so patch the role as well. A user
					// who already held a `member` row would otherwise keep `content.write`, and this test
					// would pass without ever taking the permission away.
					const assignmentId = await access_control_db_ensure_role_assignment(ctx, {
						organizationId: runner.seeded.organizationId,
						workspaceId: runner.seeded.workspaceId,
						userId: runner.seeded.userId,
						role: "member",
						now: Date.now(),
					});
					await ctx.db.patch("access_control_role_assignments", assignmentId, { role: "viewer" });
				});
				await vi.advanceTimersByTimeAsync(15_000);
				// Count the polls that ran after the handover. Nothing else in this test would notice a
				// handover that did not take, and the exit code below reads 124 either way.
				expect(poll_count()).toBeGreaterThan(pollsBeforeHandover);
				// The job's own `sleep` runs on the real clock, because just-bash keeps the `setTimeout` it
				// captured when the module loaded and no fake advance can move it. So let the job's
				// deadline end it instead of waiting for the sleep. A poll that asked for write would have
				// stopped the job at 5 seconds and the exit code below would read 143.
				await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
				await worker;
			} finally {
				vi.useRealTimers();
			}
			const finished = await job_row(runner, 1);
			expect(finished.result).toMatchObject({ stdout: "before\n", metadata: { exitCode: 124 } });
			expect(await activity_of(runner, 1)).toMatchObject({ status: "timed_out" });
		});

		test("a job that uses its whole budget keeps its output and reports 124", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("{ echo partial; t=600; sleep $t; } &")).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			vi.useFakeTimers();
			try {
				const worker = bash_run_job(runner.ctx, { invocationId: row._id });
				await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
				await worker;
			} finally {
				vi.useRealTimers();
			}
			const timedOut = await job_row(runner, 1);
			expect(timedOut.result).toMatchObject({ stdout: "partial\n", metadata: { exitCode: 124 } });
			expect(timedOut.result?.stderr).toContain("Remaining commands were stopped.");
			// A deadline is not an app-file failure either, so its stored output must stay clean too.
			expect(timedOut.result?.stderr).not.toContain("cannot access app files directly");
			expect(await activity_of(runner, 1)).toMatchObject({ status: "timed_out" });
		});

		test("wait -t stops at the call's own deadline, not at the seconds it was given", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("{ t=600; sleep $t; } &")).metadata.exitCode).toBe(0);
			// Only `wait` reads the jobs it was named, so this counts its own polls.
			const wait_polls = () =>
				runner.runQuery.mock.calls.filter(
					([ref, queryArgs]) =>
						function_name_of(ref) === "ai_chat_files:list_thread_jobs" &&
						(queryArgs as { select?: { kind?: string } }).select?.kind === "numbers",
				).length;
			runner.runQuery.mockClear();
			vi.useFakeTimers();
			try {
				// A call gets 90 seconds at most, so `wait` cannot really wait the 600 it was given. The
				// job never runs here, so it stays live for the whole wait.
				const startedAt = Date.now();
				let polls = 0;
				let lastPollMs = 0;
				const waiting = runner.run("wait -t 600 1");
				// Read the clock at `wait`'s last look at the jobs, not when the call returns: storing the
				// result and writing the transcript take their own turns, and each one costs another step
				// of this loop. Run the whole 150 seconds, which is past the call's own 120-second abort,
				// so a `wait` that kept its 600 seconds also stops polling and the assertion reads its
				// last poll instead of hanging the test.
				while (Date.now() - startedAt < 150_000) {
					await vi.advanceTimersByTimeAsync(1_000);
					if (wait_polls() > polls) {
						polls = wait_polls();
						lastPollMs = Date.now() - startedAt;
					}
				}
				// A `wait` that did not wait at all polls once, and one that used its own 600 seconds keeps
				// polling until the call is aborted at 120 seconds. Bound both ends, so neither passes.
				// The upper bound has room for a slow step of this loop, which can drift a few seconds.
				expect(polls).toBeGreaterThan(1);
				expect(lastPollMs).toBeGreaterThanOrEqual(85_000);
				expect(lastPollMs).toBeLessThanOrEqual(100_000);
				expect((await waiting).metadata.exitCode).toBe(3);
			} finally {
				vi.useRealTimers();
			}
		});

		test("wait notices a job that finishes while it is waiting", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("false &")).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			// Only `wait` reads the jobs it was named, so this counts its own list calls.
			const wait_lists = () =>
				runner.runQuery.mock.calls.filter(
					([ref, queryArgs]) =>
						function_name_of(ref) === "ai_chat_files:list_thread_jobs" &&
						(queryArgs as { select?: { kind?: string } }).select?.kind === "numbers",
				).length;
			runner.runQuery.mockClear();
			vi.useFakeTimers();
			try {
				// `wait` lists the jobs once, sleeps, then lists them again. Hold the worker back until
				// that first list has run, so `wait` sees the job still queued. Only the second list can
				// report the job's own exit code here; without it `wait` would report 3.
				const waiting = runner.run("wait -t 20 1");
				while (wait_lists() === 0) await vi.advanceTimersByTimeAsync(100);
				const worker = bash_run_job(runner.ctx, { invocationId: row._id });
				await vi.advanceTimersByTimeAsync(5_000);
				await worker;
				// Run out the whole `-t` bound too. `wait` has already returned by now, and a `wait`
				// that never looked again gives up with 3 here instead of hanging the test.
				await vi.advanceTimersByTimeAsync(20_000);
				expect((await waiting).metadata.exitCode).toBe(1);
			} finally {
				vi.useRealTimers();
			}
			expect(await activity_of(runner, 1)).toMatchObject({ status: "failed" });
		});

		test("a job whose row was already settled interrupted stops with 124, not 143", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("{ echo partial; t=600; sleep $t; } &")).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			vi.useFakeTimers();
			try {
				const worker = bash_run_job(runner.ctx, { invocationId: row._id });
				await vi.advanceTimersByTimeAsync(1_000);
				// Somebody else marked the row interrupted while this worker is still alive. That is a
				// deadline, not a Stop, so the poll must abort with the deadline reason.
				await runner.t.mutation(internal.ai_chat_files.interrupt_bash_invocation, { invocationId: row._id });
				await vi.advanceTimersByTimeAsync(5_000);
				await worker;
			} finally {
				vi.useRealTimers();
			}
			const settled = await job_row(runner, 1);
			expect(settled.result).toMatchObject({ stdout: "partial\n", metadata: { exitCode: 124 } });
			expect(settled.result?.stderr).toContain("bash: Bash deadline reached. Remaining commands were stopped.");
		});

		test("wait covers this call's launches or named jobs and reports the worst code", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("wait")).metadata.exitCode).toBe(0);
			expect((await runner.run("false &")).metadata.exitCode).toBe(0);
			expect((await runner.run("true &")).metadata.exitCode).toBe(0);
			const missing = await runner.run("wait 9");
			expect(missing.stderr).toBe("bash: wait: 9: no such job\n");
			expect(missing.metadata.exitCode).toBe(1);
			expect((await runner.run("wait -t 1 1")).metadata.exitCode).toBe(3);
			await run_job(runner, 1);
			await run_job(runner, 2);
			expect((await runner.run("wait 2")).metadata.exitCode).toBe(0);
			expect((await runner.run("wait 1 2")).metadata.exitCode).toBe(1);
			const launched = await runner.run("true & wait -t 1");
			expect(launched.metadata.exitCode).toBe(3);
		});

		test("wait refuses more job numbers than the door will read", async () => {
			const runner = await create_bash_runner();
			// `wait {1..5000}` is 14 characters to type and one index read per number to serve, so the
			// list is bounded here as well as at the door.
			const many = await runner.run(
				`wait ${Array.from({ length: bash_JOB_NUMBERS_MAX_COUNT + 1 }, (_, n) => n + 1).join(" ")}`,
			);
			expect(many.stderr).toBe(
				`wait: at most ${bash_JOB_NUMBERS_MAX_COUNT} job numbers can be waited at once\nUsage: wait [-t SECONDS] [JOB...]\n`,
			);
			expect(many.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);

			// Repeats collapse, so a long list of the same job is still one read.
			expect((await runner.run(`wait ${"1 ".repeat(bash_JOB_NUMBERS_MAX_COUNT + 4)}`)).stderr).toBe(
				"bash: wait: 1: no such job\n",
			);
		});

		test("wait answers from the Activity when the result is gone or the watchdog settled the job", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("true &")).metadata.exitCode).toBe(0);
			expect((await runner.run("{ t=600; sleep $t; } &")).metadata.exitCode).toBe(0);
			const done = await run_job(runner, 1);
			await runner.t.run((ctx) => ctx.db.patch("ai_chat_bash_invocations", done._id, { result: undefined }));

			// The placeholder watchdog settles a job that never ran as timed out, with no result.
			const queued = await job_row(runner, 2);
			vi.useFakeTimers({ toFake: ["Date"] });
			try {
				vi.setSystemTime(queued.deadlineAt + 1);
				await runner.t.mutation(internal.ai_chat_files.timeout_bash_job, {
					invocationId: queued._id,
					expectedDeadlineAt: queued.deadlineAt,
				});
			} finally {
				vi.useRealTimers();
			}
			expect(await activity_of(runner, 2)).toMatchObject({ status: "timed_out" });

			expect((await runner.run("wait 1")).metadata.exitCode).toBe(0);
			expect((await runner.run("wait 1 2")).metadata.exitCode).toBe(124);
		});

		test("drops /tmp writes at job end and names them; /shells is mounted inside the job", async () => {
			const runner = await create_bash_runner();
			const script = "{ echo x > /tmp/j.txt; ls /shells; tail -n 1 /shells/default/transcript; }";
			expect((await runner.run(`${script} &`)).metadata.exitCode).toBe(0);
			const finished = await run_job(runner, 1);
			// The transcript's last line is the launching call's own stderr, saved before the job ran.
			expect(finished.result?.stdout).toBe(
				"default\nbash: started job 1 in shell default. Follow it with `jobs`, or in the Notifications panel.\n",
			);
			expect(finished.result?.stderr).toBe("bash: /tmp writes are dropped when a job ends: /tmp/j.txt\n");
			expect((await runner.run("ls /tmp")).stdout).not.toContain("j.txt");
		});

		test("cp inside a job hides its transfer from the feed and cp && cat waits for the copy", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run("cp docs/readme.md docs/copy.md && cat docs/copy.md &")).metadata.exitCode).toBe(0);
			const finished = await run_job(runner, 1);
			expect(finished.result?.metadata.exitCode, finished.result?.stderr).toBe(0);
			expect(finished.result?.stdout).toContain("Transfer ");
			// The copy is re-serialized markdown, so compare the body lines, not the exact bytes.
			expect(finished.result?.stdout).toContain("unique-token here\nmore unique-token below");
			const activities = await runner.t.run((ctx) => ctx.db.query("activities").collect());
			expect(activities.map((activity) => [activity.source.kind, activity.feedVisible])).toEqual(
				expect.arrayContaining([
					["ai_chat_bash_job", true],
					["files_transfer_run", false],
				]),
			);
		});

		test("which knows jobs and kill but not wait", async () => {
			const runner = await create_bash_runner();
			const known = await runner.run("which jobs; which kill");
			expect(known.metadata.exitCode, known.stderr).toBe(0);
			expect(known.stdout).toBe("/usr/bin/jobs\n/usr/bin/kill\n");
			expect((await runner.run("which wait")).metadata.exitCode).not.toBe(0);
		});
	});

	describe("resolve", () => {
		test("returns the Bash path for a raw node ID", async () => {
			const runner = await create_bash_runner();
			const nodeId = await get_seeded_node_id(runner, "/docs/readme.md");
			runner.runQuery.mockClear();
			vi.mocked(fetch).mockClear();

			const result = await runner.run(`resolve '${nodeId}'`);

			expect(result.metadata.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toBe(`${test_db_files_mount}/docs/readme.md\n`);
			expect(result.stderr).toBe("");
			expect(result.metadata.observedPaths).toEqual(["/docs/readme.md"]);
			const queries = runner.runQuery.mock.calls.map(([ref]) => function_name_of(ref));
			expect(queries).toContain("files_nodes:get_path_by_id");
			expect(queries.some((name) => name?.startsWith("files_nodes:list"))).toBe(false);
			expect(queries).not.toContain("files_nodes:read_file_content_from_chunks");
			expect(fetch).not.toHaveBeenCalled();
			expect(await list_pending_updates(runner)).toEqual([]);
		});

		test.each(["/docs", "/source.pdf"])("returns the path for %s without reading content", async (path) => {
			const runner = await create_bash_runner();
			const nodeId = await get_seeded_node_id(runner, path);
			vi.mocked(fetch).mockClear();

			const result = await runner.run(`resolve '${nodeId}'`);

			expect(result.metadata.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toBe(`${test_db_files_mount}${path}\n`);
			expect(fetch).not.toHaveBeenCalled();
		});

		test("accepts copied URLs and encoded saved paths without fetching them", async () => {
			const path = "/docs/My 100% café.md";
			const runner = await create_bash_runner({ extraFiles: [{ path, content: "encoded path marker\n" }] });
			const nodeId = await get_seeded_node_id(runner, path);
			vi.mocked(fetch).mockClear();

			for (const reference of [
				`http://localhost:5173/w/personal/home/files?nodeId=${nodeId}`,
				`https://app.example/w/personal/home/files?view=preview&nodeId=${nodeId}#details`,
				`https://other-host.example/w/%70ersonal/%68ome/files?nodeId=${nodeId}`,
				"https://app.example/w/personal/home/files/docs/My%20100%25%20caf%C3%A9.md?view=preview#details",
				`https://app.example/w/personal/home/files/docs/missing.md?nodeId=${nodeId}`,
			]) {
				const result = await runner.run(`resolve '${reference}'`);
				expect(result.metadata.exitCode, result.stderr).toBe(0);
				expect(result.stdout).toBe(`${test_db_files_mount}${path}\n`);
				expect(result.metadata.observedPaths).toEqual([path]);
			}
			expect(fetch).not.toHaveBeenCalled();
		});

		test("reports usage mistakes without looking up a node", async () => {
			const runner = await create_bash_runner();
			for (const args of [
				"",
				"--unknown",
				"one two",
				"'http://['",
				"'ftp://app.example/w/personal/home/files?nodeId=one'",
				"'https://app.example/w/personal/home/chat?nodeId=one'",
				"'https://app.example/w/personal/home/files'",
				"'https://app.example/w/personal/home/files?nodeId='",
				"'https://app.example/w/personal/home/files?nodeId=one&nodeId=two'",
				"'https://app.example/w/personal/home/files/docs/%ZZ.md'",
				"'https://app.example/w/%E0%A4%A/home/files?nodeId=one'",
			]) {
				runner.runQuery.mockClear();
				const result = await runner.run(`resolve ${args}`);
				expect(result.metadata.exitCode, result.stderr).toBe(bash_COMMAND_EXIT_USAGE);
				expect(result.stdout).toBe("");
				expect(result.stderr).toContain("resolve:");
				expect(result.metadata.observedPaths).toEqual([]);
				expect(runner.runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:get_path_by_id")).toBe(
					false,
				);
			}
		});

		test("supports help and the end-of-options marker", async () => {
			const runner = await create_bash_runner();
			const nodeId = await get_seeded_node_id(runner, "/docs/readme.md");

			const help = await runner.run("resolve --help");
			const found = await runner.run(`resolve -- '${nodeId}'`);
			const literalHelp = await runner.run("resolve -- --help");

			expect(help.metadata.exitCode).toBe(0);
			expect(help.stdout).toContain("Usage: resolve [--]");
			expect(help.stderr).toBe("");
			expect(help.metadata.observedPaths).toEqual([]);
			expect(found.metadata.exitCode).toBe(0);
			expect(found.stdout).toBe(`${test_db_files_mount}/docs/readme.md\n`);
			expect(literalHelp.metadata.exitCode).toBe(1);
			expect(literalHelp.stdout).toBe("");
		});

		test("uses the same unavailable result for invalid, missing, and archived IDs", async () => {
			const runner = await create_bash_runner();
			const archivedId = await get_seeded_node_id(runner, "/reports/summary.md");
			const missingId = await get_seeded_node_id(runner, "/uploaded.md");
			const archived = await runner_as_user(runner).mutation(api.files_nodes.archive_nodes, {
				membershipId: runner.seeded.membershipId,
				nodeIds: [archivedId],
			});
			expect(archived._nay).toBeUndefined();
			await runner.t.run((ctx) => ctx.db.delete("files_nodes", missingId));
			const unavailable = await runner.run("resolve 'missing'");

			for (const reference of ["", runner.seeded.userId, missingId, archivedId, files_ROOT_ID]) {
				const result = await runner.run(`resolve '${reference}'`);
				expect(result.metadata.exitCode, result.stderr).toBe(1);
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe(unavailable.stderr);
				expect(result.metadata.observedPaths).toEqual([]);
			}
		});

		test("refuses another tenant's ID and URL without returning its path", async () => {
			const runner = await create_bash_runner();
			const other = await create_bash_runner({
				shared: {
					t: runner.t,
					seeded: await runner.t.run((ctx) =>
						test_mocks_fill_db_with.membership(ctx, { organizationName: "other", workspaceName: "elsewhere" }),
					),
				},
				extraFiles: [{ path: "/private-marker.md", content: "private marker\n" }],
			});
			const otherId = await get_seeded_node_id(other, "/private-marker.md");
			const ownId = await get_seeded_node_id(runner, "/docs/readme.md");
			const unavailable = await runner.run("resolve 'missing'");

			for (const reference of [
				otherId,
				`https://app.example/w/other/elsewhere/files?nodeId=${otherId}`,
				`https://app.example/w/other/elsewhere/files?nodeId=${ownId}`,
				"https://app.example/w/other/elsewhere/files/docs/readme.md",
			]) {
				const result = await runner.run(`resolve '${reference}'`);
				expect(result.metadata.exitCode, result.stderr).toBe(1);
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe(unavailable.stderr);
				expect(result.metadata.observedPaths).toEqual([]);
			}
		});

		test.each([true, false])(
			"works in the app workspace from /tmp with writes enabled: %s",
			async (allowDbFilesMkdir) => {
				const runner = await create_bash_runner({ allowDbFilesMkdir });
				const nodeId = await get_seeded_node_id(runner, "/docs/readme.md");
				await runner.t.run((ctx) =>
					ctx.db.patch("files_nodes", nodeId, { writePolicyScopeNodeId: nodeId, writePolicy: { mode: "read_only" } }),
				);

				const result = await runner.run(`cd /tmp && resolve '${nodeId}'`);

				expect(result.metadata.exitCode, result.stderr).toBe(0);
				expect(result.stdout).toBe(`${test_db_files_mount}/docs/readme.md\n`);
				expect(result.metadata.nextCwd).toBe("/tmp");
				expect(await list_pending_updates(runner)).toEqual([]);
			},
		);

		test("keeps spaces in quoted substitution and works in a nested shell", async () => {
			const runner = await create_bash_runner({
				extraFiles: [{ path: "/docs/Space name.md", content: "space marker\n" }],
			});
			const nodeId = await get_seeded_node_id(runner, "/docs/Space name.md");

			const read = await runner.run(`p=$(resolve '${nodeId}') && cat "$p"`);
			const nested = await runner.run(`bash -lc 'resolve "${nodeId}"'`);

			expect(read.metadata.exitCode, read.stderr).toBe(0);
			expect(read.stdout).toBe("space marker\n");
			expect(nested.metadata.exitCode, nested.stderr).toBe(0);
			expect(nested.stdout).toBe(`${test_db_files_mount}/docs/Space name.md\n`);
			expect(nested.metadata.observedPaths).toEqual(["/docs/Space name.md"]);
		});

		test("sees chained moves in the same call and follows discard and accept", async () => {
			const runner = await create_bash_runner();
			const nodeId = await get_seeded_node_id(runner, "/docs/tutorial.md");
			const moved = await runner.run(
				`mv docs/tutorial.md docs/guide.md >/dev/null && resolve '${nodeId}' && ` +
					`mv docs/guide.md reports/manual.md >/dev/null && p=$(resolve '${nodeId}') && cat "$p"`,
			);
			expect(moved.metadata.exitCode, moved.stderr).toBe(0);
			expect(moved.stdout).toBe(`${test_db_files_mount}/docs/guide.md\nzeta\nalpha\nALPHA\n`);
			expect((await get_seeded_node(runner, "/docs/tutorial.md"))._id).toBe(nodeId);

			const discarded = await runner_as_user(runner).mutation(
				api.files_pending_updates.discard_file_pending_structural,
				await pending_review_for_test(runner, nodeId),
			);
			expect(discarded._nay).toBeUndefined();
			expect((await runner.run(`resolve '${nodeId}'`)).stdout).toBe(`${test_db_files_mount}/docs/tutorial.md\n`);
			expect((await runner.run("mv docs/tutorial.md reports/manual.md")).metadata.exitCode).toBe(0);
			const accepted = await runner_as_user(runner).mutation(
				api.files_pending_updates.apply_file_pending_move,
				await pending_review_for_test(runner, nodeId),
			);
			expect(accepted._nay).toBeUndefined();
			expect((await get_seeded_node(runner, "/reports/manual.md"))._id).toBe(nodeId);
			expect((await runner.run(`resolve '${nodeId}'`)).stdout).toBe(`${test_db_files_mount}/reports/manual.md\n`);
		});

		test("follows pending ancestor moves for folder and child IDs", async () => {
			const runner = await create_bash_runner();
			const folderId = await get_seeded_node_id(runner, "/docs/nested");
			const childId = await get_seeded_node_id(runner, "/docs/nested/deep.md");
			expect((await runner.run("mv docs/nested reports/notes")).metadata.exitCode).toBe(0);

			const folder = await runner.run(`resolve '${folderId}'`);
			const child = await runner.run(`resolve '${childId}'`);

			expect(folder.metadata.exitCode, folder.stderr).toBe(0);
			expect(folder.stdout).toBe(`${test_db_files_mount}/reports/notes\n`);
			expect(child.metadata.exitCode, child.stderr).toBe(0);
			expect(child.stdout).toBe(`${test_db_files_mount}/reports/notes/deep.md\n`);
			expect(child.metadata.observedPaths).toEqual(["/reports/notes/deep.md"]);
		});

		test("keeps a saved path URL attached to its original node during a pending swap", async () => {
			const runner = await create_bash_runner();
			for (const command of [
				"mv docs/tutorial.md swap.md",
				"mv reports/summary.md docs/tutorial.md",
				"mv swap.md reports/summary.md",
			]) {
				const moved = await runner.run(command);
				expect(moved.metadata.exitCode, moved.stderr).toBe(0);
			}

			const result = await runner.run("resolve 'https://app.example/w/personal/home/files/docs/tutorial.md'");

			expect(result.metadata.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toBe(`${test_db_files_mount}/reports/summary.md\n`);
			expect(result.metadata.observedPaths).toEqual(["/reports/summary.md"]);
			expect((await runner.run(`cat '${result.stdout.trimEnd()}'`)).stdout).toBe("zeta\nalpha\nALPHA\n");
		});

		test("does not turn a replaced target ID or saved URL into its replacement", async () => {
			const runner = await create_bash_runner();
			const sourceId = await get_seeded_node_id(runner, "/docs/tutorial.md");
			const targetId = await get_seeded_node_id(runner, "/reports/summary.md");
			expect((await runner.run("mv -f docs/tutorial.md reports/summary.md")).metadata.exitCode).toBe(0);
			const unavailable = await runner.run("resolve 'missing'");

			for (const reference of [targetId, "https://app.example/w/personal/home/files/reports/summary.md"]) {
				const result = await runner.run(`resolve '${reference}'`);
				expect(result.metadata.exitCode, result.stderr).toBe(1);
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe(unavailable.stderr);
				expect(result.metadata.observedPaths).toEqual([]);
			}
			expect((await runner.run(`resolve '${sourceId}'`)).stdout).toBe(`${test_db_files_mount}/reports/summary.md\n`);
		});

		test("hides a pending-deleted folder but keeps a child moved out of it", async () => {
			const runner = await create_bash_runner({
				extraFiles: [{ path: "/docs/nested/hidden.md", content: "hidden marker\n" }],
			});
			const folderId = await get_seeded_node_id(runner, "/docs/nested");
			const hiddenId = await get_seeded_node_id(runner, "/docs/nested/hidden.md");
			const childId = await get_seeded_node_id(runner, "/docs/nested/deep.md");
			expect((await runner.run("mv docs/nested/deep.md reports/survivor.md")).metadata.exitCode).toBe(0);
			expect((await runner.run("rm -r docs/nested")).metadata.exitCode).toBe(0);

			for (const nodeId of [folderId, hiddenId]) {
				const result = await runner.run(`resolve '${nodeId}'`);
				expect(result.metadata.exitCode, result.stderr).toBe(1);
				expect(result.stdout).toBe("");
				expect(result.metadata.observedPaths).toEqual([]);
			}
			expect((await runner.run(`resolve '${childId}'`)).stdout).toBe(`${test_db_files_mount}/reports/survivor.md\n`);
			const discarded = await runner_as_user(runner).mutation(
				api.files_pending_updates.discard_file_pending_structural,
				await pending_review_for_test(runner, folderId),
			);
			expect(discarded._nay).toBeUndefined();
			expect((await runner.run(`resolve '${hiddenId}'`)).stdout).toBe(`${test_db_files_mount}/docs/nested/hidden.md\n`);
		});

		test("is discoverable through which without adding a native executable", async () => {
			const { run } = await create_bash_runner();

			const which = await run("which resolve");
			const nativePaths = await run("du -a /usr/bin");

			expect(which.metadata.exitCode, which.stderr).toBe(0);
			expect(which.stdout).toBe("/usr/bin/resolve\n");
			expect(nativePaths.metadata.exitCode, nativePaths.stderr).toBe(0);
			expect(nativePaths.stdout).not.toContain("/usr/bin/resolve");
		});
	});

	test("caps the number of app files a single reader command fetches", async () => {
		const { run, runAction } = await create_bash_runner();

		const overCapFiles = Array.from(
			{ length: bash_READER_FILE_OPERAND_MAX + 1 },
			(_, index) => `${test_db_files_mount}/doc-${index}.md`,
		).join(" ");
		const atCapFiles = Array.from(
			{ length: bash_READER_FILE_OPERAND_MAX },
			(_, index) => `${test_db_files_mount}/doc-${index}.md`,
		).join(" ");

		// The over-cap reads must short-circuit before any content fetch, so assert no
		// runAction before any later run (the at-cap cat below legitimately fetches content).
		const overCap = await run(`cat ${overCapFiles}`);
		expect(overCap.metadata.exitCode).toBe(2);
		expect(overCap.stderr).toContain(
			`cat: db-backed file reads are limited to ${bash_READER_FILE_OPERAND_MAX} files per command`,
		);
		expect(overCap.stderr).toContain(`you requested ${bash_READER_FILE_OPERAND_MAX + 1}`);
		expect(runAction).not.toHaveBeenCalled();

		const headOverCap = await run(`head ${overCapFiles}`);
		const wcOverCap = await run(`wc -l ${overCapFiles}`);
		const statOverCap = await run(`stat ${overCapFiles}`);
		const atCap = await run(`cat ${atCapFiles}`);

		expect(headOverCap.metadata.exitCode).toBe(2);
		expect(headOverCap.stderr).toContain(`head: db-backed file reads are limited to ${bash_READER_FILE_OPERAND_MAX}`);
		expect(wcOverCap.metadata.exitCode).toBe(2);
		expect(wcOverCap.stderr).toContain(`wc: db-backed file reads are limited to ${bash_READER_FILE_OPERAND_MAX}`);
		expect(statOverCap.metadata.exitCode).toBe(2);
		expect(statOverCap.stderr).toContain(`stat: db-backed file reads are limited to ${bash_READER_FILE_OPERAND_MAX}`);
		expect(atCap.stderr).not.toContain("db-backed file reads are limited");
	});

	test("counts only db-file operands toward the reader cap, not /tmp scratch", async () => {
		const { run } = await create_bash_runner();

		const tmpFiles = Array.from({ length: 20 }, (_, index) => `/tmp/scratch-${index}.txt`).join(" ");
		const dbFileOperands = Array.from(
			{ length: bash_READER_FILE_OPERAND_MAX + 1 },
			(_, index) => `${test_db_files_mount}/doc-${index}.md`,
		).join(" ");

		const result = await run(`cat ${tmpFiles} ${dbFileOperands}`);

		expect(result.metadata.exitCode).toBe(2);
		expect(result.stderr).toContain(`you requested ${bash_READER_FILE_OPERAND_MAX + 1}`);
	});

	test("pages large files smoothly: cat/head/sed/tail return bounded pages with hints, wc reports counts", async () => {
		const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
		const bigPath = `${test_db_files_mount}/big.md`;

		const catResult = await run(`cat ${bigPath}`);
		const wcResult = await run(`wc -l ${bigPath}`);
		const headResult = await run(`head -n 3 ${bigPath}`);
		const sedResult = await run(`sed -n '4,6p' ${bigPath}`);
		const tailResult = await run(`tail -n 3 ${bigPath}`);
		const headOverCap = await run(`head -n 9999 ${bigPath}`);
		const smallStillWorks = await run(`cat ${test_db_files_mount}/docs/readme.md`);

		// cat no longer refuses: it returns a bounded first page on stdout, with the advisory
		// on stderr so it never contaminates a pipe.
		expect(catResult.metadata.exitCode).toBe(0);
		expect(catResult.stdout).toContain("line 1\nline 2");
		expect(catResult.stdout).not.toContain("showing the first");
		expect(catResult.stderr).toContain(`showing the first ${bash_READ_HEAD_LARGE_FILE_MAX_LINES} lines`);
		expect(catResult.stderr).toContain(
			`sed -n '${bash_READ_HEAD_LARGE_FILE_MAX_LINES + 1},${bash_READ_HEAD_LARGE_FILE_MAX_LINES * 2}p' ${bigPath}`,
		);
		// wc reports the line count (so the agent knows the size).
		expect(wcResult.metadata.exitCode).toBe(0);
		expect(wcResult.stdout).toContain(`1000 ${bigPath}`);
		// head reads first N lines and puts the next-page command on stderr.
		expect(headResult.metadata.exitCode).toBe(0);
		expect(headResult.stdout).toContain("line 1\nline 2\nline 3\n");
		expect(headResult.stderr).toContain(`Next page: sed -n '4,6p' ${bigPath}`);
		// sed -n 'A,Bp' reads that exact range and puts its continuation on stderr.
		expect(sedResult.metadata.exitCode).toBe(0);
		expect(sedResult.stdout).toContain("line 4\nline 5\nline 6\n");
		expect(sedResult.stderr).toContain(`Next page: sed -n '7,9p' ${bigPath}`);
		// tail reads the last N lines and puts the partial-view note on stderr.
		expect(tailResult.metadata.exitCode).toBe(0);
		expect(tailResult.stdout).toContain("line 998\nline 999\nline 1000\n");
		expect(tailResult.stderr).toContain("tail: showing the last 3 lines");
		expect(tailResult.stderr).toContain(`head -n 3 ${bigPath}`);
		// head -n beyond the per-page cap clamps (no refusal) and notes it.
		expect(headOverCap.metadata.exitCode).toBe(0);
		expect(headOverCap.stderr).toContain(`showing ${bash_READ_HEAD_LARGE_FILE_MAX_LINES} lines (per-page cap)`);
		// Files under the cap are unaffected.
		expect(smallStillWorks.metadata.exitCode).toBe(0);
		expect(smallStillWorks.stdout).toContain("# Readme");
	});

	test("cat reads a complete 64 KiB skill with more than 500 lines", async () => {
		const prefix = "---\nname: complete\ndescription: Read the whole file.\n---\n";
		const lines = "instruction\n".repeat(600);
		const content = `${prefix}${lines}${"x".repeat(64 * 1024 - prefix.length - lines.length - 8)}THE_END\n`;
		const { run } = await create_bash_runner({
			extraFiles: [{ path: "/.agents/skills/complete/SKILL.md", content }],
		});

		const result = await run("cat .agents/skills/complete/SKILL.md");

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe(content);
		expect(result.metadata.stdoutTruncated).toBe(false);
		expect(result.stderr).toBe("");
	});

	test("records only command paths without cwd maintenance or listed descendants", async () => {
		const { run } = await create_bash_runner({ initialCwd: `${test_db_files_mount}/docs` });

		const read = await run(`cat ${test_db_files_mount}/reports/summary.md`);
		const listed = await run(`ls ${test_db_files_mount}/reports`);

		expect(read.metadata.observedPaths).toContain("/reports/summary.md");
		expect(read.metadata.observedPaths).not.toContain("/docs");
		expect(listed.metadata.observedPaths).toContain("/reports");
		expect(listed.metadata.observedPaths).not.toContain("/reports/summary.md");
	});

	test.each([
		"false && value=$(cat reports/missing.md); echo done",
		"bash -c 'false && value=$(cat reports/missing.md); echo done'",
		"printf '%s\\n' 'false && value=$(cat reports/missing.md); echo done' | xargs -I {} bash -c '{}'",
	])("does not record paths probed by shell safety checks: %s", async (command) => {
		const { run } = await create_bash_runner();

		const result = await run(`cat docs/readme.md > /tmp/read; ${command}`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe("done\n");
		expect(result.metadata.observedPaths).toContain("/docs/readme.md");
		expect(result.metadata.observedPaths).not.toContain("/reports/missing.md");
	});

	test("follows byte-limited pages without losing file lines", async () => {
		const content = Array.from({ length: 600 }, (_, index) => `${index}: ${"é".repeat(200)}\n`).join("");
		const { run } = await create_bash_runner({ extraFiles: [{ path: "/pages.txt", content }] });
		let command = "cat pages.txt";
		let combined = "";
		for (let page = 0; page < 10; page++) {
			const result = await run(command);
			expect(result.metadata.exitCode).toBe(0);
			expect(new TextEncoder().encode(result.stdout).byteLength).toBeLessThanOrEqual(64 * 1024);
			combined += result.stdout;
			const next = /Next page: (sed[^\n]+)/.exec(result.stderr)?.[1];
			if (!next) break;
			command = next;
		}
		expect(combined).toBe(content);
	});

	test("prefix reads keep UTF-8 characters whole and see pending content", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/prefix.txt", content: "head ééé tail", nonCollaborative: true }],
		});
		const read = () =>
			runner.t.query(internal.files_nodes.read_file_content_from_chunks, {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				userId: runner.seeded.userId,
				overlayUserId: runner.seeded.userId,
				path: "/prefix.txt",
				mode: { kind: "prefix", maxBytes: 8 },
			});

		expect(await read()).toMatchObject({ content: "head é", moreLines: true, pendingUpdateId: null });
		const write = await runner.run("printf 'edit ééé tail' > prefix.txt");
		expect(write.metadata.exitCode).toBe(0);
		const pending = await read();
		expect(pending).toMatchObject({ content: "edit é", moreLines: true });
		expect(pending?.pendingUpdateId).not.toBeNull();
	});

	test("large cat uses query-only chunk line range reads", async () => {
		const { run, runQuery, runAction } = await create_bash_runner({ extraFiles: [big_md_file] });
		const bigPath = `${test_db_files_mount}/big.md`;

		const result = await run(`cat ${bigPath}`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("line 1\nline 2");
		expect(result.stderr).toContain(`showing the first ${bash_READ_HEAD_LARGE_FILE_MAX_LINES} lines`);
		expect(
			runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:read_file_content_from_chunks"),
		).toBe(true);
		expect(runAction.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:read_file_line_range")).toBe(
			false,
		);
	});

	test("prints absolute db-files paths in large-file reader continuations", async () => {
		const { run } = await create_bash_runner({ initialCwd: test_db_files_mount, extraFiles: [big_md_file] });
		const bigPath = `${test_db_files_mount}/big.md`;

		const catResult = await run("cat big.md");
		const headResult = await run("head -n 3 big.md");
		const tailForwardResult = await run("tail -n +5 big.md");
		const sedResult = await run("sed -n '4,6p' big.md");
		const tailResult = await run("tail -n 3 big.md");

		expect(catResult.stderr).toContain(
			`sed -n '${bash_READ_HEAD_LARGE_FILE_MAX_LINES + 1},${bash_READ_HEAD_LARGE_FILE_MAX_LINES * 2}p' ${bigPath}`,
		);
		expect(headResult.stderr).toContain(`Next page: sed -n '4,6p' ${bigPath}`);
		expect(tailForwardResult.stderr).toContain(
			`Next page: sed -n '${5 + bash_READ_HEAD_LARGE_FILE_MAX_LINES},${5 + bash_READ_HEAD_LARGE_FILE_MAX_LINES * 2 - 1}p' ${bigPath}`,
		);
		expect(sedResult.stderr).toContain(`Next page: sed -n '7,9p' ${bigPath}`);
		expect(tailResult.stderr).toContain(`head -n 3 ${bigPath}`);
	});

	test("does not emit precise reader continuations when the bounded scan is truncated", async () => {
		// Unmaterialized (no chunks) so reads fall back to the bounded leading window, with lines
		// so long the window holds fewer lines than each command requests → scanTruncated.
		const { run } = await create_bash_runner({
			extraFiles: [
				{
					path: "/big.md",
					content: `${"A".repeat(49999)}\n${"B".repeat(49999)}\n${"C".repeat(2000)}`,
					materialized: false,
				},
			],
		});
		const bigPath = `${test_db_files_mount}/big.md`;

		const headResult = await run(`head -n 3 ${bigPath}`);
		const tailForwardResult = await run(`tail -n +5 ${bigPath}`);
		const sedResult = await run(`sed -n '5,9p' ${bigPath}`);

		for (const result of [headResult, tailForwardResult, sedResult]) {
			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).not.toContain("Next page:");
			expect(result.stderr).toContain("only");
		}
	});

	test("supports obsolete head and tail line-count flags on large files", async () => {
		const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
		const bigPath = `${test_db_files_mount}/big.md`;

		const headResult = await run(`head -5 ${bigPath}`);
		const tailResult = await run(`tail -3 ${bigPath}`);

		expect(headResult.metadata.exitCode).toBe(0);
		expect(headResult.stdout).toContain("line 1\nline 2\nline 3\nline 4\nline 5\n");
		expect(headResult.stderr).toContain(`Next page: sed -n '6,10p' ${bigPath}`);
		expect(tailResult.metadata.exitCode).toBe(0);
		expect(tailResult.stdout).toContain("line 998\nline 999\nline 1000\n");
		expect(tailResult.stderr).toContain(`head -n 3 ${bigPath}`);
	});

	test("rejects missing and invalid head and tail line counts", async () => {
		const { run } = await create_bash_runner();
		const readmePath = `${test_db_files_mount}/docs/readme.md`;

		const missingHead = await run("head -n");
		const invalidHead = await run(`head -n nope ${readmePath}`);
		const missingTail = await run("tail --lines");
		const invalidTail = await run(`tail --lines=nope ${readmePath}`);

		expect(missingHead.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(missingHead.stderr).toContain("head: -n requires a value");
		expect(invalidHead.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(invalidHead.stderr).toContain("head: -n must be an integer line count");
		expect(missingTail.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(missingTail.stderr).toContain("tail: --lines requires a value");
		expect(invalidTail.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(invalidTail.stderr).toContain("tail: --lines must be an integer line count");
		for (const result of [missingHead, invalidHead, missingTail, invalidTail]) {
			expect(result.stderr).toContain("Usage:");
		}
	});

	test("supports head tail and wc end-of-options markers for app operands", async () => {
		const { run } = await create_bash_runner({
			initialCwd: test_db_files_mount,
			extraFiles: [{ path: "/-reader.md", content: "dash reader\n" }],
		});

		const headResult = await run("head -n 1 -- -reader.md");
		const tailResult = await run("tail -n +1 -- -reader.md");
		const wcResult = await run("wc -c -- -reader.md");

		expect(headResult.metadata.exitCode).toBe(0);
		expect(headResult.stdout).toBe("dash reader\n");
		expect(tailResult.metadata.exitCode).toBe(0);
		expect(tailResult.stdout).toBe("dash reader\n");
		expect(wcResult.metadata.exitCode).toBe(0);
		expect(wcResult.stdout).toContain(`12 -reader.md`);
	});

	test("rejects byte-range reads for oversized app files with explicit guidance", async () => {
		const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
		const bigPath = `${test_db_files_mount}/big.md`;

		const headResult = await run(`head -c 100 ${bigPath}`);
		const tailResult = await run(`tail -c 100 ${bigPath}`);

		expect(headResult.metadata.exitCode).toBe(1);
		expect(headResult.stderr).toContain("byte-range reads (-c) are not supported for large app files");
		expect(headResult.stderr).toContain(`wc -c ${bigPath}`);
		expect(tailResult.metadata.exitCode).toBe(1);
		expect(tailResult.stderr).toContain("byte-range reads (-c) are not supported for large app files");
		expect(tailResult.stderr).toContain(`wc -c ${bigPath}`);
	});

	test("does not drop non-app operands when a mixed reader command includes a large app file", async () => {
		const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
		const bigPath = `${test_db_files_mount}/big.md`;

		await run("printf tmp > /tmp/reader-mixed.txt");
		const result = await run(`head -n 3 ${bigPath} /tmp/reader-mixed.txt`);

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("over the");
		expect(result.stderr).toContain("inline read limit");
	});

	test("wc over one app file uses the bounded stats path", async () => {
		const { run, runAction } = await create_bash_runner({
			extraFiles: [{ path: "/wc/single.md", content: "on two\nthree\nfour x\n" }],
		});

		const result = await run(`wc ${test_db_files_mount}/wc/single.md`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain(`3 5 20 ${test_db_files_mount}/wc/single.md`);
		const statsCalls = runAction.mock.calls.filter((call) => {
			const actionArgs = call[1];
			return (
				actionArgs && typeof actionArgs === "object" && "path" in actionArgs && actionArgs.path === "/wc/single.md"
			);
		});
		expect(statsCalls).toHaveLength(1);
	});

	test("wc over multiple app files reports per-file counts plus a total via the bounded stats path", async () => {
		const { run, runAction } = await create_bash_runner({
			extraFiles: [
				{ path: "/wc/a.md", content: "on two\nthree\nfour x\n" },
				{ path: "/wc/b.md", content: "abc cd\nef g\n" },
			],
		});

		const result = await run(`wc ${test_db_files_mount}/wc/a.md ${test_db_files_mount}/wc/b.md`);

		expect(result.metadata.exitCode).toBe(0);
		// Default triad (lines words bytes) per file, then a summed total line.
		expect(result.stdout).toContain(`3 5 20 ${test_db_files_mount}/wc/a.md`);
		expect(result.stdout).toContain(`2 4 12 ${test_db_files_mount}/wc/b.md`);
		expect(result.stdout).toContain("5 9 32 total");
		// Each file is counted via the bounded stats action — never a full content read.
		const statsCalls = runAction.mock.calls.filter((call) => {
			const actionArgs = call[1];
			return (
				actionArgs &&
				typeof actionArgs === "object" &&
				"path" in actionArgs &&
				(actionArgs.path === "/wc/a.md" || actionArgs.path === "/wc/b.md")
			);
		});
		expect(statsCalls).toHaveLength(2);

		// -l restricts the columns to the line count; the total still sums.
		const linesOnly = await run(`wc -l ${test_db_files_mount}/wc/a.md ${test_db_files_mount}/wc/b.md`);
		expect(linesOnly.metadata.exitCode).toBe(0);
		expect(linesOnly.stdout).toContain(`3 ${test_db_files_mount}/wc/a.md`);
		expect(linesOnly.stdout).toContain(`2 ${test_db_files_mount}/wc/b.md`);
		expect(linesOnly.stdout).toContain("5 total");

		const combinedLinesWords = await run(`wc -lw ${test_db_files_mount}/wc/a.md ${test_db_files_mount}/wc/b.md`);
		expect(combinedLinesWords.metadata.exitCode).toBe(0);
		expect(combinedLinesWords.stdout).toContain(`3 5 ${test_db_files_mount}/wc/a.md`);
		expect(combinedLinesWords.stdout).toContain(`2 4 ${test_db_files_mount}/wc/b.md`);
		expect(combinedLinesWords.stdout).toContain("5 9 total");

		const combinedCharsBytes = await run(`wc -mc ${test_db_files_mount}/wc/a.md ${test_db_files_mount}/wc/b.md`);
		expect(combinedCharsBytes.metadata.exitCode).toBe(0);
		expect(combinedCharsBytes.stdout).toContain(`20 20 ${test_db_files_mount}/wc/a.md`);
		expect(combinedCharsBytes.stdout).toContain(`12 12 ${test_db_files_mount}/wc/b.md`);
		expect(combinedCharsBytes.stdout).toContain("32 32 total");
	});

	test("multi-file wc flags windowed lower bounds and reports missing operands without aborting", async () => {
		// Unmaterialized 12000-byte file with exactly 40 newlines inside the 8192-byte scan
		// window (40 × 204B lines, then one long unterminated line), so counts are lower bounds.
		const { run } = await create_bash_runner({
			extraFiles: [
				{
					path: "/wc/windowed.md",
					content: `${`${"x".repeat(203)}\n`.repeat(40)}${"y".repeat(3840)}`,
					materialized: false,
				},
			],
		});

		const result = await run(`wc -l ${test_db_files_mount}/wc/windowed.md ${test_db_files_mount}/wc/missing.md`);

		// A missing operand reports an error and exit 1, but the readable file still counts.
		expect(result.metadata.exitCode).toBe(1);
		expect(result.stderr).toContain(`wc: ${test_db_files_mount}/wc/missing.md: No such file or directory`);
		expect(result.stdout).toContain(`40 ${test_db_files_mount}/wc/windowed.md`);
		expect(result.stdout).toContain("40 total");
		// The windowed file makes line/word/char counts lower bounds (bytes stay exact).
		expect(result.stderr).toContain("lower bounds");
	});

	test("multi-file wc uses the readable-sibling advisory for unreadable app operands", async () => {
		const { run } = await create_bash_runner({
			extraFiles: [{ path: "/wc/a.md", content: "on two\nthree\nfour x\n" }],
		});

		const result = await run(`wc ${test_db_files_mount}/wc/a.md ${test_db_files_mount}/source.pdf`);

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toContain(`3 5 20 ${test_db_files_mount}/wc/a.md`);
		expect(result.stdout).toContain("3 5 20 total");
		expect(result.stderr).toContain("Bash can read editable text files only");
		expect(result.stderr).toContain(`${test_db_files_mount}/source.pdf.md`);
		expect(result.stderr).toContain(`stat -c %s ${test_db_files_mount}/source.pdf`);
	});

	test("tail -n +K reads forward from line K on a large file (not the trailing window)", async () => {
		const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
		const bigPath = `${test_db_files_mount}/big.md`;

		const result = await run(`tail -n +5 ${bigPath}`);

		expect(result.metadata.exitCode).toBe(0);
		// Forward read from line 5 (not the last lines), bounded to the per-page cap.
		expect(result.stdout).toContain("line 5\nline 6\nline 7\n");
		expect(result.stdout).not.toContain("line 1000");
		// Forward continuation page via sed, anchored at the offset.
		expect(result.stderr).toContain(
			`sed -n '${5 + bash_READ_HEAD_LARGE_FILE_MAX_LINES},${5 + bash_READ_HEAD_LARGE_FILE_MAX_LINES * 2 - 1}p' ${bigPath}`,
		);
	});

	test("cat refuses a multi-file concatenation when a member is too large to inline", async () => {
		const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
		const bigPath = `${test_db_files_mount}/big.md`;
		const smallPath = `${test_db_files_mount}/docs/readme.md`;

		const result = await run(`cat ${bigPath} ${smallPath}`);

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stderr).toContain("too large to concatenate");
		// Nothing from the small file is emitted: the refusal happens up front.
		expect(result.stdout).not.toContain("# Readme");
	});

	test("piping a large cat keeps the advisory out of the pipe", async () => {
		const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
		const bigPath = `${test_db_files_mount}/big.md`;

		const result = await run(`cat ${bigPath} | cat`);

		// The footer is on stderr, so only the file content flows downstream.
		expect(result.stdout).toContain("line 1");
		expect(result.stdout).not.toContain("showing the first");
	});

	test("large cat reports chunk-unavailable files on stderr only", async () => {
		const { run, runAction } = await create_bash_runner({
			extraFiles: [
				{
					path: "/chunk-unavailable.md",
					content: big_md_file.content,
					materialized: false,
				},
			],
		});
		const bigPath = `${test_db_files_mount}/chunk-unavailable.md`;

		const result = await run(`cat ${bigPath} | grep materialized`);

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("content is not available from materialized chunks");
		expect(runAction.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:read_file_line_range")).toBe(
			false,
		);
	});

	test("large cat oversize gate uses unsaved edit size, not the committed asset", async () => {
		// Simulates the agent's own large write_file/edit_file edit living in files_pending_updates:
		// the committed asset is tiny, but the current unsaved edit is large. The gate must
		// fire on the edit size, otherwise a multi-MB draft would be pulled inline unguarded.
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/draft.md", content: "tiny base\n", withRealYjsSnapshot: true }],
		});
		const draftNodeId = await get_seeded_node_id(runner, "/draft.md");
		await upsert_pending_update_for_test(runner, {
			target: { kind: "saved", id: draftNodeId },
			unstagedText: Array.from(
				{ length: 400 },
				(_, index) => `line ${index + 1}${index === 300 ? "x".repeat(bash_READ_INLINE_MAX_BYTES) : ""}`,
			).join("\n\n"),
		});
		const pendingUpdate = await runner.t.query(internal.files_pending_updates.get_by_file_node, {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId: runner.seeded.userId,
			fileNodeId: draftNodeId,
		});
		if (pendingUpdate?.size == null) {
			throw new Error("expected pending update size to be set for /draft.md");
		}
		expect(pendingUpdate.size).toBeGreaterThan(bash_READ_INLINE_MAX_BYTES);
		const draftPath = `${test_db_files_mount}/draft.md`;
		runner.runQuery.mockClear();
		runner.runAction.mockClear();

		const result = await runner.run(`cat ${draftPath}`);

		// Gate fired on the unsaved edit size: bounded page on stdout, advisory carrying
		// that byte count on stderr — even though the committed asset is only 10 bytes.
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("line 1\n\nline 2");
		expect(result.stderr).toContain(`is ${pendingUpdate.size} bytes`);
		expect(
			runner.runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:read_file_content_from_chunks"),
		).toBe(true);
		expect(
			runner.runAction.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:read_file_line_range"),
		).toBe(false);
		expect(runner.runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "r2:get_asset_by_id")).toBe(false);
	});

	test("large cat oversize gate still fires behind a pure move", async () => {
		const runner = await create_bash_runner({ extraFiles: [big_md_file] });

		const moved = await runner.run(`mv ${test_db_files_mount}/big.md ${test_db_files_mount}/renamed-big.md`);
		expect(moved.metadata.exitCode).toBe(0);

		// The move-only pending update doc stores size 0; both cat gates must keep using the committed asset size.
		const multi = await runner.run(`cat ${test_db_files_mount}/renamed-big.md ${test_db_files_mount}/docs/readme.md`);
		expect(multi.metadata.exitCode).toBe(1);
		expect(multi.stderr).toContain("too large to concatenate");
		expect(multi.stdout).not.toContain("# Readme");

		const single = await runner.run(`cat ${test_db_files_mount}/renamed-big.md`);
		expect(single.metadata.exitCode).toBe(0);
		expect(single.stdout).toContain("line 1\n");
		expect(single.stderr).toContain("showing the first");
	});

	test("sed app line-range fast path supports -- and unreadable source advisories", async () => {
		const { run } = await create_bash_runner();
		const readmePath = `${test_db_files_mount}/docs/readme.md`;

		const appResult = await run(`sed -n -- '1p' ${readmePath}`);
		const tmpResult = await run("printf 'one\\ntwo\\n' > /tmp/sed.txt && sed -n '2p' /tmp/sed.txt");
		const unreadableResult = await run(`sed -n '1p' ${test_db_files_mount}/source.pdf`);
		const zeroResult = await run(`sed -n '0p' ${readmePath}`);
		const negativeResult = await run(`sed -n '-1p' ${readmePath}`);
		const folderResult = await run(`sed -n '1p' ${test_db_files_mount}/docs`);
		const rootResult = await run(`sed -n '1p' ${test_db_files_mount}`);

		expect(appResult.metadata.exitCode).toBe(0);
		expect(appResult.stdout).toBe("# Readme\n");
		expect(tmpResult.metadata.exitCode).toBe(0);
		expect(tmpResult.stdout).toBe("two\n");
		expect(unreadableResult.metadata.exitCode).toBe(1);
		expect(unreadableResult.stderr).toContain("Bash can read editable text files only");
		expect(unreadableResult.stderr).toContain(`${test_db_files_mount}/source.pdf.md`);
		expect(unreadableResult.stderr).not.toContain("No such file or directory");
		for (const result of [zeroResult, negativeResult]) {
			expect(result.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
			expect(result.stderr).toContain("invalid line range");
		}
		for (const result of [folderResult, rootResult]) {
			expect(result.metadata.exitCode).toBe(1);
			expect(result.stderr).toContain("Is a directory");
		}
	});

	test("allows app exact reads through stream utilities but rejects direct app operands", async () => {
		const { run } = await create_bash_runner({
			extraFiles: [{ path: "/docs/dupes.md", content: "alpha\nzeta\nalpha\n" }],
		});

		const pipeline = await run(
			[
				`cat ${test_db_files_mount}/docs/dupes.md | sort | uniq -c`,
				`cat ${test_db_files_mount}/docs/nested/deep.md | cut -d ':' -f 2`,
				`cat ${test_db_files_mount}/docs/readme.md | sed 's/Readme/Guide/'`,
				`cat ${test_db_files_mount}/docs/readme.md | awk '{print $1}'`,
			].join(" && "),
		);
		const directSort = await run(`sort ${test_db_files_mount}/docs/tutorial.md`);
		const directSed = await run(`sed 's/a/b/' ${test_db_files_mount}/docs/tutorial.md`);
		const directAwk = await run(`awk '{print $1}' ${test_db_files_mount}/docs/tutorial.md`);

		expect(pipeline.metadata.exitCode).toBe(0);
		expect(pipeline.stdout).toContain("2 alpha");
		expect(pipeline.stdout).toContain("two");
		expect(pipeline.stdout).toContain("# Guide");
		expect(pipeline.stdout).toContain("#");
		expect(directSort.metadata.exitCode).not.toBe(0);
		expect(directSort.stderr).toContain("db-backed");
		expect(directSort.stderr).toContain("pipe it through cat");
		expect(directSed.metadata.exitCode).not.toBe(0);
		expect(directSed.stderr).toContain("db-backed");
		expect(directSed.stderr).toContain("pipe it through cat");
		expect(directAwk.metadata.exitCode).not.toBe(0);
		expect(directAwk.stderr).toContain("db-backed");
		expect(directAwk.stderr).toContain("pipe it through cat");
	});

	test("does not falsely reject a sed script that merely contains the mount path text", async () => {
		const { run } = await create_bash_runner();

		// The mount path appears inside the sed SCRIPT, not as a file operand; piping via cat
		// must run, not be rejected by an over-broad substring guard.
		const result = await run(`cat ${test_db_files_mount}/docs/readme.md | sed 's|${test_db_files_mount}|X|'`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("# Readme");
		expect(result.stderr).not.toContain("cannot be used as direct operands");
		expect(result.stderr).not.toContain("Native Just Bash /tmp commands cannot access app files directly");
	});

	test("rejects unsupported app mutations and prevents mixed /tmp partial side effects", async () => {
		const { run } = await create_bash_runner({
			initialCwd: test_db_files_mount,
			extraFiles: [{ path: "/-delete.md", content: "dash delete\n" }],
		});

		const touchReferenceResult = await run(`touch -r ${test_db_files_mount}/docs/readme.md /tmp/from-ref`);
		const cpAppDestResult = await run("printf copy > /tmp/copy-src.txt; cp /tmp/copy-src.txt -- -copy-dest.md");
		const cpAppFolderDestResult = await run(
			`printf copy > /tmp/native-output.md; cp /tmp/native-output.md ${test_db_files_mount}/docs`,
		);
		const mvResult = await run(`mv ${test_db_files_mount}/docs/readme.md /tmp/moved.md; cat /tmp/moved.md`);
		const mvAppDestResult = await run("printf move > /tmp/move-src.txt; mv /tmp/move-src.txt -- -move-dest.md");
		const mvAppDestSource = await run("cat /tmp/move-src.txt");
		const mvAppToAppResult = await run(`mv ${test_db_files_mount}/docs/readme.md renamed.md`);
		const mvGlobResult = await run(`mv '${test_db_files_mount}/docs/*.md' /tmp/moved.md`);
		const mvDashResult = await run("mv -- -delete.md /tmp/moved-dash.md");

		expect(touchReferenceResult.metadata.exitCode).not.toBe(0);
		expect(touchReferenceResult.stderr).toContain("reference file");
		expect(cpAppDestResult.metadata.exitCode).not.toBe(0);
		expect(cpAppDestResult.stderr).toContain("only app files can be copied into the app tree");
		expect(cpAppDestResult.stderr).toContain("cat <scratch-file> > -copy-dest.md");
		expect(cpAppFolderDestResult.metadata.exitCode).not.toBe(0);
		expect(cpAppFolderDestResult.stderr).toContain("only app files can be copied into the app tree");
		expect(cpAppFolderDestResult.stderr).toContain("cat <scratch-file> >");
		expect(mvResult.metadata.exitCode).not.toBe(0);
		expect(mvResult.stderr).toContain("all sources and the destination must be app paths");
		expect(mvResult.stderr).toContain("cp");
		expect(mvAppDestResult.metadata.exitCode).not.toBe(0);
		expect(mvAppDestResult.stderr).toContain("all sources and the destination must be app paths");
		expect(mvAppDestSource.metadata.exitCode).toBe(0);
		expect(mvAppDestSource.stdout).toBe("move");
		// App→app mv is no longer a rejection: it records a pending move proposal.
		expect(mvAppToAppResult.metadata.exitCode).toBe(0);
		expect(mvAppToAppResult.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		expect(mvGlobResult.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(mvGlobResult.stderr).toContain("app file glob patterns are not supported");
		expect(mvGlobResult.stderr).toContain("find");
		expect(mvDashResult.metadata.exitCode).not.toBe(0);
		expect(mvDashResult.stderr).toContain("all sources and the destination must be app paths");
	});

	test.each(["cp", "mv"])("rejects unsupported app %s flags before copy or move work", async (command) => {
		const runner = await create_bash_runner({ initialCwd: test_db_files_mount });
		expect((await runner.run("printf scratch > /tmp/source.txt && mkdir /tmp/target")).metadata.exitCode).toBe(0);

		const app = await runner.run(`${command} -v docs/readme.md new.md`);
		expect(app.metadata.exitCode).toBe(2);
		expect(app.stderr).toBe(`${command}: unsupported option '-v'\n`);
		const mixed = await runner.run(`${command} --unknown /tmp/source.txt docs/readme.md /tmp/target`);
		expect(mixed.metadata.exitCode).toBe(2);
		expect(mixed.stderr).toBe(`${command}: unsupported option '--unknown'\n`);
		expect(await list_pending_updates(runner)).toEqual([]);
		expect((await runner.run("cat new.md")).metadata.exitCode).not.toBe(0);
		expect((await runner.run("ls /tmp/target")).stdout).toBe("");
		expect((await runner.run("cat /tmp/source.txt")).stdout).toBe("scratch");

		// Verbose remains valid when every operand belongs to the native scratch filesystem.
		const scratch = await runner.run(`${command} -v /tmp/source.txt /tmp/native.txt`);
		expect(scratch.metadata.exitCode).toBe(0);
		expect((await runner.run("cat /tmp/native.txt")).stdout).toBe("scratch");
	});

	test("creates a pending delete proposal for an app file and hides it from later reads", async () => {
		const runner = await create_bash_runner();

		const removed = await runner.run(`rm ${test_db_files_mount}/docs/readme.md`);
		expect(removed.metadata.exitCode).toBe(0);
		expect(removed.stderr).toBe("");
		expect(removed.stdout).toBe(
			"pending delete created: /docs/readme.md — archives the file when accepted; review in Files\n",
		);

		const readmeId = await get_seeded_node_id(runner, "/docs/readme.md");
		const rows = await list_pending_updates(runner);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			target: { kind: "saved", id: readmeId },
			pendingArchive: { fromPath: "/docs/readme.md" },
			size: 0,
		});
		expect(rows[0]!.threadIds).toEqual([runner.threadId]);

		// The proposer's later reads see the file as gone; listings drop it too.
		const readBack = await runner.run(`cat ${test_db_files_mount}/docs/readme.md`);
		expect(readBack.metadata.exitCode).not.toBe(0);
		expect(readBack.stderr).toContain("No such file or directory");
		const listing = await runner.run(`ls ${test_db_files_mount}/docs`);
		expect(listing.stdout).not.toContain("readme.md");

		// A second rm behaves like a real fs: the path is already gone.
		const removedAgain = await runner.run(`rm ${test_db_files_mount}/docs/readme.md`);
		expect(removedAgain.metadata.exitCode).not.toBe(0);
		expect(removedAgain.stderr).toBe(
			`rm: cannot remove '${test_db_files_mount}/docs/readme.md': No such file or directory\n`,
		);
		const removedForced = await runner.run(`rm -f ${test_db_files_mount}/docs/readme.md`);
		expect(removedForced.metadata.exitCode).toBe(0);
		expect(removedForced.stdout).toBe("");
		expect(removedForced.stderr).toBe("");
	});

	test("creates a folder delete proposal with -r and mirrors builtin folder errors", async () => {
		const runner = await create_bash_runner();

		const withoutRecursive = await runner.run(`rm ${test_db_files_mount}/docs`);
		expect(withoutRecursive.metadata.exitCode).not.toBe(0);
		expect(withoutRecursive.stderr).toBe(`rm: cannot remove '${test_db_files_mount}/docs': Is a directory\n`);

		const removed = await runner.run(`rm -r ${test_db_files_mount}/docs`);
		expect(removed.metadata.exitCode).toBe(0);
		expect(removed.stderr).toBe("");
		expect(removed.stdout).toBe(
			"pending delete created: /docs — archives the folder and its contents when accepted; review in Files\n",
		);

		const docsId = await get_seeded_node_id(runner, "/docs");
		const rows = await list_pending_updates(runner);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ target: { kind: "saved", id: docsId }, pendingArchive: { fromPath: "/docs" } });

		// The whole subtree reads as gone for the proposer.
		const childRead = await runner.run(`cat ${test_db_files_mount}/docs/tutorial.md`);
		expect(childRead.metadata.exitCode).not.toBe(0);
		expect(childRead.stderr).toContain("No such file or directory");
		const rootListing = await runner.run(`ls ${test_db_files_mount}`);
		expect(rootListing.stdout).not.toContain("docs");
	});

	test("rm on the user's own unaccepted Added file removes it immediately", async () => {
		const runner = await create_bash_runner();

		const created = await runner.run(`printf 'draft\\n' > ${test_db_files_mount}/draft-note.md`);
		expect(created.metadata.exitCode).toBe(0);
		const draft = await get_private_entry(runner, "/draft-note.md");

		const removed = await runner.run(`rm ${test_db_files_mount}/draft-note.md`);
		expect(removed.metadata.exitCode).toBe(0);
		expect(removed.stderr).toBe("");
		expect(removed.stdout).toBe(`removed '${test_db_files_mount}/draft-note.md'\n`);

		// The draft closes immediately. Its bytes are cleaned up in the background.
		expect(await runner.t.run((ctx) => ctx.db.get("files_pending_nodes", draft.node._id))).toMatchObject({
			state: "discarded",
		});
		expect((await runner.run(`cat ${test_db_files_mount}/draft-note.md`)).metadata.exitCode).not.toBe(0);
		const committedNodes = await runner.t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", runner.ctxData.organizationId)
						.eq("workspaceId", runner.ctxData.workspaceId)
						.eq("path", "/draft-note.md"),
				)
				.collect(),
		);
		expect(committedNodes).toHaveLength(0);
	});

	test("handles mixed /tmp and app rm operands in order with builtin flag semantics", async () => {
		const runner = await create_bash_runner();

		const prepared = await runner.run("printf scratch > /tmp/scratch.txt");
		expect(prepared.metadata.exitCode).toBe(0);
		const removed = await runner.run(`rm -v /tmp/scratch.txt ${test_db_files_mount}/docs/tutorial.md`);
		expect(removed.metadata.exitCode).toBe(0);
		expect(removed.stdout).toBe(
			"removed '/tmp/scratch.txt'\n" +
				"pending delete created: /docs/tutorial.md — archives the file when accepted; review in Files\n",
		);
		const scratchRead = await runner.run("cat /tmp/scratch.txt");
		expect(scratchRead.metadata.exitCode).not.toBe(0);

		// A failing operand does not stop later operands (builtin continue-on-error).
		const partial = await runner.run(`rm ${test_db_files_mount}/missing.md ${test_db_files_mount}/docs/nested/deep.md`);
		expect(partial.metadata.exitCode).not.toBe(0);
		expect(partial.stderr).toBe(`rm: cannot remove '${test_db_files_mount}/missing.md': No such file or directory\n`);
		expect(partial.stdout).toBe(
			"pending delete created: /docs/nested/deep.md — archives the file when accepted; review in Files\n",
		);
	});

	test("keeps Ask-mode, glob, and unknown-option rm safety", async () => {
		const askRunner = await create_bash_runner({ allowDbFilesMkdir: false });
		const askResult = await askRunner.run(`rm ${test_db_files_mount}/docs/readme.md`);
		expect(askResult.metadata.exitCode).not.toBe(0);
		expect(askResult.stderr).toContain("cannot delete app file");
		expect(askResult.stderr).toContain("App file deletes are available in Agent mode");
		expect(askResult.stderr).toContain("path '/docs/readme.md'");
		expect(await list_pending_updates(askRunner)).toHaveLength(0);

		const runner = await create_bash_runner();
		const globResult = await runner.run(`rm '${test_db_files_mount}/docs/*.md'`);
		expect(globResult.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(globResult.stderr).toContain("app file glob patterns are not supported");

		// Unknown options delegate to the builtin, whose parser errors before touching the fs.
		const unknownOption = await runner.run(`rm -i ${test_db_files_mount}/docs/readme.md`);
		expect(unknownOption.metadata.exitCode).not.toBe(0);
		expect(await list_pending_updates(runner)).toHaveLength(0);
	});

	test("covers builtin rm flag forms, root rejection, and same-call visibility", async () => {
		const runner = await create_bash_runner();

		// -f never suppresses the folder error, and the workspace root is never removable.
		const forcedFolder = await runner.run(`rm -f ${test_db_files_mount}/reports`);
		expect(forcedFolder.metadata.exitCode).not.toBe(0);
		expect(forcedFolder.stderr).toBe(`rm: cannot remove '${test_db_files_mount}/reports': Is a directory\n`);
		const root = await runner.run(`rm -r ${test_db_files_mount}`);
		expect(root.metadata.exitCode).not.toBe(0);
		expect(root.stderr).toBe(`rm: cannot remove '${test_db_files_mount}': Operation not permitted\n`);

		// -R, clustered flags, and `--` all keep builtin semantics for app operands.
		const upperRecursive = await runner.run(`rm -R ${test_db_files_mount}/reports`);
		expect(upperRecursive.metadata.exitCode).toBe(0);
		expect(upperRecursive.stdout).toBe(
			"pending delete created: /reports — archives the folder and its contents when accepted; review in Files\n",
		);
		const clustered = await runner.run(`rm -rfv -- ${test_db_files_mount}/docs/nested`);
		expect(clustered.metadata.exitCode).toBe(0);
		expect(clustered.stdout).toBe(
			"pending delete created: /docs/nested — archives the folder and its contents when accepted; review in Files\n",
		);

		// The builtin's parser ignores a boolean long option's value, so --force=false still
		// means force and must be intercepted, not delegated into a silent builtin no-op.
		const booleanForm = await runner.run(`rm --force=false --recursive=x ${test_db_files_mount}/docs/tutorial.md`);
		expect(booleanForm.metadata.exitCode).toBe(0);
		expect(booleanForm.stdout).toBe(
			"pending delete created: /docs/tutorial.md — archives the file when accepted; review in Files\n",
		);

		// Later commands chained in the SAME bash call already see the removed path as gone.
		const sameCall = await runner.run(
			`rm ${test_db_files_mount}/docs/readme.md && cat ${test_db_files_mount}/docs/readme.md`,
		);
		expect(sameCall.metadata.exitCode).not.toBe(0);
		expect(sameCall.stdout).toContain("pending delete created: /docs/readme.md");
		expect(sameCall.stderr).toContain("No such file or directory");
	});

	test("copies one exact readable app file to scratch and rejects unreadable app copies", async () => {
		const { run } = await create_bash_runner({
			initialCwd: test_db_files_mount,
			extraFiles: [{ path: "/-dash-copy.md", content: "dash cp\n" }],
		});

		const copied = await run(`cp ${test_db_files_mount}/docs/readme.md /tmp/readme.md && cat /tmp/readme.md`);
		const dashCopied = await run("cp -- -dash-copy.md /tmp/dash-copy.md && cat /tmp/dash-copy.md");
		const dirDestination = await run(`cp ${test_db_files_mount}/docs/readme.md /tmp && cat /tmp/readme.md`);
		const outsideTmp = await run(`cp ${test_db_files_mount}/docs/readme.md /dev/null`);
		const unreadable = await run(`cp ${test_db_files_mount}/source.pdf /tmp/source.pdf`);

		expect(copied.metadata.exitCode).toBe(0);
		expect(copied.stdout).toContain("unique-token");
		expect(dashCopied.metadata.exitCode).toBe(0);
		expect(dashCopied.stdout).toContain("dash cp");
		expect(dirDestination.metadata.exitCode).toBe(0);
		expect(dirDestination.stdout).toContain("unique-token");
		expect(outsideTmp.metadata.exitCode).not.toBe(0);
		expect(outsideTmp.stderr).toContain("only supports /tmp destinations");
		expect(outsideTmp.stderr).not.toContain("read-only for cp");
		expect(unreadable.metadata.exitCode).not.toBe(0);
		expect(unreadable.stderr).toContain("Bash can read editable text files only");
		expect(unreadable.stderr).toContain(`${test_db_files_mount}/source.pdf.md`);
	});

	test("cp no-clobber keeps an existing scratch destination", async () => {
		const { run } = await create_bash_runner();
		await run("printf 'keep me\\n' > /tmp/no-clobber.md");

		const result = await run(
			`cp -n ${test_db_files_mount}/docs/readme.md /tmp/no-clobber.md && cat /tmp/no-clobber.md`,
		);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe("keep me\n");
		expect(result.stderr).toBe("");
	});

	test("creates a pending move proposal for an app file rename", async () => {
		const runner = await create_bash_runner();
		const docsId = await get_seeded_node_id(runner, "/docs");

		const result = await runner.run(`mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/guide.md`);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// The committed node stays at the old path; only a move-only pending update doc exists.
		const sourceId = await get_seeded_node_id(runner, "/docs/tutorial.md");
		const rows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", sourceId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			pendingMove: { destParent: { kind: "saved", id: docsId }, destName: "guide.md", fromPath: "/docs/tutorial.md" },
			size: 0,
		});
		expect(rows[0].content).toBeUndefined();

		// The proposer's later commands see the pending path overlay: the vacated path reads
		// as gone and the claimed destination serves the moved file.
		const oldRead = await runner.run(`cat ${test_db_files_mount}/docs/tutorial.md`);
		expect(oldRead.metadata.exitCode).not.toBe(0);
		expect(oldRead.stderr).toContain("No such file or directory");
		const newRead = await runner.run(`cat ${test_db_files_mount}/docs/guide.md`);
		expect(newRead.metadata.exitCode).toBe(0);
		expect(newRead.stdout).toContain("zeta");
		const newStat = await runner.run(`stat ${test_db_files_mount}/docs/guide.md`);
		expect(newStat.metadata.exitCode).toBe(0);
		expect(newStat.stdout).toContain("regular file");
		const oldStat = await runner.run(`stat ${test_db_files_mount}/docs/tutorial.md`);
		expect(oldStat.metadata.exitCode).not.toBe(0);
		expect(oldStat.stderr).toContain("No such file or directory");
	});

	test("mv back to the original path cancels the pending move", async () => {
		const runner = await create_bash_runner();

		const moved = await runner.run(`mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/guide.md`);
		expect(moved.metadata.exitCode).toBe(0);

		const cancelled = await runner.run(
			`mv ${test_db_files_mount}/docs/guide.md ${test_db_files_mount}/docs/tutorial.md`,
		);
		expect(cancelled.metadata.exitCode).toBe(0);
		expect(cancelled.stderr).toBe("");
		expect(cancelled.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// The move-only pending update doc is gone and the file reads at its committed path again.
		const sourceId = await get_seeded_node_id(runner, "/docs/tutorial.md");
		const rows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", sourceId))
				.collect(),
		);
		expect(rows).toHaveLength(0);
		const restoredRead = await runner.run(`cat ${test_db_files_mount}/docs/tutorial.md`);
		expect(restoredRead.metadata.exitCode).toBe(0);
		expect(restoredRead.stdout).toContain("zeta");
	});

	test("creates pending move proposals into an existing folder and for folders", async () => {
		const runner = await create_bash_runner();
		const reportsId = await get_seeded_node_id(runner, "/reports");

		const fileMove = await runner.run(`mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/reports`);
		expect(fileMove.metadata.exitCode).toBe(0);
		expect(fileMove.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		const folderMove = await runner.run(`mv ${test_db_files_mount}/docs/nested ${test_db_files_mount}/reports`);
		expect(folderMove.metadata.exitCode).toBe(0);
		expect(folderMove.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		const nestedId = await get_seeded_node_id(runner, "/docs/nested");
		const rows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", nestedId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].pendingMove).toMatchObject({
			destParent: { kind: "saved", id: reportsId },
			destName: "nested",
			fromPath: "/docs/nested",
		});
	});

	test("rejects unsupported app move destinations without creating proposals", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/reports/readme.md", content: "occupied\n" }],
		});

		const destFileExists = await runner.run(
			`mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/tutorial.md`,
		);
		expect(destFileExists.metadata.exitCode).not.toBe(0);
		expect(destFileExists.stderr).toBe("mv: The destination already exists\n");

		const destOccupiedInFolder = await runner.run(
			`mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/reports`,
		);
		expect(destOccupiedInFolder.metadata.exitCode).not.toBe(0);
		expect(destOccupiedInFolder.stderr).toBe("mv: The destination already exists\n");

		const multiSource = await runner.run(
			`mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/reports/summary.md ${test_db_files_mount}/docs/tutorial.md`,
		);
		expect(multiSource.metadata.exitCode).not.toBe(0);
		expect(multiSource.stderr).toBe("mv: the destination must be an existing directory\n");

		const missingParent = await runner.run(
			`mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/missing/readme.md`,
		);
		expect(missingParent.metadata.exitCode).not.toBe(0);
		expect(missingParent.stderr).toBe("mv: the destination parent is not a directory\n");

		const folderIntoItself = await runner.run(`mv ${test_db_files_mount}/docs ${test_db_files_mount}/docs/nested`);
		expect(folderIntoItself.metadata.exitCode).not.toBe(0);
		expect(folderIntoItself.stderr).toBe("mv: A folder cannot be transferred inside itself\n");

		const samePath = await runner.run(`mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/readme.md`);
		expect(samePath.metadata.exitCode).toBe(0);
		expect(samePath.stdout).toBe("");
		expect(samePath.stderr).toBe("");

		const missingSource = await runner.run(`mv ${test_db_files_mount}/nope.md ${test_db_files_mount}/reports`);
		expect(missingSource.metadata.exitCode).not.toBe(0);
		expect(missingSource.stderr).toBe(`mv: source '${test_db_files_mount}/nope.md' is not available\n`);

		const rows = await runner.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		expect(rows).toHaveLength(0);
	});

	test("proposes a structural replace on the source with mv -f between editable files", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/docs/replace-me.md", content: "old target\n" },
				{ path: "/docs/nested/readme.md", content: "second source\n" },
				{ path: "/reports/readme.md", content: "occupied\n" },
			],
		});
		const sourceId = await get_seeded_node_id(runner, "/docs/readme.md");
		const targetId = await get_seeded_node_id(runner, "/docs/replace-me.md");

		const fileOntoFile = await runner.run(
			`mv -f ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/replace-me.md`,
		);
		expect(fileOntoFile.stderr).toBe("");
		expect(fileOntoFile.metadata.exitCode).toBe(0);
		expect(fileOntoFile.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		// The proposal is a move on the SOURCE node that replaces the target. The source keeps
		// its identity, type, and history. The target gets no pending update doc.
		const sourceRows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", sourceId))
				.collect(),
		);
		expect(sourceRows).toHaveLength(1);
		expect(sourceRows[0].pendingMove).toMatchObject({
			destName: "replace-me.md",
			replacesTarget: { kind: "saved", id: targetId },
		});
		expect(sourceRows[0].copiedFrom).toBeUndefined();
		expect(sourceRows[0].content).toBeUndefined();
		const targetRows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", targetId))
				.collect(),
		);
		expect(targetRows).toHaveLength(0);

		// The pending move hides its source from the proposer's overlay, so a later mv of the
		// same source path reads as missing (the file is already spoken for).
		const hiddenSource = await runner.run(`mv -f ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/reports`);
		expect(hiddenSource.metadata.exitCode).not.toBe(0);
		expect(hiddenSource.stderr).toBe(`mv: source '${test_db_files_mount}/docs/readme.md' is not available\n`);

		// A folder destination replaces its occupant file through the same -f opt-in
		// (mv into a folder keeps the source name, so the nested readme collides).
		const secondSourceId = await get_seeded_node_id(runner, "/docs/nested/readme.md");
		const occupantId = await get_seeded_node_id(runner, "/reports/readme.md");
		const folderDest = await runner.run(
			`mv -f ${test_db_files_mount}/docs/nested/readme.md ${test_db_files_mount}/reports`,
		);
		expect(folderDest.metadata.exitCode).toBe(0);
		expect(folderDest.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		const secondSourceRows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", secondSourceId))
				.collect(),
		);
		expect(secondSourceRows).toHaveLength(1);
		expect(secondSourceRows[0].pendingMove).toMatchObject({
			destName: "readme.md",
			replacesTarget: { kind: "saved", id: occupantId },
		});

		// Folders can never replace a file, even with -f; real mv reports the kind mismatch.
		// (replace-me.md is claimed by the first move above, so a free file stands in here.)
		const folderOntoFile = await runner.run(
			`mv -Tf ${test_db_files_mount}/docs/nested ${test_db_files_mount}/reports/summary.md`,
		);
		expect(folderOntoFile.metadata.exitCode).not.toBe(0);
		expect(folderOntoFile.stderr).toBe("mv: The source and destination types differ\n");
	});

	test("keeps the structural replace for mv -f onto a non-editable file", async () => {
		const runner = await create_bash_runner();
		const sourceId = await get_seeded_node_id(runner, "/docs/readme.md");
		const uploadedId = await get_seeded_node_id(runner, "/uploaded.md");

		// A non-editable target has no version history to keep, so the source's pending update doc
		// records a structural replacement: accepting archives the target and moves the source onto its path.
		const result = await runner.run(`mv -f ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/uploaded.md`);
		expect(result.stderr).toBe("");
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		const rows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", sourceId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].pendingMove).toMatchObject({
			destName: "uploaded.md",
			replacesTarget: { kind: "saved", id: uploadedId },
		});
	});

	test("replaces an earlier move proposal and mixes with pending content", async () => {
		const runner = await create_bash_runner({
			// The content upsert below reconstructs the live base from the stored snapshot.
			extraFiles: [{ path: "/docs/mixed.md", content: "mixed base\n", withRealYjsSnapshot: true }],
		});
		const sourceId = await get_seeded_node_id(runner, "/docs/tutorial.md");

		const firstMove = await runner.run(
			`mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/first.md`,
		);
		expect(firstMove.metadata.exitCode).toBe(0);
		// The overlay already shows the file at /docs/first.md, so the follow-up mv uses the
		// visible path (the vacated /docs/tutorial.md reads as gone).
		const secondMove = await runner.run(
			`mv ${test_db_files_mount}/docs/first.md ${test_db_files_mount}/docs/second.md`,
		);
		expect(secondMove.metadata.exitCode).toBe(0);

		// mv after mv replaces the proposal on the same single pending update doc.
		const moveRows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", sourceId))
				.collect(),
		);
		expect(moveRows).toHaveLength(1);
		expect(moveRows[0].pendingMove).toMatchObject({ destName: "second.md" });

		// mv after a write_file-style content upsert degrades to one content-plus-move pending update doc.
		const mixedId = await get_seeded_node_id(runner, "/docs/mixed.md");
		await upsert_pending_update_for_test(runner, {
			target: { kind: "saved", id: mixedId },
			unstagedText: "edited mixed content\n",
		});

		const mixedMove = await runner.run(
			`mv ${test_db_files_mount}/docs/mixed.md ${test_db_files_mount}/docs/renamed-mixed.md`,
		);
		expect(mixedMove.metadata.exitCode).toBe(0);
		const mixedRows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", mixedId))
				.collect(),
		);
		expect(mixedRows).toHaveLength(1);
		expect(mixedRows[0].pendingMove).toMatchObject({ destName: "renamed-mixed.md" });
		expect(mixedRows[0].content?.unstagedStateId).toBeDefined();
		expect(mixedRows[0].size).toBeGreaterThan(0);
	});

	test("reuses a vacated path and reads a moved source through the overlay", async () => {
		const runner = await create_bash_runner();

		const firstMove = await runner.run(
			`mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/guide.md`,
		);
		expect(firstMove.metadata.exitCode).toBe(0);

		// The vacated path reads as free for the proposer, so another mv can claim it.
		const reuseMove = await runner.run(
			`mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/tutorial.md`,
		);
		expect(reuseMove.metadata.exitCode).toBe(0);
		expect(reuseMove.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// cp reads the moved source through the overlay at its claimed destination.
		const scratchCopy = await runner.run(
			`cp ${test_db_files_mount}/docs/guide.md /tmp/guide-copy.md && cat /tmp/guide-copy.md`,
		);
		expect(scratchCopy.metadata.exitCode).toBe(0);
		expect(scratchCopy.stdout).toContain("zeta");

		const appCopy = await runner.run(`cp ${test_db_files_mount}/docs/guide.md ${test_db_files_mount}/guide-copy.md`);
		expect(appCopy.metadata.exitCode).toBe(0);
		expect(appCopy.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
	});

	test("proposes and accepts a folder swap cycle through a temp name", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/fsc-a", kind: "folder" },
				{ path: "/fsc-a/a-child.md", content: "fsc a child\n" },
				{ path: "/fsc-b", kind: "folder" },
				{ path: "/fsc-b/b-child.md", content: "fsc b child\n" },
			],
		});
		const folderAId = await get_seeded_node_id(runner, "/fsc-a");
		const folderBId = await get_seeded_node_id(runner, "/fsc-b");
		const childAId = await get_seeded_node_id(runner, "/fsc-a/a-child.md");
		const childBId = await get_seeded_node_id(runner, "/fsc-b/b-child.md");

		// The classic 3-step swap: every mv succeeds and leaves a 2-row folder cycle.
		const moveBToTemp = await runner.run(`mv ${test_db_files_mount}/fsc-b ${test_db_files_mount}/fsc-temp`);
		expect(moveBToTemp.metadata.exitCode).toBe(0);
		const moveAToB = await runner.run(`mv ${test_db_files_mount}/fsc-a ${test_db_files_mount}/fsc-b`);
		expect(moveAToB.metadata.exitCode).toBe(0);
		const closing = await runner.run(`mv ${test_db_files_mount}/fsc-temp ${test_db_files_mount}/fsc-a`);
		expect(closing.metadata.exitCode).toBe(0);
		expect(closing.stderr).toBe("");
		expect(closing.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// Both rows now target each other's committed paths.
		const rowsA = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", folderAId))
				.collect(),
		);
		expect(rowsA).toHaveLength(1);
		expect(rowsA[0].pendingMove).toMatchObject({ destName: "fsc-b", fromPath: "/fsc-a" });
		const rowsB = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", folderBId))
				.collect(),
		);
		expect(rowsB).toHaveLength(1);
		expect(rowsB[0].pendingMove).toMatchObject({ destName: "fsc-a", fromPath: "/fsc-b" });

		// One selected member cannot settle the other member without review.
		const asUser = runner.t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-bash-folder-swap-accept",
			external_id: runner.seeded.userId,
			email: "bash-folder-swap-accept@test.local",
		});
		const incomplete = await asUser.mutation(
			api.files_pending_updates.apply_file_pending_move,
			await pending_review_for_test(runner, folderAId),
		);
		expect(incomplete._nay?.name).toBe("needs_review");
		await accept_pending_move_group_for_test(runner, [folderAId, folderBId]);

		// Both folders and their children sit at swapped committed paths, rows settled.
		const movedA = await get_seeded_node(runner, "/fsc-b");
		expect(movedA._id).toBe(folderAId);
		const movedB = await get_seeded_node(runner, "/fsc-a");
		expect(movedB._id).toBe(folderBId);
		const movedChildA = await get_seeded_node(runner, "/fsc-b/a-child.md");
		expect(movedChildA._id).toBe(childAId);
		const movedChildB = await get_seeded_node(runner, "/fsc-a/b-child.md");
		expect(movedChildB._id).toBe(childBId);
		const settledRows = await runner.t.run(async (ctx) => [
			...(await ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", folderAId))
				.collect()),
			...(await ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", folderBId))
				.collect()),
		]);
		expect(settledRows).toHaveLength(0);
	});

	test("proposes a mixed file and folder swap cycle through a temp name", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/fsc-mix-a.md", content: "fsc mix a\n" },
				{ path: "/fsc-mix-b.md", kind: "folder" },
			],
		});

		const moveFileToTemp = await runner.run(
			`mv ${test_db_files_mount}/fsc-mix-a.md ${test_db_files_mount}/fsc-mix-tmp.md`,
		);
		expect(moveFileToTemp.metadata.exitCode).toBe(0);
		const moveFolderToFilePath = await runner.run(
			`mv ${test_db_files_mount}/fsc-mix-b.md ${test_db_files_mount}/fsc-mix-a.md`,
		);
		expect(moveFolderToFilePath.metadata.exitCode).toBe(0);

		// The closing mv forms a mixed cycle with a folder member: proposable like any swap.
		const closing = await runner.run(`mv ${test_db_files_mount}/fsc-mix-tmp.md ${test_db_files_mount}/fsc-mix-b.md`);
		expect(closing.metadata.exitCode).toBe(0);
		expect(closing.stderr).toBe("");
		expect(closing.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
	});

	test("mv -Tf proposes and accepts replacing an empty folder occupant", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/edr-src", kind: "folder" },
				{ path: "/edr-src/child.md", content: "edr child\n" },
				{ path: "/edr-dst", kind: "folder" },
			],
		});
		const sourceId = await get_seeded_node_id(runner, "/edr-src");
		const destId = await get_seeded_node_id(runner, "/edr-dst");
		const childId = await get_seeded_node_id(runner, "/edr-src/child.md");

		// Both flags make the replacement explicit.
		const moved = await runner.run(`mv -Tf ${test_db_files_mount}/edr-src ${test_db_files_mount}/edr-dst`);
		expect(moved.stderr).toBe("");
		expect(moved.metadata.exitCode).toBe(0);
		expect(moved.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// Accepting through the real mutation archives the empty occupant and moves the subtree.
		const asUser = runner.t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-bash-edr-accept",
			external_id: runner.seeded.userId,
			email: "bash-edr-accept@test.local",
		});
		const accepted = await asUser.mutation(
			api.files_pending_updates.apply_file_pending_move,
			await pending_review_for_test(runner, sourceId),
		);
		expect(accepted._nay).toBeUndefined();

		const movedFolder = await get_seeded_node(runner, "/edr-dst");
		expect(movedFolder._id).toBe(sourceId);
		const movedChild = await get_seeded_node(runner, "/edr-dst/child.md");
		expect(movedChild._id).toBe(childId);
		const occupant = await runner.t.run((ctx) => ctx.db.get("files_nodes", destId));
		expect(occupant?.archiveOperationId).toBeDefined();
	});

	test("mv -T without -f refuses an empty folder occupant", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/edr-nf-src", kind: "folder" },
				{ path: "/edr-nf-src/child.md", content: "edr nf child\n" },
				{ path: "/edr-nf-dst", kind: "folder" },
			],
		});
		const sourceId = await get_seeded_node_id(runner, "/edr-nf-src");
		const destId = await get_seeded_node_id(runner, "/edr-nf-dst");

		// -T alone only says "do not move inside the destination". Replacing it still needs -f.
		const moved = await runner.run(`mv -T ${test_db_files_mount}/edr-nf-src ${test_db_files_mount}/edr-nf-dst`);
		expect(moved.stderr).toBe("mv: The destination already exists\n");
		expect(moved.metadata.exitCode).not.toBe(0);

		// Nothing is proposed and nothing moves: both folders keep their saved paths.
		expect(await list_pending_updates(runner)).toEqual([]);
		expect((await get_seeded_node(runner, "/edr-nf-src"))._id).toBe(sourceId);
		expect((await get_seeded_node(runner, "/edr-nf-dst"))._id).toBe(destId);
		expect((await runner.t.run((ctx) => ctx.db.get("files_nodes", destId)))?.archiveOperationId).toBeNull();
	});

	test("mv -T onto a non-empty folder fails like rename()", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/edr-full-src", kind: "folder" },
				{ path: "/edr-full", kind: "folder" },
				{ path: "/edr-full/keep.md", content: "edr keep\n" },
				{ path: "/edr-full-file.md", content: "edr file\n" },
			],
		});

		const moved = await runner.run(`mv -Tf ${test_db_files_mount}/edr-full-src ${test_db_files_mount}/edr-full`);
		expect(moved.metadata.exitCode).not.toBe(0);
		expect(moved.stderr).toBe("mv: Directory not empty\n");

		// A file never replaces a folder, matching rename()'s EISDIR.
		const fileMove = await runner.run(`mv -Tf ${test_db_files_mount}/edr-full-file.md ${test_db_files_mount}/edr-full`);
		expect(fileMove.metadata.exitCode).not.toBe(0);
		expect(fileMove.stderr).toBe("mv: The source and destination types differ\n");
	});

	test("mv into a folder requires an explicit empty-folder replacement", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/edr-mv-a", kind: "folder" },
				{ path: "/edr-mv-a/child.md", content: "edr mv child\n" },
				{ path: "/edr-into", kind: "folder" },
				{ path: "/edr-into/edr-mv-a", kind: "folder" },
			],
		});

		const moved = await runner.run(`mv ${test_db_files_mount}/edr-mv-a ${test_db_files_mount}/edr-into`);
		expect(moved.stderr).toBe("mv: The destination already exists\n");
		expect(moved.metadata.exitCode).not.toBe(0);
		expect(await list_pending_updates(runner)).toEqual([]);
		const replacement = await runner.run(
			`mv -Tf ${test_db_files_mount}/edr-mv-a ${test_db_files_mount}/edr-into/edr-mv-a`,
		);
		expect(replacement.metadata.exitCode, replacement.stderr).toBe(0);
		expect(replacement.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
	});

	test("proposes a pure file swap cycle through a temp name", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/r16s-swap-a.md", content: "r16s swap a\n" },
				{ path: "/r16s-swap-b.md", content: "r16s swap b\n" },
			],
		});

		const moveAToTemp = await runner.run(
			`mv ${test_db_files_mount}/r16s-swap-a.md ${test_db_files_mount}/r16s-swap-tmp.md`,
		);
		expect(moveAToTemp.metadata.exitCode).toBe(0);
		const moveBToA = await runner.run(`mv ${test_db_files_mount}/r16s-swap-b.md ${test_db_files_mount}/r16s-swap-a.md`);
		expect(moveBToA.metadata.exitCode).toBe(0);

		// A pure file cycle stays proposable: accept applies the whole cycle atomically.
		const closing = await runner.run(
			`mv ${test_db_files_mount}/r16s-swap-tmp.md ${test_db_files_mount}/r16s-swap-b.md`,
		);
		expect(closing.metadata.exitCode).toBe(0);
		expect(closing.stderr).toBe("");
		expect(closing.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// Both rows now target each other's committed paths.
		const fileAId = await get_seeded_node_id(runner, "/r16s-swap-a.md");
		const fileBId = await get_seeded_node_id(runner, "/r16s-swap-b.md");
		const rowsA = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", fileAId))
				.collect(),
		);
		expect(rowsA).toHaveLength(1);
		expect(rowsA[0].pendingMove).toMatchObject({ destName: "r16s-swap-b.md", fromPath: "/r16s-swap-a.md" });
		const rowsB = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", fileBId))
				.collect(),
		);
		expect(rowsB).toHaveLength(1);
		expect(rowsB[0].pendingMove).toMatchObject({ destName: "r16s-swap-a.md", fromPath: "/r16s-swap-b.md" });
	});

	test("still allows a linear folder move chain onto a vacated path", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/r16s-lin-a", kind: "folder" },
				{ path: "/r16s-lin-b", kind: "folder" },
			],
		});

		// B vacates its path, then A claims it: a chain with no cycle stays allowed.
		const moveB = await runner.run(`mv ${test_db_files_mount}/r16s-lin-b ${test_db_files_mount}/r16s-lin-c`);
		expect(moveB.metadata.exitCode).toBe(0);
		const moveA = await runner.run(`mv ${test_db_files_mount}/r16s-lin-a ${test_db_files_mount}/r16s-lin-b`);
		expect(moveA.metadata.exitCode).toBe(0);
		expect(moveA.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
	});

	test("mv -T claims a folder path vacated by the same user's pending move", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/edr-vac-a", kind: "folder" },
				{ path: "/edr-vac-a/child.md", content: "edr vac child\n" },
				{ path: "/edr-vac-b", kind: "folder" },
			],
		});
		const folderAId = await get_seeded_node_id(runner, "/edr-vac-a");
		const folderBId = await get_seeded_node_id(runner, "/edr-vac-b");

		// B vacates its path, then -T claims it: the direct rename sees the path as free.
		const moveB = await runner.run(`mv ${test_db_files_mount}/edr-vac-b ${test_db_files_mount}/edr-vac-c`);
		expect(moveB.metadata.exitCode).toBe(0);
		const moveA = await runner.run(`mv -T ${test_db_files_mount}/edr-vac-a ${test_db_files_mount}/edr-vac-b`);
		expect(moveA.stderr).toBe("");
		expect(moveA.metadata.exitCode).toBe(0);
		expect(moveA.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// Accepting A first hits the order guard: B still occupies the committed path.
		const asUser = runner.t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-bash-edr-vac",
			external_id: runner.seeded.userId,
			email: "bash-edr-vac@test.local",
		});
		const acceptedAFirst = await asUser.mutation(
			api.files_pending_updates.apply_file_pending_move,
			await pending_review_for_test(runner, folderAId),
		);
		expect(acceptedAFirst._nay?.name).toBe("needs_review");

		await accept_pending_move_group_for_test(runner, [folderAId, folderBId]);

		const movedA = await get_seeded_node(runner, "/edr-vac-b");
		expect(movedA._id).toBe(folderAId);
		const movedChild = await get_seeded_node(runner, "/edr-vac-b/child.md");
		expect(movedChild.kind).toBe("file");
		const movedB = await get_seeded_node(runner, "/edr-vac-c");
		expect(movedB._id).toBe(folderBId);
		const settledRows = await runner.t.run(async (ctx) => [
			...(await ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", folderAId))
				.collect()),
			...(await ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", folderBId))
				.collect()),
		]);
		expect(settledRows).toHaveLength(0);
	});

	test("overlays pending moves onto ls listings", async () => {
		const runner = await create_bash_runner();

		const move = await runner.run(`mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/reports/guide.md`);
		expect(move.metadata.exitCode).toBe(0);

		// The destination folder shows the moved file under its new name.
		const destList = await runner.run(`ls ${test_db_files_mount}/reports`);
		expect(destList.metadata.exitCode).toBe(0);
		expect(destList.stdout.trim().split("\n")).toEqual(["guide.md", "summary.md"]);

		// The source folder no longer lists it.
		const sourceList = await runner.run(`ls ${test_db_files_mount}/docs`);
		expect(sourceList.metadata.exitCode).toBe(0);
		expect(sourceList.stdout.trim().split("\n")).toEqual(["nested/", "readme.md"]);

		// A move to the workspace root shows up in the root listing.
		const rootMove = await runner.run(`mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/root-readme.md`);
		expect(rootMove.metadata.exitCode).toBe(0);
		const rootList = await runner.run(`ls ${test_db_files_mount}`);
		const rootLines = rootList.stdout.trim().split("\n");
		expect(rootLines).toContain("root-readme.md");
		expect(rootLines).not.toContain("readme.md");

		// The workspace recency view shows the visible path of a moved file.
		const recency = await runner.run("ls -t --limit 50");
		expect(recency.stdout).toContain(`${test_db_files_mount}/reports/guide.md`);
		expect(recency.stdout).not.toContain(`${test_db_files_mount}/docs/tutorial.md`);
	});

	test("shows an in-place rename exactly once in listings", async () => {
		const runner = await create_bash_runner();

		await runner.run(`mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/guide.md`);

		const list = await runner.run(`ls ${test_db_files_mount}/docs`);
		expect(list.metadata.exitCode).toBe(0);
		expect(list.stdout.trim().split("\n")).toEqual(["guide.md", "nested/", "readme.md"]);
	});

	test("shadows a committed newcomer at a claimed destination in listings", async () => {
		const runner = await create_bash_runner();

		await runner.run(`mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/claimed.md`);

		// A committed node appears at the claimed path after the proposal.
		await runner.t.run((ctx) =>
			seed_organization_node(
				ctx,
				{
					organizationId: runner.seeded.organizationId,
					workspaceId: runner.seeded.workspaceId,
					userId: runner.seeded.userId,
				},
				{ path: "/docs/claimed.md", content: "newcomer\n" },
				99,
			),
		);

		// The mover appears exactly once; the newcomer stays hidden from the proposer.
		const list = await runner.run(`ls ${test_db_files_mount}/docs`);
		const lines = list.stdout.trim().split("\n");
		expect(lines.filter((line) => line === "claimed.md")).toHaveLength(1);
		expect(lines).not.toContain("tutorial.md");
		const read = await runner.run(`cat ${test_db_files_mount}/docs/claimed.md`);
		expect(read.metadata.exitCode).toBe(0);
		expect(read.stdout).toContain("zeta");
	});

	test("splices a moved folder's subtree into tree and recursive ls", async () => {
		const runner = await create_bash_runner();

		const move = await runner.run(`mv ${test_db_files_mount}/docs/nested ${test_db_files_mount}/reports/nested`);
		expect(move.metadata.exitCode).toBe(0);

		// The destination parent shows the moved folder with its subtree spliced in.
		const destTree = await runner.run(`tree ${test_db_files_mount}/reports`);
		expect(destTree.metadata.exitCode).toBe(0);
		expect(destTree.stdout).toContain("nested/");
		expect(destTree.stdout).toContain("deep.md");

		// Listing the moved folder itself walks its committed source subtree.
		const movedTree = await runner.run(`tree ${test_db_files_mount}/reports/nested`);
		expect(movedTree.metadata.exitCode).toBe(0);
		expect(movedTree.stdout).toContain("deep.md");

		// The old location is gone from listings.
		const sourceTree = await runner.run(`tree ${test_db_files_mount}/docs`);
		expect(sourceTree.stdout).not.toContain("nested");
		expect(sourceTree.stdout).not.toContain("deep.md");

		const destRecursive = await runner.run(`ls -R ${test_db_files_mount}/reports`);
		expect(destRecursive.metadata.exitCode).toBe(0);
		expect(destRecursive.stdout).toContain(`${test_db_files_mount}/reports/nested/`);
		expect(destRecursive.stdout).toContain(`${test_db_files_mount}/reports/nested/deep.md`);
		const sourceRecursive = await runner.run(`ls -R ${test_db_files_mount}/docs`);
		expect(sourceRecursive.stdout).not.toContain("deep.md");

		const destFind = await runner.run(`find ${test_db_files_mount}/reports --limit 20`);
		expect(destFind.metadata.exitCode).toBe(0);
		expect(destFind.stdout).toContain(`${test_db_files_mount}/reports/nested/`);
		expect(destFind.stdout).toContain(`${test_db_files_mount}/reports/nested/deep.md`);
		const sourceFind = await runner.run(`find ${test_db_files_mount}/docs --limit 20`);
		expect(sourceFind.stdout).not.toContain("deep.md");
	});

	test("lists a pending move nested under a moved folder exactly once", async () => {
		const runner = await create_bash_runner();

		const folderMove = await runner.run(`mv ${test_db_files_mount}/docs/nested ${test_db_files_mount}/reports/nested`);
		expect(folderMove.metadata.exitCode).toBe(0);
		// The follow-up mv uses the moved folder's visible path, nesting one pending move
		// under another.
		const nestedMove = await runner.run(
			`mv ${test_db_files_mount}/reports/nested/deep.md ${test_db_files_mount}/reports/nested/renamed.md`,
		);
		expect(nestedMove.metadata.exitCode).toBe(0);

		// Each visible path appears exactly once: the folder splice and the file's own
		// injection must not both emit /reports/nested/renamed.md.
		const destFind = await runner.run(`find ${test_db_files_mount}/reports --limit 20`);
		expect(destFind.metadata.exitCode).toBe(0);
		const findLines = destFind.stdout.trim().split("\n");
		expect(findLines.filter((line) => line === `${test_db_files_mount}/reports/nested/renamed.md`)).toHaveLength(1);
		expect(findLines.filter((line) => line === `${test_db_files_mount}/reports/nested/deep.md`)).toHaveLength(0);

		const destTree = await runner.run(`tree ${test_db_files_mount}/reports`);
		expect(destTree.metadata.exitCode).toBe(0);
		expect(destTree.stdout.match(/renamed\.md/gu) ?? []).toHaveLength(1);
	});

	test("ls -R lists a pending move nested under a moved folder exactly once", async () => {
		const runner = await create_bash_runner();

		const folderMove = await runner.run(`mv ${test_db_files_mount}/docs/nested ${test_db_files_mount}/reports/nested`);
		expect(folderMove.metadata.exitCode).toBe(0);
		const nestedMove = await runner.run(
			`mv ${test_db_files_mount}/reports/nested/deep.md ${test_db_files_mount}/reports/nested/renamed.md`,
		);
		expect(nestedMove.metadata.exitCode).toBe(0);

		// The folder splice and the file's own injection must not both emit renamed.md.
		const destRecursive = await runner.run(`ls -R ${test_db_files_mount}/reports`);
		expect(destRecursive.metadata.exitCode).toBe(0);
		const recursiveLines = destRecursive.stdout.trim().split("\n");
		expect(recursiveLines.filter((line) => line === `${test_db_files_mount}/reports/nested/renamed.md`)).toHaveLength(
			1,
		);
		expect(recursiveLines.filter((line) => line === `${test_db_files_mount}/reports/nested/deep.md`)).toHaveLength(0);
	});

	test("lists a claimed vacated path inside a moved folder exactly once and agrees with cat", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/a/x.md", content: "X body\n" },
				{ path: "/z.md", content: "Z body\n" },
			],
		});

		const folderMove = await runner.run(`mv ${test_db_files_mount}/a ${test_db_files_mount}/b`);
		expect(folderMove.metadata.exitCode).toBe(0);
		const childRename = await runner.run(`mv ${test_db_files_mount}/b/x.md ${test_db_files_mount}/b/y.md`);
		expect(childRename.metadata.exitCode).toBe(0);
		// The child rename vacated /b/x.md, so another file can claim that visible path.
		const claim = await runner.run(`mv ${test_db_files_mount}/z.md ${test_db_files_mount}/b/x.md`);
		expect(claim.metadata.exitCode).toBe(0);

		// Discard the child rename pending update doc (as the pending panel would): only
		// the folder move and the claim remain.
		const childId = await get_seeded_node_id(runner, "/a/x.md");
		await runner.t.run(async (ctx) => {
			const rows = await ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", childId))
				.collect();
			for (const row of rows) {
				await ctx.db.delete("files_pending_updates", row._id);
			}
		});

		// Listings and exact reads agree: /b/x.md appears exactly once and serves Z's
		// content (the claim shadows the committed child for the proposer).
		const list = await runner.run(`ls ${test_db_files_mount}/b`);
		expect(list.metadata.exitCode).toBe(0);
		const lines = list.stdout.trim().split("\n");
		expect(lines.filter((line) => line === "x.md")).toHaveLength(1);
		// The recency view projects every committed node: the shadowed child must not
		// emit a second /b/x.md line next to the claiming move's line.
		const recency = await runner.run("ls -t --limit 50");
		expect(recency.metadata.exitCode).toBe(0);
		const recencyLines = recency.stdout.trim().split("\n");
		expect(recencyLines.filter((line) => line.endsWith(`${test_db_files_mount}/b/x.md`))).toHaveLength(1);
		const read = await runner.run(`cat ${test_db_files_mount}/b/x.md`);
		expect(read.metadata.exitCode).toBe(0);
		expect(read.stdout).toContain("Z body");
	});

	test("find matches moved files by their visible name only", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/docs/word lesson.md", content: "word search fixture\n" }],
		});

		// mv normalizes app file names, so the visible destination becomes word-guide.md.
		await runner.run(`mv '${test_db_files_mount}/docs/word lesson.md' '${test_db_files_mount}/docs/word guide.md'`);

		// The NEW name finds the moved file at its visible path (overlay injection).
		const byNewName = await runner.run("find -name guide --limit 10");
		expect(byNewName.metadata.exitCode).toBe(0);
		expect(byNewName.stdout).toContain(`${test_db_files_mount}/docs/word-guide.md`);

		// The old name no longer matches: the committed-index hit projects to the new
		// name and fails the re-check.
		const byOldName = await runner.run("find -name lesson --limit 10");
		expect(byOldName.metadata.exitCode).toBe(0);
		expect(byOldName.stdout.trim()).toBe("0 matches.");
	});

	test("reports visible paths for search and recursive grep over pending moves", async () => {
		const runner = await create_bash_runner();

		await runner.run(`mv ${test_db_files_mount}/docs/nested ${test_db_files_mount}/reports/nested`);

		// An unscoped search finds content inside the moved folder at its visible path.
		const unscoped = await runner.run("search three");
		expect(unscoped.metadata.exitCode).toBe(0);
		expect(unscoped.stdout).toContain(`${test_db_files_mount}/reports/nested/deep.md`);
		expect(unscoped.stdout).not.toContain(`${test_db_files_mount}/docs/nested/deep.md`);

		// A --path scope at the visible destination folder translates to the committed source.
		const scoped = await runner.run(`search --path ${test_db_files_mount}/reports/nested three`);
		expect(scoped.metadata.exitCode).toBe(0);
		expect(scoped.stdout).toContain(`${test_db_files_mount}/reports/nested/deep.md`);

		const grepScoped = await runner.run(`grep -R three ${test_db_files_mount}/reports/nested`);
		expect(grepScoped.metadata.exitCode).toBe(0);
		expect(grepScoped.stdout).toContain(`${test_db_files_mount}/reports/nested/deep.md`);

		// A moved file's content match reports the file's visible path too.
		await runner.run(`mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/reports/moved-guide.md`);
		const movedFile = await runner.run("search alpha");
		expect(movedFile.metadata.exitCode).toBe(0);
		expect(movedFile.stdout).toContain(`${test_db_files_mount}/reports/moved-guide.md`);
		expect(movedFile.stdout).not.toContain(`${test_db_files_mount}/docs/tutorial.md`);
	});

	test("grep finds matches in a file with a pending move-only row", async () => {
		const runner = await create_bash_runner();

		const moved = await runner.run(`mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/guide.md`);
		expect(moved.metadata.exitCode).toBe(0);

		// The move-only pending update doc has no pending chunks; grep must fall back to the
		// committed chunks instead of silently reporting no matches.
		const hit = await runner.run(`grep alpha ${test_db_files_mount}/docs/guide.md`);
		expect(hit.metadata.exitCode).toBe(0);
		expect(hit.stderr).toBe("");
		expect(hit.stdout).toBe("alpha\n");
	});

	test("textgrep finds matches in a file with a pending move-only row", async () => {
		const runner = await create_bash_runner();

		const moved = await runner.run(`mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/guide.md`);
		expect(moved.metadata.exitCode).toBe(0);

		// Same committed fallback for the plain-text matcher behind a move-only pending update doc.
		const hit = await runner.run(`textgrep alpha ${test_db_files_mount}/docs/guide.md`);
		expect(hit.metadata.exitCode).toBe(0);
		expect(hit.stderr).toBe("");
		expect(hit.stdout).toBe("alpha\n");
	});

	test("grep reads the pending chunks when the pending row has content", async () => {
		const runner = await create_bash_runner();

		// cp stages the copied text on the fresh destination node as a whole-file replacement.
		// grep must read that staged text, not the (empty) committed one.
		const copied = await runner.run(
			`cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/readme-copy.md`,
		);
		expect(copied.metadata.exitCode).toBe(0);

		const hit = await runner.run(`grep unique-token ${test_db_files_mount}/docs/readme-copy.md`);
		expect(hit.metadata.exitCode).toBe(0);
		expect(hit.stderr).toBe("");
		expect(hit.stdout).toBe("unique-token here\nmore unique-token below\n");
	});

	test("multi-operand grep recovery hint keeps the moved-folder scope", async () => {
		const runner = await create_bash_runner();

		await runner.run(`mv ${test_db_files_mount}/docs ${test_db_files_mount}/reports2`);

		// The fallback hint must scope to the moved folder's visible path, not suggest a
		// whole-workspace search.
		const result = await runner.run(
			`grep alpha ${test_db_files_mount}/reports2 ${test_db_files_mount}/reports2/readme.md`,
		);
		expect(result.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(result.stdout).toContain(`Try: search --path ${test_db_files_mount}/reports2 --limit 20 alpha`);
	});

	test("injects moved-in content into searches scoped at an ancestor of the destination", async () => {
		const runner = await create_bash_runner();

		await runner.run(`mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/reports/moved-guide.md`);

		// /reports is an ancestor of the destination, not itself a redirected folder,
		// so the committed chunks under /docs sit outside the scoped committed prefix.
		const scoped = await runner.run(`search --path ${test_db_files_mount}/reports alpha`);
		expect(scoped.metadata.exitCode).toBe(0);
		expect(scoped.stdout).toContain(`${test_db_files_mount}/reports/moved-guide.md`);

		const grepScoped = await runner.run(`grep -R alpha ${test_db_files_mount}/reports`);
		expect(grepScoped.metadata.exitCode).toBe(0);
		expect(grepScoped.stdout).toContain(`${test_db_files_mount}/reports/moved-guide.md`);

		const textgrepScoped = await runner.run(`textgrep -R alpha ${test_db_files_mount}/reports`);
		expect(textgrepScoped.metadata.exitCode).toBe(0);
		expect(textgrepScoped.stdout).toContain(`${test_db_files_mount}/reports/moved-guide.md`);

		// A moved folder's children inject the same way at the ancestor scope.
		await runner.run(`mv ${test_db_files_mount}/docs/nested ${test_db_files_mount}/reports/nested`);
		const folderScoped = await runner.run(`search --path ${test_db_files_mount}/reports three`);
		expect(folderScoped.metadata.exitCode).toBe(0);
		expect(folderScoped.stdout).toContain(`${test_db_files_mount}/reports/nested/deep.md`);
	});

	test("keeps the search continuation when the overlay empties a page", async () => {
		// The file moved outside the scope is seeded first so the limit-1 first page holds only its
		// committed chunk, which the overlay drops from the /docs scope; the visible
		// match lives on the next page.
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/docs/paged-moved.md", content: "dropscope alpha\n" },
				{ path: "/docs/paged-kept.md", content: "dropscope beta\n" },
			],
		});

		await runner.run(`mv ${test_db_files_mount}/docs/paged-moved.md ${test_db_files_mount}/reports/paged-moved.md`);

		const firstPage = await runner.run(`search --path ${test_db_files_mount}/docs --limit 1 dropscope`);

		expect(firstPage.metadata.exitCode).toBe(0);
		// The underlying result has another page, so an emptied page must keep the
		// continuation reachable instead of reading like a finished search.
		expect(firstPage.stdout).toMatch(/Next page: search --path \S+ --limit 1 --cursor \S+ dropscope/u);

		const continuation = firstPage.stdout.match(/Next page: (search .+)/u)?.[1];
		if (continuation == null) {
			throw new Error("expected a search continuation in the emptied first page stdout");
		}
		const secondPage = await runner.run(continuation);
		expect(secondPage.metadata.exitCode).toBe(0);
		expect(secondPage.stdout).toContain(`${test_db_files_mount}/docs/paged-kept.md`);
	});

	test("chained commands in one bash call see the proposal made by an earlier mv", async () => {
		const runner = await create_bash_runner();

		const chained = await runner.run(
			`ls ${test_db_files_mount}/docs && mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/guide.md && ls ${test_db_files_mount}/docs`,
		);
		expect(chained.metadata.exitCode).toBe(0);
		// The mv confirmation line splits the first ls output from the second.
		const segments = chained.stdout.split("Review in Files.\n");
		expect(segments).toHaveLength(2);
		// The first ls (before the proposal) shows the committed name.
		expect(segments[0]).toContain("tutorial.md");
		// The second ls (after the proposal) shows the new name and drops the old one.
		expect(segments[1]).toContain("guide.md");
		expect(segments[1]).not.toContain("tutorial.md");

		// The proposal row records the chat thread that ran the mv.
		const pendingRows = await runner.t.run(async (ctx) =>
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
		expect(pendingRows).toHaveLength(1);
		expect(pendingRows[0]!.threadIds).toEqual([runner.threadId]);
	});

	test("keeps Ask mode mv and cp app rejections without creating proposals", async () => {
		const runner = await create_bash_runner({ allowDbFilesMkdir: false });
		const before = await runner.t.run((ctx) => ctx.db.query("files_nodes").collect());

		const mvResult = await runner.run(
			`mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/renamed.md`,
		);
		expect(mvResult.metadata.exitCode).not.toBe(0);
		expect(mvResult.stderr).toBe("mv: app file writes require Agent mode\n");

		const cpResult = await runner.run(`cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/copy.md`);
		expect(cpResult.metadata.exitCode).not.toBe(0);
		expect(cpResult.stderr).toBe("cp: app file writes require Agent mode\n");

		expect(
			runner.runMutation.mock.calls.some(
				([ref]) => function_name_of(ref) === "files_pending_updates:upsert_file_pending_move_in_db",
			),
		).toBe(false);
		expect(
			runner.runMutation.mock.calls.some(
				([ref]) => function_name_of(ref) === "files_nodes:create_private_node_by_path",
			),
		).toBe(false);
		expect(await runner.t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
		expect(await list_pending_updates(runner)).toEqual([]);
		expect(await runner.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
	});

	test("keeps Ask mode redirect, touch, and tee app writes rejected without creating proposals", async () => {
		const runner = await create_bash_runner({ allowDbFilesMkdir: false });
		const before = await runner.t.run((ctx) => ctx.db.query("files_nodes").collect());

		const redirect = await runner.run(`printf hi > ${test_db_files_mount}/ask.md`);
		const touched = await runner.run(`touch ${test_db_files_mount}/ask.md`);
		const teed = await runner.run(`printf hi | tee ${test_db_files_mount}/ask.md`);

		for (const result of [redirect, touched, teed]) {
			expect(result.metadata.exitCode).not.toBe(0);
			expect(result.stderr).toContain("Agent mode");
		}
		expect(
			runner.runMutation.mock.calls.some(
				([ref]) => function_name_of(ref) === "files_nodes:create_private_node_by_path",
			),
		).toBe(false);
		expect(await list_pending_updates(runner)).toHaveLength(0);
		expect(await runner.t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
		expect(await runner.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
	});

	test("redirect write creates a private proposal with thread provenance", async () => {
		const runner = await create_bash_runner();

		const written = await runner.run(
			`printf hello > ${test_db_files_mount}/note.md && cat ${test_db_files_mount}/note.md`,
		);
		expect(written.metadata.exitCode).toBe(0);
		expect(written.stderr).toBe("");
		// The chained cat proves resetProposalCaches: the same bash call reads the proposal back.
		// A Markdown file's pending content is rendered Markdown text, which POSIX-terminates
		// non-empty content with one newline; byte-exact storage is the plain-text files' contract.
		expect(written.stdout).toBe("hello\n");

		const draft = await get_private_entry(runner, "/note.md");
		const pendingRows = await list_pending_updates(runner);
		expect(pendingRows).toHaveLength(1);
		expect(pendingRows[0]!.target).toEqual({ kind: "private", id: draft.node._id });
		expect(pendingRows[0]!.content?.base).toEqual({ kind: "new" });
		expect(pendingRows[0]!.threadIds).toEqual([runner.threadId]);
		expect(draft.pendingUpdate.createIntent).toMatchObject({ kind: "text", textKind: "rich_text" });
		expect(
			await runner.t.query(internal.files_nodes.get_by_path, {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				visibilityUserId: runner.ctxData.userId,
				path: "/note.md",
			}),
		).toBeNull();
	});

	test("private files share paths and fresh sizes across chained readers", async () => {
		const runner = await create_bash_runner();
		const folder = `${test_db_files_mount}/reader-draft`;
		const file = `${folder}/lines.txt`;
		const result = await runner.run(
			[
				`mkdir ${folder}`,
				`printf 'one\\ntwo\\n' > ${file}`,
				`stat -c '%s %F' ${file}`,
				`head -n 1 ${file}`,
				`tail -n 1 ${file}`,
				`sed -n '2p' ${file}`,
				`ls ${folder}`,
				`printf 'three\\n' >> ${file}`,
				`stat -c %s ${file}`,
				`cat ${file}`,
			].join(" && "),
		);
		expect(result.stderr).toBe("");
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe("8 regular file\none\ntwo\ntwo\nlines.txt\n14\none\ntwo\nthree\n");
		const entry = await get_private_entry(runner, "/reader-draft/lines.txt");
		expect(entry.pendingUpdate.size).toBe(14);
		expect(
			await runner.t.query(internal.files_nodes.get_by_path, {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				visibilityUserId: runner.ctxData.userId,
				path: "/reader-draft/lines.txt",
			}),
		).toBeNull();
	});

	test("discovery commands include private files and private folder scopes", async () => {
		const runner = await create_bash_runner();
		const written = await runner.run("printf 'privateneedle\\n' > private-search/note.md");
		expect(written.metadata.exitCode).toBe(0);
		const listed = await runner.run("find private-search --limit 10");
		expect(listed.metadata.exitCode).toBe(0);
		expect(listed.stdout).toContain(`${test_db_files_mount}/private-search/note.md`);
		const exact = await runner.run("grep -n privateneedle private-search/note.md");
		expect(exact.metadata.exitCode).toBe(0);
		expect(exact.stdout).toContain("1:privateneedle");
		const recursive = await runner.run("grep -R privateneedle private-search");
		expect(recursive.metadata.exitCode).toBe(0);
		expect(recursive.stdout).toContain(`${test_db_files_mount}/private-search/note.md`);
		const tree = await runner.run("tree private-search --limit 10");
		expect(tree.metadata.exitCode).toBe(0);
		expect(tree.stdout).toContain("|-- note.md");
		const search = await runner.run("search --path private-search privateneedle");
		expect(search.metadata.exitCode).toBe(0);
		expect(search.stdout).toContain(`${test_db_files_mount}/private-search/note.md`);
		const textgrep = await runner.run("textgrep -F privateneedle private-search/note.md");
		expect(textgrep.metadata.exitCode).toBe(0);
		expect(textgrep.stdout).toBe("privateneedle\n");
		const textgrepRecursive = await runner.run("textgrep -R privateneedle private-search");
		expect(textgrepRecursive.metadata.exitCode).toBe(0);
		expect(textgrepRecursive.stdout).toContain(`${test_db_files_mount}/private-search/note.md`);
	});

	test("private metadata writes keep frontmatter and text searchable", async () => {
		const runner = await create_bash_runner();
		const written = await runner.run(
			"printf '%s\\n' '---' 'status: draft' '---' 'privatemetadataword' > private-meta/note.md",
		);
		expect(written.metadata.exitCode).toBe(0);
		const tool = ai_chat_tool_create_set_file_metadata(runner.ctx, runner.ctxData);
		for (const path of ["/private-meta", "/private-meta/note.md"]) {
			expect(
				await tool.execute?.(
					{ path, set: [{ key: "source", value: "draft-copy" }], remove: [] },
					{ toolCallId: `metadata-${path}`, messages: [] },
				),
			).toMatchObject({ metadata: { path } });
			const read = await runner.run(`meta get ${test_db_files_mount}${path} --format json`);
			expect(read.stderr).toBe("");
			expect(read.metadata.exitCode).toBe(0);
			expect(JSON.parse(read.stdout)).toMatchObject({
				target: { kind: "private" },
				sourceKind: "pending",
				values: expect.arrayContaining([{ field: "metadata.source", valueKind: "string", value: "draft-copy" }]),
			});
		}
		const frontmatter = await runner.run(
			`meta search --path private-meta --where '{"eq":["frontmatter.status","draft"]}'`,
		);
		expect(frontmatter.stderr).toBe("");
		expect(frontmatter.metadata.exitCode).toBe(0);
		expect(frontmatter.stdout).toBe(`${test_db_files_mount}/private-meta/note.md\n`);
		const metadata = await runner.run(`meta search --where '{"eq":["metadata.source","draft-copy"]}' --format json`);
		expect(metadata.metadata.exitCode).toBe(0);
		expect(JSON.parse(metadata.stdout).results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: `${test_db_files_mount}/private-meta`,
					target: { kind: "private", id: expect.any(String) },
				}),
				expect.objectContaining({
					path: `${test_db_files_mount}/private-meta/note.md`,
					target: { kind: "private", id: expect.any(String) },
				}),
			]),
		);
		const text = await runner.run("grep -R privatemetadataword private-meta");
		expect(text.metadata.exitCode).toBe(0);
		expect(text.stdout).toContain(`${test_db_files_mount}/private-meta/note.md`);
	});

	test("redirect overwrite and append on an existing file stay pending proposals", async () => {
		// Pending upserts fetch the committed base yjs snapshot, so the target needs a real one.
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/docs/existing.md", content: "committed body\n", withRealYjsSnapshot: true }],
		});

		const overwritten = await runner.run(
			`printf replaced > ${test_db_files_mount}/docs/existing.md && cat ${test_db_files_mount}/docs/existing.md`,
		);
		expect(overwritten.metadata.exitCode).toBe(0);
		// A Markdown file's pending content is rendered Markdown text, which POSIX-terminates
		// non-empty content with one newline (plain-text files store bytes exactly).
		expect(overwritten.stdout).toBe("replaced\n");

		const appended = await runner.run(
			`printf ' extra' >> ${test_db_files_mount}/docs/existing.md && cat ${test_db_files_mount}/docs/existing.md`,
		);
		expect(appended.metadata.exitCode).toBe(0);
		// Append builds on the user's own pending content, which already carries rich text's
		// trailing newline, so the appended run starts on a new line.
		expect(appended.stdout).toBe("replaced\n extra\n");

		const existingNode = await get_seeded_node(runner, "/docs/existing.md");
		const pendingRows = await list_pending_updates(runner);
		expect(pendingRows).toHaveLength(1);
		expect(pendingRows[0]!.target).toEqual({ kind: "saved", id: existingNode._id });
		// A saved file never becomes a private creation proposal.
		expect(pendingRows[0]!.createIntent).toBeUndefined();
	});

	test("redirect overwrite on a file with collaboration off stays a pending proposal", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/docs/off.md", content: "committed body\n", nonCollaborative: true }],
		});
		const nodeBefore = await get_seeded_node(runner, "/docs/off.md");

		const overwritten = await runner.run(
			`printf replaced > ${test_db_files_mount}/docs/off.md && cat ${test_db_files_mount}/docs/off.md`,
		);
		expect(overwritten.stderr).toBe("");
		expect(overwritten.metadata.exitCode).toBe(0);
		// Same as a collaborative file: the proposal is rendered Markdown, which ends with one newline.
		expect(overwritten.stdout).toBe("replaced\n");

		// The proposal is built from the saved text, so it records that text's asset as its base.
		// The file itself did not change and still has no Yjs document.
		const pendingRows = await list_pending_updates(runner);
		expect(pendingRows).toHaveLength(1);
		expect(pendingRows[0]!.target).toEqual({ kind: "saved", id: nodeBefore._id });
		expect(pendingRows[0]!.content?.base).toEqual({ kind: "asset", assetId: nodeBefore.assetId });
		expect(pendingRows[0]!.createIntent).toBeUndefined();
		const nodeAfter = await get_seeded_node(runner, "/docs/off.md");
		expect(nodeAfter.assetId).toBe(nodeBefore.assetId);
		expect(nodeAfter.collaborationEnabled).toBe(false);
		expect(nodeAfter.yjsSnapshotId).toBeNull();
		expect(await read_committed_text(runner, nodeBefore._id)).toBe("committed body\n");

		// A second write builds on the agent's own proposal and keeps the same doc.
		const appended = await runner.run(
			`printf ' extra' >> ${test_db_files_mount}/docs/off.md && cat ${test_db_files_mount}/docs/off.md`,
		);
		expect(appended.stderr).toBe("");
		expect(appended.stdout).toBe("replaced\n extra\n");
		const rowsAfterAppend = await list_pending_updates(runner);
		expect(rowsAfterAppend).toHaveLength(1);
		expect(rowsAfterAppend[0]!._id).toBe(pendingRows[0]!._id);
	});

	test("a member save hides the stale proposal from reads and append prepares it automatically", async () => {
		const path = `${test_db_files_mount}/docs/off-stale.txt`;
		const runner = await create_bash_runner({
			extraFiles: [
				{
					path: "/docs/off-stale.txt",
					content: "committed needle\nsecond line\n",
					contentType: "text/plain;charset=utf-8",
					nonCollaborative: true,
				},
			],
		});
		const nodeBefore = await get_seeded_node(runner, "/docs/off-stale.txt");
		const proposed = await runner.run(`printf 'proposal needle\\nsecond line\\n' > ${path}`);
		expect(proposed.stderr).toBe("");
		const [row] = await list_pending_updates(runner);
		expect(row?.content?.base).toEqual({ kind: "asset", assetId: nodeBefore.assetId });

		// A member saves the file: the proposal is out of date, so the agent reads the saved text.
		const memberSave = await runner_as_user(runner).action(api.files_nodes_content.replace_file_content, {
			membershipId: runner.seeded.membershipId,
			nodeId: nodeBefore._id,
			text: "committed needle\nsaved line\n",
		});
		expect(memberSave._nay).toBeUndefined();
		const read = await runner.run(`cat ${path} && wc -l ${path} && grep -n needle ${path}`);
		expect(read.stderr).toBe("");
		expect(read.stdout).toBe(`committed needle\nsaved line\n2 ${path}\n1:committed needle\n`);

		// Append prepares the old proposal before reading the text it will extend.
		const rewritten = await runner.run(`printf 'proposal again\\n' >> ${path} && cat ${path}`);
		expect(rewritten.stderr).toBe("");
		expect(rewritten.stdout).toBe("proposal needle\nsaved line\nproposal again\n");
		const rowsAfter = await list_pending_updates(runner);
		expect(rowsAfter).toHaveLength(1);
		expect(rowsAfter[0]!._id).toBe(row!._id);
		const nodeAfter = await get_seeded_node(runner, "/docs/off-stale.txt");
		expect(nodeAfter.assetId).not.toBe(nodeBefore.assetId);
		expect(rowsAfter[0]!.content?.base).toEqual({ kind: "asset", assetId: nodeAfter.assetId });
	});

	test.each(["append", "edit_file"] as const)(
		"%s recomputes when a proposal appears after a read with no family",
		async (operation) => {
			const filePath = "/docs/new-family.txt";
			const path = `${test_db_files_mount}${filePath}`;
			const runner = await create_bash_runner({
				extraFiles: [
					{ path: filePath, content: "old\n", contentType: "text/plain;charset=utf-8", nonCollaborative: true },
				],
			});
			const node = await get_seeded_node(runner, filePath);
			const readSpy = operation === "edit_file" ? runner.runAction : runner.runQuery;
			const readName =
				operation === "edit_file"
					? "files_nodes_content:get_file_last_available_text_content_by_path"
					: "files_nodes:read_file_content_from_chunks";
			const read = readSpy.getMockImplementation()!;
			let inserted = false;
			readSpy.mockImplementation(async (ref, args) => {
				const result = await read(ref, args);
				if (!inserted && function_name_of(ref) === readName && args.path === filePath) {
					inserted = true;
					await upsert_pending_update_for_test(runner, {
						target: { kind: "saved", id: node._id },
						unstagedText: "earlier proposal\nold\n",
					});
				}
				return result;
			});
			if (operation === "edit_file") {
				const edit = ai_chat_tool_create_edit_file(runner.ctx, {
					...runner.ctxData,
					getThreadId: () => runner.threadId,
				});
				await expect(
					edit.execute?.(
						{ path: filePath, oldString: "old", newString: "new", replaceAll: false },
						{ toolCallId: "new-family", messages: [] },
					),
				).resolves.toMatchObject({ metadata: { pendingUpdateId: expect.any(String), matches: 1 } });
			} else {
				const appended = await runner.run(`printf 'tail\\n' >> ${path}`);
				expect(appended.stderr).toBe("");
				expect(appended.metadata.exitCode).toBe(0);
			}
			expect(inserted).toBe(true);
			expect((await runner.run(`cat ${path}`)).stdout).toBe(
				operation === "append" ? "earlier proposal\nold\ntail\n" : "earlier proposal\nnew\n",
			);
			expect(await read_committed_text(runner, node._id)).toBe("old\n");
		},
	);

	test.each([
		["append", "saved"],
		["edit_file", "saved"],
		["append", "replaced"],
		["edit_file", "replaced"],
	] as const)("%s retries when the file is %s after its read without owner preparation", async (operation, race) => {
		const filePath = "/docs/preflight-race.txt";
		const path = `${test_db_files_mount}${filePath}`;
		const runner = await create_bash_runner({
			extraFiles: [
				{
					path: filePath,
					content: "first: old\nsecond: old\nthird: old\n",
					contentType: "text/plain;charset=utf-8",
					nonCollaborative: true,
				},
			],
		});
		const node = await get_seeded_node(runner, filePath);
		await upsert_pending_update_for_test(runner, {
			target: { kind: "saved", id: node._id },
			unstagedText: "first: proposal\nsecond: old\nthird: old\n",
		});
		const [pending] = await list_pending_updates(runner);
		if (!pending) throw new Error("Missing proposal");
		const readSpy = operation === "edit_file" ? runner.runAction : runner.runQuery;
		const readName =
			operation === "edit_file"
				? "files_nodes_content:get_file_last_available_text_content_by_path"
				: "files_nodes:read_file_content_from_chunks";
		const read = readSpy.getMockImplementation()!;
		let changed = false;
		readSpy.mockImplementation(async (ref, args) => {
			const result = await read(ref, args);
			if (!changed && function_name_of(ref) === readName && args.path === filePath) {
				changed = true;
				if (race === "saved") {
					const saved = await runner_as_user(runner).action(api.files_nodes_content.replace_file_content, {
						membershipId: runner.seeded.membershipId,
						nodeId: node._id,
						text: "first: old\nsecond: member\nthird: old\n",
					});
					expect(saved._nay).toBeUndefined();
				} else {
					const discarded = await runner_as_user(runner).mutation(
						api.files_pending_updates.discard_file_pending_content,
						{
							membershipId: runner.seeded.membershipId,
							target: { kind: "saved", id: node._id },
							pendingUpdateId: pending._id,
							reviewedRevision: pending.revision,
						},
					);
					expect(discarded._nay).toBeUndefined();
					await upsert_pending_update_for_test(runner, {
						target: { kind: "saved", id: node._id },
						unstagedText: "first: replacement\nsecond: old\nthird: old\n",
					});
				}
			}
			return result;
		});
		const preparedText =
			race === "saved"
				? "first: proposal\nsecond: member\nthird: old\n"
				: "first: replacement\nsecond: old\nthird: old\n";
		if (operation === "edit_file") {
			const edit = ai_chat_tool_create_edit_file(runner.ctx, { ...runner.ctxData, getThreadId: () => runner.threadId });
			await expect(
				edit.execute?.(
					{ path: filePath, oldString: "third: old", newString: "third: tool", replaceAll: false },
					{ toolCallId: "preflight-race", messages: [] },
				),
			).resolves.toMatchObject({ metadata: { pendingUpdateId: expect.any(String), matches: 1 } });
		} else {
			const appended = await runner.run(`printf 'tail\\n' >> ${path}`);
			expect(appended.stderr).toBe("");
			expect(appended.metadata.exitCode).toBe(0);
		}
		expect(changed).toBe(true);
		expect((await runner.run(`cat ${path}`)).stdout).toBe(
			operation === "append" ? `${preparedText}tail\n` : preparedText.replace("third: old", "third: tool"),
		);
	});

	test("append stops after a second content-family change without losing the latest proposal", async () => {
		const filePath = "/docs/append-retry-limit.txt";
		const path = `${test_db_files_mount}${filePath}`;
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: filePath, content: "old\n", contentType: "text/plain;charset=utf-8", nonCollaborative: true },
			],
		});
		const node = await get_seeded_node(runner, filePath);
		const read = runner.runQuery.getMockImplementation()!;
		let races = 0;
		runner.runQuery.mockImplementation(async (ref, args) => {
			const result = await read(ref, args);
			if (
				races < 2 &&
				function_name_of(ref) === "files_nodes:read_file_content_from_chunks" &&
				args.path === filePath
			) {
				races += 1;
				await upsert_pending_update_for_test(runner, {
					target: { kind: "saved", id: node._id },
					unstagedText: `proposal ${races}\nold\n`,
				});
			}
			return result;
		});
		const appended = await runner.run(`printf 'tail\\n' >> ${path}`);
		expect(appended.metadata.exitCode).not.toBe(0);
		expect(appended.stderr).toContain("The proposal changed after it was read.");
		expect(races).toBe(2);
		expect((await runner.run(`cat ${path}`)).stdout).toBe("proposal 2\nold\n");
	});

	test.each(["overwrite", "edit_file"] as const)(
		"%s names a stored file's type before preparation",
		async (operation) => {
			const filePath = "/docs/image.png";
			const runner = await create_bash_runner({
				extraFiles: [{ path: filePath, content: "stored bytes", contentType: "image/png", withoutYjsState: true }],
			});
			const message = "this file's content type ('image/png') is not editable as text";
			if (operation === "edit_file") {
				const edit = ai_chat_tool_create_edit_file(runner.ctx, {
					...runner.ctxData,
					getThreadId: () => runner.threadId,
				});
				await expect(
					edit.execute?.(
						{ path: filePath, oldString: "old", newString: "new", replaceAll: false },
						{ toolCallId: "stored-type", messages: [] },
					),
				).rejects.toThrow(message);
			} else {
				const written = await runner.run(`printf replacement > ${test_db_files_mount}${filePath}`);
				expect(written.metadata.exitCode).not.toBe(0);
				expect(written.stderr).toContain(message);
			}
			expect(
				runner.runAction.mock.calls.filter(
					([ref]) => function_name_of(ref) === "files_pending_updates:prepare_file_pending_update_for_agent",
				),
			).toHaveLength(0);
			expect(await list_pending_updates(runner)).toEqual([]);
		},
	);

	test("a full overwrite prepares a stale proposal and keeps its staged branch", async () => {
		const filePath = "/docs/staged-overwrite.txt";
		const path = `${test_db_files_mount}${filePath}`;
		const runner = await create_bash_runner({
			extraFiles: [
				{
					path: filePath,
					content: "first: old\nsecond: old\nthird: old\n",
					contentType: "text/plain;charset=utf-8",
					nonCollaborative: true,
				},
			],
		});
		const node = await get_seeded_node(runner, filePath);
		await upsert_pending_update_for_test(runner, {
			target: { kind: "saved", id: node._id },
			stagedText: "first: staged\nsecond: old\nthird: old\n",
			unstagedText: "first: staged\nsecond: proposed\nthird: old\n",
		});
		const saved = await runner_as_user(runner).action(api.files_nodes_content.replace_file_content, {
			membershipId: runner.seeded.membershipId,
			nodeId: node._id,
			text: "first: old\nsecond: old\nthird: member\n",
		});
		expect(saved._nay).toBeUndefined();
		const overwritten = await runner.run(`printf 'replacement\\n' > ${path} && cat ${path}`);
		expect(overwritten.stderr).toBe("");
		expect(overwritten.stdout).toBe("replacement\n");
		await save_pending_update_for_test(runner, node._id);
		expect(await read_committed_text(runner, node._id)).toBe("first: staged\nsecond: old\nthird: member\n");
	});

	test.each([
		["append", true, false],
		["append", false, false],
		["edit_file", true, false],
		["edit_file", false, false],
		["overwrite", true, false],
		["append", true, true],
	] as const)(
		"%s recomputes after a proposal changes during its read (already stale: %s, accepted: %s)",
		async (operation, staleAtRead, accepted) => {
			const filePath = "/docs/read-race.txt";
			const path = `${test_db_files_mount}${filePath}`;
			const savedText = "first: old\nsecond: member\nthird: old\n";
			const preparedText = "first: proposal\nsecond: member\nthird: old\n";
			const runner = await create_bash_runner({
				extraFiles: [
					{
						path: filePath,
						content: "first: old\nsecond: old\nthird: old\n",
						contentType: "text/plain;charset=utf-8",
						nonCollaborative: true,
					},
				],
			});
			const node = await get_seeded_node(runner, filePath);
			const proposed = await runner.run(`printf 'first: proposal\\nsecond: old\\nthird: old\\n' > ${path}`);
			expect(proposed.stderr).toBe("");
			expect(proposed.metadata.exitCode).toBe(0);
			const [originalPending] = await list_pending_updates(runner);
			if (!originalPending) throw new Error("Missing proposal");
			const asUser = runner_as_user(runner);
			const saveArgs = { membershipId: runner.seeded.membershipId, nodeId: node._id, text: savedText };
			if (staleAtRead) {
				expect(
					(
						await asUser.action(api.files_nodes_content.replace_file_content, {
							...saveArgs,
							text: "first: old\nsecond: intermediate\nthird: old\n",
						})
					)._nay,
				).toBeUndefined();
			}

			let preparedPending = originalPending;
			let preparedNode = node;
			let preparedAfterRead = false;
			const readSpy = operation === "edit_file" ? runner.runAction : runner.runQuery;
			const readFunctionName =
				operation === "edit_file"
					? "files_nodes_content:get_file_last_available_text_content_by_path"
					: "files_nodes:read_file_content_from_chunks";
			const read = readSpy.getMockImplementation()!;
			readSpy.mockImplementation(async (ref, args) => {
				const result = await read(ref, args);
				if (!preparedAfterRead && function_name_of(ref) === readFunctionName && args.path === filePath) {
					// Another preparation can replace the fresh family before its write starts.
					expect((await asUser.action(api.files_nodes_content.replace_file_content, saveArgs))._nay).toBeUndefined();
					const prepared = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, {
						membershipId: runner.seeded.membershipId,
						target: { kind: "saved", id: node._id },
						pendingUpdateId: originalPending._id,
					});
					expect(prepared._nay).toBeUndefined();
					const [pending] = await list_pending_updates(runner);
					if (!pending) throw new Error("Missing prepared proposal");
					preparedPending = pending;
					if (accepted) {
						await accept_pending_update_for_test(runner, { nodeId: node._id, path: filePath });
						expect(await list_pending_updates(runner)).toEqual([]);
					}
					preparedNode = await get_seeded_node(runner, filePath);
					expect(preparedPending.content?.baseStateId).not.toBe(originalPending.content?.baseStateId);
					preparedAfterRead = true;
				}
				return result;
			});

			if (operation === "edit_file") {
				const tool = ai_chat_tool_create_edit_file(runner.ctx, {
					...runner.ctxData,
					getThreadId: () => runner.threadId,
				});
				await expect(
					tool.execute?.(
						{ path: filePath, oldString: "third: old", newString: "third: tool", replaceAll: false },
						{ toolCallId: "read-race", messages: [] },
					),
				).resolves.toMatchObject({ metadata: { pendingUpdateId: expect.any(String), matches: 1 } });
			} else {
				const written = await runner.run(
					operation === "append" ? `printf 'tool tail\\n' >> ${path}` : `printf 'replacement\\n' > ${path}`,
				);
				expect(written.metadata.exitCode).toBe(0);
				expect(written.stderr).toBe("");
			}
			expect(preparedAfterRead).toBe(true);
			expect(await list_pending_updates(runner)).toHaveLength(1);
			expect((await runner.run(`cat ${path}`)).stdout).toBe(
				operation === "overwrite"
					? "replacement\n"
					: operation === "append"
						? `${preparedText}tool tail\n`
						: preparedText.replace("third: old", "third: tool"),
			);
			expect(await get_seeded_node(runner, filePath)).toEqual(preparedNode);
			expect(await read_committed_text(runner, node._id)).toBe(accepted ? preparedText : savedText);
			const batches = await runner.t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect());
			expect(batches.every((batch) => batch.expiresAt === 0)).toBe(true);
		},
	);

	test.each([
		[false, "txt"],
		[true, "txt"],
		[false, "md"],
		[true, "md"],
	] as const)(
		"a mode toggle hides proposals from reads and append prepares them (OFF %s, %s)",
		async (nonCollaborative, extension) => {
			const filePath = `/docs/toggle-pending.${extension}`;
			const path = `${test_db_files_mount}${filePath}`;
			const committed = extension === "md" ? "---\nstatus: saved\n---\n\ncommitted needle\n" : "committed needle\n";
			const proposed = extension === "md" ? "---\nstatus: proposed\n---\n\nproposal needle\n" : "proposal needle\n";
			const runner = await create_bash_runner({
				extraFiles: [
					{
						path: filePath,
						content: committed,
						contentType: extension === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8",
						nonCollaborative,
						withRealYjsSnapshot: !nonCollaborative,
					},
				],
			});
			const node = await get_seeded_node(runner, filePath);
			const write = await runner.run(`cat > ${path} <<'EOF'\n${proposed}EOF`);
			expect(write.stderr).toBe("");
			expect(write.metadata.exitCode).toBe(0);
			expect((await runner.run(`cat ${path}`)).stdout).toBe(proposed);
			const pendingSearch = await runner.run(`search --path ${test_db_files_mount}/docs proposal`);
			expect(pendingSearch.metadata.exitCode).toBe(0);
			expect(pendingSearch.stdout).toContain(path);
			if (extension === "md") {
				const pendingMetadata = await runner.run(`meta search --where '{"eq":["frontmatter.status","proposed"]}'`);
				expect(pendingMetadata.metadata.exitCode).toBe(0);
				expect(pendingMetadata.stdout).toContain(path);
			}
			const [pendingBefore] = await list_pending_updates_for_node(runner, node._id);

			const toggle = nonCollaborative
				? await runner_as_user(runner).action(api.files_nodes_content.set_file_collaborative, {
						membershipId: runner.seeded.membershipId,
						nodeId: node._id,
					})
				: await runner_as_user(runner).mutation(api.files_nodes_content.set_file_non_collaborative, {
						membershipId: runner.seeded.membershipId,
						nodeId: node._id,
						acknowledgeDropCollaborativeHistory: true,
					});
			expect(toggle._nay).toBeUndefined();
			await drain_scheduled_continuations(runner);

			const read = await runner.run(`cat ${path} && wc -c ${path} && grep -n needle ${path}`);
			expect(read.stderr).toBe("");
			expect(read.stdout).toBe(
				`${committed}${new TextEncoder().encode(committed).byteLength} ${path}\n${extension === "md" ? 5 : 1}:committed needle\n`,
			);
			const hiddenSearch = await runner.run(`search --path ${test_db_files_mount}/docs proposal`);
			expect(hiddenSearch.metadata.exitCode).toBe(0);
			expect(hiddenSearch.stdout).not.toContain(path);
			const committedSearch = await runner.run(`search --path ${test_db_files_mount}/docs committed`);
			expect(committedSearch.metadata.exitCode).toBe(0);
			expect(committedSearch.stdout).toContain(path);
			if (extension === "md") {
				const hiddenMetadata = await runner.run(`meta search --where '{"eq":["frontmatter.status","proposed"]}'`);
				expect(hiddenMetadata.metadata.exitCode).toBe(0);
				expect(hiddenMetadata.stdout).not.toContain(path);
				const committedMetadata = await runner.run(`meta search --where '{"eq":["frontmatter.status","saved"]}'`);
				expect(committedMetadata.metadata.exitCode).toBe(0);
				expect(committedMetadata.stdout).toContain(path);
			}

			const appended = await runner.run(`printf 'agent tail\\n' >> ${path} && cat ${path}`);
			expect(appended.metadata.exitCode).toBe(0);
			expect(appended.stderr).toBe("");
			expect(appended.stdout).toBe(`${proposed}agent tail\n`);
			const [pendingAfter] = await list_pending_updates_for_node(runner, node._id);
			expect(pendingAfter?._id).toBe(pendingBefore?._id);
			expect(pendingAfter?.contentNeedsRebase).toBeUndefined();
			expect(await read_committed_text(runner, node._id)).toBe(committed);
		},
	);

	test("heredoc redirect writes a multi-line pending proposal", async () => {
		const runner = await create_bash_runner();

		const heredoc = await runner.run(
			[
				`cat > ${test_db_files_mount}/heredoc.md <<'EOF'`,
				"# Title",
				"",
				"Body line",
				"EOF",
				`cat ${test_db_files_mount}/heredoc.md`,
			].join("\n"),
		);
		expect(heredoc.metadata.exitCode).toBe(0);
		expect(heredoc.stderr).toBe("");
		// A new file's baseline is empty, so the content is stored exactly as written,
		// including the heredoc's trailing newline.
		expect(heredoc.stdout).toBe("# Title\n\nBody line\n");
	});

	test("keeps the trailing newline on new files so appends start a new line", async () => {
		const runner = await create_bash_runner();

		const result = await runner.run(
			`printf 'one\\n' > ${test_db_files_mount}/lines.md && printf 'two\\n' >> ${test_db_files_mount}/lines.md && cat ${test_db_files_mount}/lines.md`,
		);
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe("one\ntwo\n");
	});

	test("bare redirect truncation becomes a pending empty-content proposal", async () => {
		// Pending upserts fetch the committed base yjs snapshot, so the target needs a real one.
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/docs/existing.md", content: "committed body\n", withRealYjsSnapshot: true }],
		});

		const truncated = await runner.run(`> ${test_db_files_mount}/docs/existing.md`);
		expect(truncated.metadata.exitCode).toBe(0);

		// The next bash call still sees the pending truncation; the committed file is untouched.
		const readBack = await runner.run(`cat ${test_db_files_mount}/docs/existing.md`);
		expect(readBack.metadata.exitCode).toBe(0);
		expect(readBack.stdout).toBe("");

		const existingNode = await get_seeded_node(runner, "/docs/existing.md");
		const pendingRows = await list_pending_updates(runner);
		expect(pendingRows).toHaveLength(1);
		expect(pendingRows[0]!.target).toEqual({ kind: "saved", id: existingNode._id });
	});

	test("touch creates an empty-file pending proposal and is a no-op on existing files", async () => {
		const runner = await create_bash_runner();

		const created = await runner.run(`touch ${test_db_files_mount}/new-note.md`);
		expect(created.metadata.exitCode).toBe(0);
		expect(created.stderr).toBe("");
		expect(created.stdout).toBe("");

		const draft = await get_private_entry(runner, "/new-note.md");
		const pendingRows = await list_pending_updates(runner);
		expect(pendingRows).toHaveLength(1);
		expect(pendingRows[0]!.target).toEqual({ kind: "private", id: draft.node._id });
		expect(pendingRows[0]!.content?.base).toEqual({ kind: "new" });
		expect((await runner.run(`cat ${test_db_files_mount}/new-note.md`)).stdout).toBe("");

		const existing = await runner.run(`touch ${test_db_files_mount}/docs/readme.md`);
		expect(existing.metadata.exitCode).toBe(0);
		expect(existing.stderr).toBe("");
		// utimes is a no-op for app files: no new proposal on the existing file.
		expect(await list_pending_updates(runner)).toHaveLength(1);
	});

	test("refuses creating a file at a silently normalized path but overwrites an existing normalized target", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/docs/my-note.md", content: "note body\n", withRealYjsSnapshot: true }],
		});
		const before = await runner.t.run((ctx) => ctx.db.query("files_nodes").collect());

		// A missing dot-leading target would be created as 'hidden.md'; refuse instead of
		// silently writing a different path than the shell reported success for.
		const dotted = await runner.run(`printf x > ${test_db_files_mount}/.hidden.md`);
		expect(dotted.metadata.exitCode).not.toBe(0);
		expect(dotted.stderr).toContain("app file names are normalized");
		expect(dotted.stderr).toContain(`${test_db_files_mount}/hidden.md`);
		expect(
			runner.runMutation.mock.calls.some(
				([ref]) => function_name_of(ref) === "files_nodes:create_private_node_by_path",
			),
		).toBe(false);
		expect(await list_pending_updates(runner)).toHaveLength(0);
		expect(await runner.t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
		expect(await runner.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);

		// When the normalized name lands on an existing file, that file is the overwrite
		// target (cp's replace-target behavior), not a rejected create.
		const normalizedHit = await runner.run(
			`printf replaced > '${test_db_files_mount}/docs/my note.md' && cat ${test_db_files_mount}/docs/my-note.md`,
		);
		expect(normalizedHit.metadata.exitCode).toBe(0);
		// Rendered Markdown text POSIX-terminates the pending content.
		expect(normalizedHit.stdout).toBe("replaced\n");
		const noteNode = await get_seeded_node(runner, "/docs/my-note.md");
		const pendingRows = await list_pending_updates(runner);
		expect(pendingRows).toHaveLength(1);
		expect(pendingRows[0]!.target).toEqual({ kind: "saved", id: noteNode._id });
		expect(pendingRows[0]!.createIntent).toBeUndefined();
	});

	test("normalizes special file names on new Bash writes without renaming existing files", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/legacy/readme.md", content: "legacy\n", withRealYjsSnapshot: true },
				{ path: "/legacy/readme", content: "legacy bare\n", withRealYjsSnapshot: true },
				{ path: "/legacy/README.md", content: "canonical sibling\n", withRealYjsSnapshot: true },
			],
		});
		for (const [input, path] of [
			["/.agents/skills/one/skill.md", "/.agents/skills/one/SKILL.md"],
			["/instructions/agents.md", "/instructions/AGENTS.md"],
			["/instructions/readme.md", "/instructions/README.md"],
			["/new/readme", "/new/README.md"],
		] as const) {
			const written = await runner.run(`printf 'saved body' > ${test_db_files_mount}${input}`);
			expect(written.metadata.exitCode, written.stderr).toBe(0);
			expect((await get_private_entry(runner, path)).path).toBe(path);
		}
		for (const name of ["readme.md", "readme"]) {
			const nodeId = await get_seeded_node_id(runner, `/legacy/${name}`);
			const existing = await runner.run(`printf 'existing body' > ${test_db_files_mount}/legacy/${name}`);
			expect(existing.metadata.exitCode, existing.stderr).toBe(0);
			expect((await get_seeded_node(runner, `/legacy/${name}`))._id).toBe(nodeId);
		}
		expect((await runner.run(`cat ${test_db_files_mount}/legacy/README.md`)).stdout).toBe("canonical sibling\n");
	});

	test("uses README.md for new bare readme copy and move destinations", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/legacy/readme", content: "legacy\n", withRealYjsSnapshot: true },
				{ path: "/copies", kind: "folder" },
				{ path: "/moved", kind: "folder" },
			],
		});
		for (const destination of ["/copies", "/docs/readme"]) {
			const copied = await runner.run(`cp ${test_db_files_mount}/legacy/readme ${test_db_files_mount}${destination}`);
			expect(copied.metadata.exitCode, copied.stderr).toBe(0);
		}
		expect((await get_private_entry(runner, "/copies/README.md")).node.name).toBe("README.md");
		expect((await get_private_entry(runner, "/docs/README.md")).node.name).toBe("README.md");
		const moved = await runner.run(`mv ${test_db_files_mount}/legacy/readme ${test_db_files_mount}/moved/readme`);
		expect(moved.metadata.exitCode, moved.stderr).toBe(0);
		expect(await list_pending_updates(runner)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ pendingMove: expect.objectContaining({ destName: "README.md" }) }),
			]),
		);
	});

	test("normalizes special destinations for Bash cp and mv", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/legacy/readme.md", content: "legacy\n", withRealYjsSnapshot: true }],
		});
		const copied = await runner.run(`cp ${test_db_files_mount}/legacy/readme.md ${test_db_files_mount}/docs/skill.md`);
		expect(copied.metadata.exitCode, copied.stderr).toBe(0);
		expect((await get_private_entry(runner, "/docs/SKILL.md")).path).toBe("/docs/SKILL.md");
		const moved = await runner.run(`mv ${test_db_files_mount}/legacy/readme.md ${test_db_files_mount}/docs/agents.md`);
		expect(moved.metadata.exitCode, moved.stderr).toBe(0);
		expect(await list_pending_updates(runner)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ pendingMove: expect.objectContaining({ destName: "AGENTS.md" }) }),
			]),
		);
	});

	test.each(["missing", "literal", "canonical no-clobber"] as const)(
		"cp into a folder resolves special names for a %s child",
		async (destination) => {
			const destinationPath = "/.agents/skills/summarize";
			const runner = await create_bash_runner({
				extraFiles: [
					{ path: "/templates/skill.md", content: "Saved skill body\n", withRealYjsSnapshot: true },
					{ path: destinationPath, kind: "folder" },
					...(destination === "literal"
						? [{ path: `${destinationPath}/skill.md`, content: "Legacy target\n", withRealYjsSnapshot: true }]
						: []),
					...(destination !== "missing"
						? [{ path: `${destinationPath}/SKILL.md`, content: "Canonical sibling\n", withRealYjsSnapshot: true }]
						: []),
				],
			});
			const literalId =
				destination === "literal" ? await get_seeded_node_id(runner, `${destinationPath}/skill.md`) : null;
			const canonicalId =
				destination !== "missing" ? await get_seeded_node_id(runner, `${destinationPath}/SKILL.md`) : null;
			const copied = await runner.run(
				`cp ${destination === "canonical no-clobber" ? "-n " : ""}${test_db_files_mount}/templates/skill.md ${test_db_files_mount}${destinationPath}`,
			);
			expect(copied.metadata.exitCode, copied.stderr).toBe(0);
			if (destination === "canonical no-clobber") {
				expect(copied.stdout).toMatch(
					/^Transfer \S+: 0 ready for review, 1 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
				);
				expect(await list_pending_updates(runner)).toEqual([]);
			} else {
				const expectedPath = `${destinationPath}/${literalId ? "skill.md" : "SKILL.md"}`;
				expect(copied.stdout).toMatch(
					/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
				);
				if (literalId) {
					expect((await get_seeded_node(runner, expectedPath))._id).toBe(literalId);
					expect(await list_pending_updates(runner)).toEqual([
						expect.objectContaining({ target: { kind: "saved", id: literalId } }),
					]);
					await accept_pending_replacement_for_test(runner, literalId);
					expect(await read_committed_text(runner, literalId)).toBe("Saved skill body\n");
				} else {
					const draft = await get_private_entry(runner, expectedPath);
					expect(await list_pending_updates(runner)).toEqual([
						expect.objectContaining({ target: { kind: "private", id: draft.node._id } }),
					]);
					const savedId = await save_private_copy_for_test(runner, expectedPath);
					expect(await read_committed_text(runner, savedId)).toBe("Saved skill body\n");
				}
			}
			if (canonicalId) {
				expect((await get_seeded_node(runner, `${destinationPath}/SKILL.md`))._id).toBe(canonicalId);
				expect(await read_committed_text(runner, canonicalId)).toBe("Canonical sibling\n");
			}
			if (!literalId) {
				const literal = await runner.t.query(internal.files_nodes.get_by_path, {
					organizationId: runner.seeded.organizationId,
					workspaceId: runner.seeded.workspaceId,
					visibilityUserId: runner.seeded.userId,
					path: `${destinationPath}/skill.md`,
				});
				expect(literal).toBeNull();
			}
		},
	);

	test.each(["cp folder", "cp file", "write", "mkdir"] as const)(
		"%s refuses a hidden special-name target without changing visible siblings",
		async (door) => {
			const owner = await create_bash_runner({
				extraFiles: [
					{ path: "/templates/skill.md", content: "Source text\n", withRealYjsSnapshot: true },
					{ path: "/destination/skill.md", content: "Hidden legacy text\n", withRealYjsSnapshot: true },
					{ path: "/destination/SKILL.md", content: "Visible sibling\n", withRealYjsSnapshot: true },
					...(door === "mkdir" ? [{ path: "/.agents", kind: "folder" as const }] : []),
				],
			});
			const literalId = await get_seeded_node_id(owner, "/destination/skill.md");
			const canonicalId = await get_seeded_node_id(owner, "/destination/SKILL.md");
			const hiddenPath = door === "mkdir" ? "/.agents" : "/destination/skill.md";
			const hiddenId = await get_seeded_node_id(owner, hiddenPath);
			const member = await owner.t.run(async (ctx) => {
				const userId = await ctx.db.insert("users", { clerkUserId: "literal-member" });
				await test_mocks_fill_db_with.plan(ctx, { userId, plan: "Pay As You Go" });
				const membershipId = await ctx.db.insert("organizations_workspaces_users", {
					organizationId: owner.seeded.organizationId,
					workspaceId: owner.seeded.workspaceId,
					userId,
					active: true,
					updatedAt: Date.now(),
				});
				await access_control_db_ensure_role_assignment(ctx, {
					organizationId: owner.seeded.organizationId,
					workspaceId: owner.seeded.workspaceId,
					userId,
					role: "member",
					now: Date.now(),
				});
				await ctx.db.patch("files_nodes", hiddenId, { restrictedScopeNodeId: hiddenId });
				return { userId, membershipId };
			});
			const runner = await create_bash_runner({ shared: { t: owner.t, seeded: { ...owner.seeded, ...member } } });
			expect(
				await runner.t.query(internal.files_nodes.get_by_path, {
					organizationId: runner.seeded.organizationId,
					workspaceId: runner.seeded.workspaceId,
					visibilityUserId: member.userId,
					path: hiddenPath,
				}),
			).toBeNull();
			const command =
				door === "mkdir"
					? `mkdir -p ${test_db_files_mount}/.AGENTS`
					: door === "write"
						? `printf changed > ${test_db_files_mount}/destination/skill.md`
						: `cp ${test_db_files_mount}/templates/skill.md ${test_db_files_mount}/destination${door === "cp file" ? "/skill.md" : ""}`;
			const refused = await runner.run(command);
			expect(refused.metadata.exitCode).not.toBe(0);
			expect(await list_pending_updates(runner)).toEqual([]);
			expect(await read_committed_text(owner, literalId)).toBe("Hidden legacy text\n");
			expect(await read_committed_text(owner, canonicalId)).toBe("Visible sibling\n");
		},
	);

	test("tee writes app targets as pending proposals", async () => {
		const runner = await create_bash_runner();

		const teed = await runner.run(`printf hi | tee /tmp/out.txt ${test_db_files_mount}/tee-note.md`);
		expect(teed.metadata.exitCode).toBe(0);
		expect(teed.stderr).toBe("");
		expect(teed.stdout).toBe("hi");

		const readBack = await runner.run(`cat ${test_db_files_mount}/tee-note.md && cat /tmp/out.txt`);
		expect(readBack.metadata.exitCode).toBe(0);
		// The app file serves rendered Markdown text (POSIX newline); /tmp keeps the raw bytes.
		expect(readBack.stdout).toBe("hi\nhi");

		const appendTee = await runner.run(`printf ' more' | tee -a ${test_db_files_mount}/tee-note.md`);
		expect(appendTee.metadata.exitCode).toBe(0);
		expect(appendTee.stdout).toBe(" more");
		const appendRead = await runner.run(`cat ${test_db_files_mount}/tee-note.md`);
		expect(appendRead.stdout).toBe("hi\n more\n");

		// A folder target surfaces the real error instead of the builtin's generic message.
		const folderTee = await runner.run(`printf hi | tee ${test_db_files_mount}/docs`);
		expect(folderTee.metadata.exitCode).not.toBe(0);
		expect(folderTee.stderr).toContain("EISDIR");
	});

	test("tee mirrors builtin option handling before writing app targets", async () => {
		const runner = await create_bash_runner();

		// --help and invalid options delegate: the builtin exits before touching any file.
		const help = await runner.run(`printf hi | tee --help ${test_db_files_mount}/tee-opt.md`);
		expect(help.metadata.exitCode).toBe(0);
		expect(help.stdout).toContain("Usage: tee");
		const bogus = await runner.run(`printf hi | tee --bogus ${test_db_files_mount}/tee-opt.md`);
		expect(bogus.metadata.exitCode).not.toBe(0);
		expect(bogus.stderr).toContain("unrecognized option '--bogus'");
		const badCluster = await runner.run(`printf hi | tee -ax ${test_db_files_mount}/tee-opt.md`);
		expect(badCluster.metadata.exitCode).not.toBe(0);
		expect(badCluster.stderr).toContain("invalid option -- 'x'");
		expect(await list_pending_updates(runner)).toHaveLength(0);

		// A clustered append flag still appends instead of silently overwriting.
		const first = await runner.run(`printf hi | tee ${test_db_files_mount}/tee-opt.md`);
		expect(first.metadata.exitCode).toBe(0);
		const clustered = await runner.run(`printf ' more' | tee -aa ${test_db_files_mount}/tee-opt.md`);
		expect(clustered.metadata.exitCode).toBe(0);
		const readBack = await runner.run(`cat ${test_db_files_mount}/tee-opt.md`);
		// The rendered Markdown text's trailing newline puts the appended run on its own line.
		expect(readBack.stdout).toBe("hi\n more\n");
	});

	test.each([
		{ name: "data.json", contentType: "application/json", text: '{"port": 9090}' },
		{ name: "brief.html", contentType: "text/html;charset=utf-8", text: "<!doctype html><p>Brief</p>" },
		{ name: "brief.htm", contentType: "text/html;charset=utf-8", text: "<!doctype html><p>Brief</p>" },
	])("redirect into $name stores the bytes exactly", async ({ name, contentType, text }) => {
		const runner = await create_bash_runner();

		const written = await runner.run(`printf '${text}' > ${test_db_files_mount}/${name}`);
		// The named break-on-purpose line: a re-added Markdown-only write gate refuses here.
		expect(written.metadata.exitCode).toBe(0);
		expect(written.stderr).toBe("");

		// Read-back before byte equality: with the fix off, no file exists at this path.
		const draft = await get_private_entry(runner, `/${name}`);
		expect(draft.pendingUpdate.createIntent).toMatchObject({ kind: "text", contentType, textKind: "plain_text" });
		const pendingRows = await list_pending_updates(runner);
		expect(pendingRows).toHaveLength(1);
		expect(pendingRows[0]!.target).toEqual({ kind: "private", id: draft.node._id });

		// Byte equality: plain text stores bytes exactly, with no added newline.
		const readBack = await runner.run(`cat ${test_db_files_mount}/${name}`);
		expect(readBack.metadata.exitCode).toBe(0);
		expect(readBack.stdout).toBe(text);
	});

	test("heredoc and append writes to plain text files stay byte-exact", async () => {
		const runner = await create_bash_runner();

		const heredoc = await runner.run(
			[
				`cat > ${test_db_files_mount}/config.yaml <<'EOF'`,
				"service: files",
				"ports:",
				"  - 8080",
				"EOF",
				`cat ${test_db_files_mount}/config.yaml`,
			].join("\n"),
		);
		expect(heredoc.metadata.exitCode).toBe(0);
		expect(heredoc.stderr).toBe("");
		expect(heredoc.stdout).toBe("service: files\nports:\n  - 8080\n");

		// `>>` concatenates bytes, so no extra newline appears between the two writes.
		const appended = await runner.run(
			`printf 'a,b' > ${test_db_files_mount}/table.csv && printf ',c' >> ${test_db_files_mount}/table.csv && cat ${test_db_files_mount}/table.csv`,
		);
		expect(appended.metadata.exitCode).toBe(0);
		expect(appended.stdout).toBe("a,b,c");

		const yamlDraft = await get_private_entry(runner, "/config.yaml");
		expect(yamlDraft.pendingUpdate.createIntent).toMatchObject({
			kind: "text",
			contentType: "application/yaml",
			textKind: "plain_text",
		});
		const csvDraft = await get_private_entry(runner, "/table.csv");
		expect(csvDraft.pendingUpdate.createIntent).toMatchObject({
			kind: "text",
			contentType: "text/csv",
			textKind: "plain_text",
		});
	});

	test("an unknown extension and an extensionless name write plain text files", async () => {
		const runner = await create_bash_runner();

		// The name is only a hint for the stored type. An extension the app does not know
		// gives plain text, and the file keeps the name the agent typed.
		const exe = await runner.run(`printf x > ${test_db_files_mount}/tool.exe`);
		expect(exe.stderr).toBe("");
		expect(exe.metadata.exitCode).toBe(0);
		const exeDraft = await get_private_entry(runner, "/tool.exe");
		expect(exeDraft.pendingUpdate.createIntent).toMatchObject({
			contentType: "text/plain;charset=utf-8",
			textKind: "plain_text",
		});

		// No `.md` is added to an extensionless name.
		const extensionless = await runner.run(`printf x > ${test_db_files_mount}/data`);
		expect(extensionless.stderr).toBe("");
		expect(extensionless.metadata.exitCode).toBe(0);
		const dataDraft = await get_private_entry(runner, "/data");
		expect(dataDraft.pendingUpdate.createIntent).toMatchObject({
			contentType: "text/plain;charset=utf-8",
			textKind: "plain_text",
		});
	});

	test("cp keeps the source's type at any destination name", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/data/config.json", content: '{"a": 1}\n' }],
		});

		// The destination name never decides the type: a JSON file copied to a .yaml name is
		// still JSON, and the agent reads the staged copy back right away.
		const subtypeCopy = await runner.run(
			`cp ${test_db_files_mount}/data/config.json ${test_db_files_mount}/data/config.yaml && cat ${test_db_files_mount}/data/config.yaml`,
		);
		expect(subtypeCopy.metadata.exitCode).toBe(0);
		expect(subtypeCopy.stderr).toBe("");
		expect(subtypeCopy.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n/,
		);
		expect(subtypeCopy.stdout.split("Review in Files.\n")[1]).toBe('{"a": 1}\n');
		const yamlDraft = await get_private_entry(runner, "/data/config.yaml");
		expect(yamlDraft.pendingUpdate.createIntent).toMatchObject({
			contentType: "application/json",
			textKind: "plain_text",
		});

		// Markdown copied to a .json name stays Markdown, text unchanged.
		const markdownToJson = await runner.run(
			`cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/data/copy.json && cat ${test_db_files_mount}/data/copy.json`,
		);
		expect(markdownToJson.stderr).toBe("");
		expect(markdownToJson.metadata.exitCode).toBe(0);
		expect(markdownToJson.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n/,
		);
		expect(markdownToJson.stdout.split("Review in Files.\n")[1]).toBe(readme_copy_content);
		const jsonDraft = await get_private_entry(runner, "/data/copy.json");
		expect(jsonDraft.pendingUpdate.copiedFrom).toMatchObject({ path: "/docs/readme.md" });
		expect(jsonDraft.pendingUpdate.createIntent).toMatchObject({
			kind: "text",
			contentType: "text/markdown;charset=utf-8",
			textKind: "rich_text",
		});
	});

	test.each([
		{ source: "notes.json", destination: "notes.yaml", extension: "yaml", contentType: "application/json" },
		{ source: "notes.txt", destination: "notes.html", extension: "html", contentType: "text/plain;charset=utf-8" },
	])(
		"mv renames $source to $destination and accepting keeps the stored type",
		async ({ source, destination, extension, contentType }) => {
			const runner = await create_bash_runner({
				extraFiles: [{ path: `/data/${source}`, content: '{"note": true}\n' }],
			});
			const nodeId = await get_seeded_node_id(runner, `/data/${source}`);

			const moved = await runner.run(
				`mv ${test_db_files_mount}/data/${source} ${test_db_files_mount}/data/${destination}`,
			);
			expect(moved.metadata.exitCode).toBe(0);
			expect(moved.stdout).toMatch(
				/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
			);

			const asUser = runner.t.withIdentity({
				issuer: "https://clerk.test",
				subject: "clerk-bash-subtype-rename-accept",
				external_id: runner.seeded.userId,
				email: "bash-subtype-rename-accept@test.local",
			});
			const accepted = await asUser.mutation(
				api.files_pending_updates.apply_file_pending_move,
				await pending_review_for_test(runner, nodeId),
			);
			expect(accepted._nay).toBeUndefined();

			// The accept patches the name and the extension index. The stored type stays: a rename
			// never changes what the file is.
			const renamed = await runner.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
			expect(renamed?.name).toBe(destination);
			expect(renamed?.path).toBe(`/data/${destination}`);
			expect(renamed?.lowercaseExtension).toBe(extension);
			expect(renamed?.contentType).toBe(contentType);
			expect(renamed?.textKind).toBe("plain_text");
		},
	);

	test("renames keep the stored type for any extension, and mv -f across types proposes a structural replace", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/data/notes.json", content: '{"note": true}\n' },
				{ path: "/data/other.json", content: '{"other": true}\n' },
				{ path: "/docs/target.md", content: "target body\n" },
			],
		});
		const sourceId = await get_seeded_node_id(runner, "/data/notes.json");
		const targetId = await get_seeded_node_id(runner, "/docs/target.md");

		// The name never decides the type, so a rename across extensions is a plain move.
		const plainToMd = await runner.run(
			`mv ${test_db_files_mount}/data/other.json ${test_db_files_mount}/data/other.md`,
		);
		expect(plainToMd.stderr).toBe("");
		expect(plainToMd.metadata.exitCode).toBe(0);
		expect(plainToMd.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		const mdToJson = await runner.run(
			`mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/readme.json`,
		);
		expect(mdToJson.stderr).toBe("");
		expect(mdToJson.metadata.exitCode).toBe(0);

		// mv -f between files of different types is the same structural replace as any other
		// mv -f: the source moves onto the path with its own type, and the target is archived.
		const crossReplace = await runner.run(
			`mv -f ${test_db_files_mount}/data/notes.json ${test_db_files_mount}/docs/target.md`,
		);
		expect(crossReplace.stderr).toBe("");
		expect(crossReplace.metadata.exitCode).toBe(0);
		expect(crossReplace.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		const sourceRows = await list_pending_updates_for_node(runner, sourceId);
		expect(sourceRows).toHaveLength(1);
		expect(sourceRows[0].pendingMove).toMatchObject({
			destName: "target.md",
			replacesTarget: { kind: "saved", id: targetId },
		});
		expect(await list_pending_updates_for_node(runner, targetId)).toHaveLength(0);

		// A stored upload may change its extension too. The type stays with the bytes.
		const extensionChange = await runner.run(`mv ${test_db_files_mount}/source.pdf ${test_db_files_mount}/video.mp4`);
		expect(extensionChange.stderr).toBe("");
		expect(extensionChange.metadata.exitCode).toBe(0);
		expect(extensionChange.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		expect((await runner.run(`stat ${test_db_files_mount}/video.mp4`)).metadata.exitCode).toBe(0);
	});

	test("an oversized redirect refuses the content and leaves the new file empty", async () => {
		const runner = await create_bash_runner();

		// The shell's own output budget stops this well before the app's 900,000-byte file limit,
		// because since just-bash 3.4 the bytes a redirection writes are charged to that budget too.
		// So this is the refusal an agent actually meets when it writes too much to an app file.
		const result = await runner.run(`printf '%0300000d' 1 > ${test_db_files_mount}/big.md`);
		expect(result.metadata.exitCode).not.toBe(0);
		expect(result.stderr).toContain("limit exceeded");

		// `>` truncates its target when the shell opens it, before the command that fills it runs.
		// For a path with no file yet that open is itself a write, so it proposes the new file as an
		// empty placeholder, the same one any new-file write creates. The refused content never
		// lands, so the proposal stays empty and the user discards it like any other proposal.
		const pendingNodes = await runner.t.run(async (ctx) => ctx.db.query("files_pending_nodes").collect());
		expect(pendingNodes.map((node) => node.name)).toEqual(["big.md"]);
		expect((await runner.run(`wc -c ${test_db_files_mount}/big.md`)).stdout).toBe(`0 ${test_db_files_mount}/big.md\n`);
		expect((await list_pending_updates(runner)).map((update) => update.size)).toEqual([0]);

		// The refusal still commits nothing to the shared tree.
		const orphan = await runner.t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", runner.seeded.organizationId)
						.eq("workspaceId", runner.seeded.workspaceId)
						.eq("path", "/big.md")
						.eq("archiveOperationId", null),
				)
				.first(),
		);
		expect(orphan).toBeNull();
	});

	test("creates a pending copy proposal for app-to-app cp", async () => {
		const runner = await create_bash_runner();

		const result = await runner.run(
			`cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/readme-copy.md`,
		);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// The copied file stays private until the user saves it.
		const sourceId = await get_seeded_node_id(runner, "/docs/readme.md");
		const draft = await get_private_entry(runner, "/docs/readme-copy.md");
		expect(draft.node.kind).toBe("file");
		expect(draft.pendingUpdate.copiedFrom).toMatchObject({
			target: { kind: "saved", id: sourceId },
			path: "/docs/readme.md",
		});
		expect(draft.pendingUpdate.createIntent).toMatchObject({
			kind: "text",
			contentType: "text/markdown;charset=utf-8",
			textKind: "rich_text",
		});

		// Readers see the owner's private content.
		const overlayRead = await runner.run(`cat ${test_db_files_mount}/docs/readme-copy.md`);
		expect(overlayRead.metadata.exitCode).toBe(0);
		expect(overlayRead.stdout).toContain("# Readme");
		expect(overlayRead.stdout).toContain("unique-token");

		// A new child inside an existing folder uses the special-name casing.
		const folderDest = await runner.run(`cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/reports`);
		expect(folderDest.metadata.exitCode).toBe(0);
		expect(folderDest.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		expect((await get_private_entry(runner, "/reports/README.md")).node.name).toBe("README.md");
	});

	test("blocks writes in a read-only subtree but lets cp read its source", async () => {
		const runner = await create_bash_runner();

		const docsId = await get_seeded_node_id(runner, "/docs");
		const sourceId = await get_seeded_node_id(runner, "/docs/readme.md");

		await runner.t.run(async (ctx) => {
			const nodes = await ctx.db.query("files_nodes").collect();
			for (const node of nodes) {
				if (
					node.organizationId === runner.seeded.organizationId &&
					node.workspaceId === runner.seeded.workspaceId &&
					(node.path === "/docs" || node.path.startsWith("/docs/"))
				) {
					await ctx.db.patch("files_nodes", node._id, {
						writePolicyScopeNodeId: docsId,
						writePolicy: node._id === docsId ? { mode: "read_only" } : null,
					});
				}
			}
		});

		const refusedCommands = [
			`printf changed > ${test_db_files_mount}/docs/readme.md`,
			`mkdir ${test_db_files_mount}/docs/new-folder`,
			`mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/reports/moved.md`,
			`mv ${test_db_files_mount}/reports/summary.md ${test_db_files_mount}/docs/moved-in.md`,
			`rm ${test_db_files_mount}/docs/tutorial.md`,
			`cp ${test_db_files_mount}/reports/summary.md ${test_db_files_mount}/docs/readme.md`,
			`cp ${test_db_files_mount}/reports/summary.md ${test_db_files_mount}/docs/copied.md`,
		];
		for (const command of refusedCommands) {
			const result = await runner.run(command);
			expect(result.metadata.exitCode, command).not.toBe(0);
			expect(result.stderr, command).toContain("read-only");
		}

		const copiedOut = await runner.run(
			`cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/reports/copied-out.md`,
		);
		expect(copiedOut.metadata.exitCode).toBe(0);
		expect(copiedOut.stderr).toBe("");
		expect((await get_private_entry(runner, "/reports/copied-out.md")).node.parent).toEqual({
			kind: "saved",
			id: await get_seeded_node_id(runner, "/reports"),
		});
		expect(await get_seeded_node(runner, "/docs/readme.md")).toMatchObject({
			writePolicyScopeNodeId: docsId,
			writePolicy: null,
		});

		const activePaths = await runner.t.run(async (ctx) =>
			(await ctx.db.query("files_nodes").collect())
				.filter(
					(node) =>
						node.organizationId === runner.seeded.organizationId &&
						node.workspaceId === runner.seeded.workspaceId &&
						node.archiveOperationId === null,
				)
				.map((node) => node.path),
		);
		expect(activePaths).toContain("/docs/readme.md");
		expect(activePaths).toContain("/docs/tutorial.md");
		expect(activePaths).not.toContain("/reports/copied-out.md");
		expect(activePaths).toContain("/reports/summary.md");
		expect(activePaths).not.toContain("/docs/new-folder");
		expect(activePaths).not.toContain("/docs/copied.md");
		expect(activePaths).not.toContain("/docs/moved-in.md");
		expect(activePaths).not.toContain("/reports/moved.md");

		const readBack = await runner.run(`cat ${test_db_files_mount}/docs/readme.md`);
		expect(readBack.stdout).toContain("# Readme");
		expect(readBack.stdout).not.toContain("changed");

		const pendingRows = await list_pending_updates(runner);
		expect(pendingRows).toHaveLength(1);
		expect(pendingRows[0].copiedFrom).toMatchObject({
			target: { kind: "saved", id: sourceId },
			path: "/docs/readme.md",
		});
		const savedCopyId = await save_private_copy_for_test(runner, "/reports/copied-out.md");
		expect(await runner.t.run((ctx) => ctx.db.get("files_nodes", savedCopyId))).toMatchObject({
			writePolicyScopeNodeId: null,
			writePolicy: null,
		});
	});

	test("cp into a new deep path keeps the file and its parents private", async () => {
		const runner = await create_bash_runner();

		const result = await runner.run(`cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/new/deep/copy.md`);
		expect(result.stderr).toBe("");
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		const draft = await get_private_entry(runner, "/new/deep/copy.md");
		const newFolder = await get_private_entry(runner, "/new");
		const deepFolder = await get_private_entry(runner, "/new/deep");
		expect(newFolder.node.parent).toEqual({ kind: "root" });
		expect(deepFolder.node.parent).toEqual({ kind: "private", id: newFolder.node._id });
		expect(draft.node.parent).toEqual({ kind: "private", id: deepFolder.node._id });
		expect((await list_pending_updates(runner)).map((row) => row.target)).toEqual(
			expect.arrayContaining([
				{ kind: "private", id: newFolder.node._id },
				{ kind: "private", id: deepFolder.node._id },
				{ kind: "private", id: draft.node._id },
			]),
		);
		expect(
			await runner.t.run(async (ctx) =>
				(await ctx.db.query("files_nodes").collect()).filter((node) => node.path.startsWith("/new")),
			),
		).toEqual([]);
	});

	test.each(["file", "folder"])("archive acceptance releases a copied replacement under a deleted %s", async (kind) => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/copied/existing.md", content: "keep this saved version\n" }],
		});
		const targetBefore = await get_seeded_node(runner, "/copied/existing.md");
		const archivedId = kind === "file" ? targetBefore._id : await get_seeded_node_id(runner, "/copied");
		const result = await runner.run(
			`cp docs/readme.md copied/existing.md; rm ${kind === "folder" ? "-r copied" : "copied/existing.md"}`,
		);
		expect(result.metadata.exitCode, result.stderr).toBe(0);
		const [copy] = await list_pending_updates_for_node(runner, targetBefore._id);
		if (!copy?.pendingReplacement) throw new Error("Expected the copied replacement");
		const assetId = copy.pendingReplacement.assetId;
		const asset = await runner.t.run((ctx) => ctx.db.get("files_r2_assets", assetId));
		if (!asset?.r2Key) throw new Error("Expected the sealed copy asset");
		expect(asset.unfinalizedExpiresAt).toBeUndefined();
		expect(asset.putMayArriveUntil).toBeGreaterThan(Date.now());
		const reservation = await runner.t.run((ctx) =>
			ctx.db
				.query("files_private_storage_reservations")
				.withIndex("by_resource", (q) => q.eq("resource.kind", "asset").eq("resource.id", assetId))
				.unique(),
		);
		if (!reservation) throw new Error("Expected the copy storage hold");
		expect(reservation.settlement.kind).toBe("held");
		const [archive] = await list_pending_updates_for_node(runner, archivedId);
		expect(archive.pendingArchive).toBeDefined();
		const asUser = runner.t.withIdentity({ issuer: "https://clerk.test", external_id: runner.seeded.userId });
		const accepted = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: runner.seeded.membershipId,
			target: { kind: "saved", id: archivedId },
			pendingUpdateId: archive._id,
			reviewedRevision: archive.revision,
		});
		expect(accepted._nay).toBeUndefined();
		await runner.t.run(async (ctx) => {
			const target = await ctx.db.get("files_nodes", targetBefore._id);
			expect(target?.archiveOperationId).not.toBeNull();
			expect(target?.assetId).toBe(targetBefore.assetId);
			expect(await ctx.db.get("files_pending_updates", copy._id)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", assetId)).toBeNull();
		});
		const job = await runner.t.run((ctx) =>
			ctx.db
				.query("files_r2_object_deletion_jobs")
				.withIndex("by_r2_key", (q) => q.eq("r2Key", asset.r2Key!))
				.unique(),
		);
		if (!job) throw new Error("Expected the copy cleanup job");
		expect(job.privateStorageReservationId).toBe(reservation._id);
		expect(job.reason).toBe("discarded_replacement");
		expect(job.putMayArriveUntil).toBe(asset.putMayArriveUntil);
		expect(
			(await runner.t.run((ctx) => ctx.db.get("files_private_storage_reservations", reservation._id)))?.settlement.kind,
		).toBe("held");
		await runner.t.action(internal.r2_client.process_object_deletion_job, {
			jobId: job._id,
			generation: job.generation,
		});
		expect(test_r2_objects.has(asset.r2Key)).toBe(false);
		expect(await runner.t.run((ctx) => ctx.db.get("files_r2_object_deletion_jobs", job._id))).not.toBeNull();
		const now = vi.spyOn(Date, "now").mockReturnValue(job.putMayArriveUntil! + 1);
		try {
			await runner.t.action(internal.r2_client.process_object_deletion_job, {
				jobId: job._id,
				generation: job.generation,
			});
		} finally {
			now.mockRestore();
		}
		await runner.t.run(async (ctx) => {
			expect(await ctx.db.get("files_r2_object_deletion_jobs", job._id)).toBeNull();
			expect((await ctx.db.get("files_private_storage_reservations", reservation._id))?.settlement.kind).toBe(
				"deleted",
			);
			expect(await ctx.db.get("files_r2_assets", targetBefore.assetId!)).not.toBeNull();
		});
	});

	test("cp onto an existing file proposes replacing it as a whole", async () => {
		const runner = await create_bash_runner({
			// The copy replaces the whole file; the destination's own document is never read.
			extraFiles: [{ path: "/docs/replace-target.md", content: "replace me\n", withRealYjsSnapshot: true }],
		});
		const sourceId = await get_seeded_node_id(runner, "/docs/readme.md");
		const targetId = await get_seeded_node_id(runner, "/docs/replace-target.md");

		const result = await runner.run(
			`cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/replace-target.md`,
		);
		expect(result.stderr).toBe("");
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// The replacement belongs to the saved file and carries no private creation intent.
		const rows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", targetId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].copiedFrom).toMatchObject({ target: { kind: "saved", id: sourceId }, path: "/docs/readme.md" });
		expect(rows[0].createIntent).toBeUndefined();

		// The agent's own read overlays the proposed content on the destination.
		const overlayRead = await runner.run(`cat ${test_db_files_mount}/docs/replace-target.md`);
		expect(overlayRead.metadata.exitCode).toBe(0);
		expect(overlayRead.stdout).toContain("unique-token");
	});

	test("cp onto a file with collaboration off keeps that mode when accepted", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/docs/off-target.md", content: "replace me\n", nonCollaborative: true }],
		});
		const sourceId = await get_seeded_node_id(runner, "/docs/readme.md");
		const targetBefore = await get_seeded_node(runner, "/docs/off-target.md");

		const result = await runner.run(
			`cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/off-target.md`,
		);
		expect(result.stderr).toBe("");
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// The copy waits for review like on a collaborative file. The file itself is unchanged.
		const rows = await list_pending_updates_for_node(runner, targetBefore._id);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.pendingReplacement).toBeDefined();
		expect(rows[0]!.copiedFrom).toMatchObject({ target: { kind: "saved", id: sourceId }, path: "/docs/readme.md" });
		expect(await read_committed_text(runner, targetBefore._id)).toBe("replace me\n");

		// The agent's own read overlays the proposed content on the destination.
		const overlayRead = await runner.run(`cat ${test_db_files_mount}/docs/off-target.md`);
		expect(overlayRead.stdout).toContain("unique-token");

		// Accept keeps the destination's collaboration setting.
		await accept_pending_replacement_for_test(runner, targetBefore._id);
		expect(await list_pending_updates_for_node(runner, targetBefore._id)).toHaveLength(0);
		const targetAfter = await get_seeded_node(runner, "/docs/off-target.md");
		expect(targetAfter._id).toBe(targetBefore._id);
		expect(targetAfter.collaborationEnabled).toBe(false);
		expect(targetAfter.yjsSnapshotId).toBeNull();
		expect(targetAfter.yjsLastSequenceId).toBeNull();
		const savedRead = await runner.run(`cat ${test_db_files_mount}/docs/off-target.md`);
		expect(savedRead.stdout).toContain("unique-token");
		expect(savedRead.stdout).not.toContain("replace me");
	});

	test("cp of a Markdown file onto a plain text file with collaboration off takes the source's type on accept", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/data/settings.yaml", content: "a: 1\n", contentType: "application/yaml", nonCollaborative: true },
			],
		});
		const targetBefore = await get_seeded_node(runner, "/data/settings.yaml");

		const copied = await runner.run(
			`cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/data/settings.yaml`,
		);
		expect(copied.stderr).toBe("");
		expect(copied.metadata.exitCode).toBe(0);
		expect(copied.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// Until the review, the file keeps its type and its text.
		const targetPending = await get_seeded_node(runner, "/data/settings.yaml");
		expect(targetPending.contentType).toBe("application/yaml");
		expect(targetPending.assetId).toBe(targetBefore.assetId);

		// Accept keeps the file's identity and mode, and stores the source's text, type, and shape.
		// The name stays .yaml: it never decides the type.
		await accept_pending_replacement_for_test(runner, targetBefore._id);
		const targetAfter = await get_seeded_node(runner, "/data/settings.yaml");
		expect(targetAfter._id).toBe(targetBefore._id);
		expect(targetAfter.collaborationEnabled).toBe(false);
		expect(targetAfter.textKind).toBe("rich_text");
		expect(targetAfter.contentType).toBe("text/markdown;charset=utf-8");
		expect(targetAfter.assetId).not.toBe(targetBefore.assetId);
		// The old content stays in history next to the new one.
		const versionAssetIds = await version_snapshot_asset_ids(runner, targetAfter._id);
		expect(versionAssetIds).toContain(targetBefore.assetId);
		expect(versionAssetIds).toContain(targetAfter.assetId);
		expect(await list_pending_updates_for_node(runner, targetAfter._id)).toHaveLength(0);
		const saved = await runner.run(`cat ${test_db_files_mount}/data/settings.yaml`);
		expect(saved.stdout).toContain("unique-token");
		expect(saved.stdout).not.toContain("a: 1");
	});

	test.each([false, true])(
		"cp carries HTML into a text destination with collaboration off: %s",
		async (nonCollaborative) => {
			const text = "<!doctype html>\n<p>Copied brief</p>\n";
			const runner = await create_bash_runner({
				extraFiles: [
					{ path: "/data/brief.html", content: text, contentType: "text/html;charset=utf-8" },
					{ path: "/data/target.txt", content: "Old text\n", nonCollaborative, withRealYjsSnapshot: !nonCollaborative },
				],
			});
			const targetBefore = await get_seeded_node(runner, "/data/target.txt");
			const copied = await runner.run(
				`cp ${test_db_files_mount}/data/brief.html ${test_db_files_mount}/data/target.txt`,
			);
			expect(copied.metadata.exitCode).toBe(0);
			expect(copied.stderr).toBe("");
			expect((await get_seeded_node(runner, "/data/target.txt")).contentType).toBe("text/plain;charset=utf-8");

			await accept_pending_replacement_for_test(runner, targetBefore._id);
			const targetAfter = await get_seeded_node(runner, "/data/target.txt");
			expect(targetAfter).toMatchObject({
				_id: targetBefore._id,
				contentType: "text/html;charset=utf-8",
				textKind: "plain_text",
				collaborationEnabled: !nonCollaborative,
			});
			expect(await version_snapshot_asset_ids(runner, targetBefore._id)).toContain(targetBefore.assetId);
			expect(await list_pending_updates_for_node(runner, targetBefore._id)).toHaveLength(0);
			expect((await runner.run(`cat ${test_db_files_mount}/data/target.txt`)).stdout).toBe(text);
		},
	);

	test("cp onto an existing collaborative file proposes the source's whole file in both directions", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/data/canonical.json", content: plain_copy_canonical, contentType: "application/json" },
				{
					path: "/data/plain-target.txt",
					content: "old plain\n",
					contentType: "text/plain;charset=utf-8",
					withRealYjsSnapshot: true,
				},
				{ path: "/docs/rich-target.md", content: "old rich\n", withRealYjsSnapshot: true },
			],
		});
		const canonicalId = await get_seeded_node_id(runner, "/data/canonical.json");
		const readmeId = await get_seeded_node_id(runner, "/docs/readme.md");
		const richTarget = await get_seeded_node(runner, "/docs/rich-target.md");
		const plainTarget = await get_seeded_node(runner, "/data/plain-target.txt");

		// JSON onto Markdown: the proposal is the JSON file as a whole, text unchanged.
		const plainToRich = await runner.run(
			`cp ${test_db_files_mount}/data/canonical.json ${test_db_files_mount}/docs/rich-target.md`,
		);
		expect(plainToRich.stderr).toBe("");
		expect(plainToRich.metadata.exitCode).toBe(0);
		expect(plainToRich.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		const richRows = await list_pending_updates_for_node(runner, richTarget._id);
		expect(richRows).toHaveLength(1);
		expect(richRows[0].copiedFrom).toMatchObject({
			target: { kind: "saved", id: canonicalId },
			path: "/data/canonical.json",
		});
		expect(richRows[0].createIntent).toBeUndefined();
		expect(richRows[0].pendingReplacement).toMatchObject({
			contentType: "application/json",
			yjsRootKind: "plain_text",
			baseAssetId: richTarget.assetId,
		});
		const richProposed = await runner.run(`cat ${test_db_files_mount}/docs/rich-target.md`);
		expect(richProposed.stdout).toBe(plain_copy_canonical);

		// Markdown onto plain text: the same, the other way round.
		const richToPlain = await runner.run(
			`cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/data/plain-target.txt`,
		);
		expect(richToPlain.stderr).toBe("");
		expect(richToPlain.metadata.exitCode).toBe(0);
		expect(richToPlain.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		const plainRows = await list_pending_updates_for_node(runner, plainTarget._id);
		expect(plainRows).toHaveLength(1);
		expect(plainRows[0].copiedFrom).toMatchObject({ target: { kind: "saved", id: readmeId }, path: "/docs/readme.md" });
		expect(plainRows[0].pendingReplacement).toMatchObject({
			contentType: "text/markdown;charset=utf-8",
			yjsRootKind: "rich_text",
		});
		const plainProposed = await runner.run(`cat ${test_db_files_mount}/data/plain-target.txt`);
		expect(plainProposed.stdout).toBe(readme_copy_content);

		// Accepting replaces the file as a whole on the same node: content, type, and shape.
		// Discarding keeps the old file untouched.
		await accept_pending_replacement_for_test(runner, richTarget._id);
		expect(await list_pending_updates_for_node(runner, richTarget._id)).toHaveLength(0);
		const richCommitted = await runner.run(`cat ${test_db_files_mount}/docs/rich-target.md`);
		expect(richCommitted.stdout).toBe(plain_copy_canonical);
		const discarded = await runner_as_user(runner).mutation(
			api.files_pending_updates.discard_file_pending_structural,
			await pending_review_for_test(runner, plainTarget._id),
		);
		expect(discarded._nay).toBeUndefined();
		expect(await list_pending_updates_for_node(runner, plainTarget._id)).toHaveLength(0);
		const plainKept = await runner.run(`cat ${test_db_files_mount}/data/plain-target.txt`);
		expect(plainKept.stdout).toBe("old plain\n");

		const richAfter = await get_seeded_node(runner, "/docs/rich-target.md");
		expect(richAfter._id).toBe(richTarget._id);
		expect(richAfter.textKind).toBe("plain_text");
		expect(richAfter.contentType).toBe("application/json");
		const plainAfter = await get_seeded_node(runner, "/data/plain-target.txt");
		expect(plainAfter._id).toBe(plainTarget._id);
		expect(plainAfter.textKind).toBe("plain_text");
		expect(plainAfter.contentType).toBe("text/plain;charset=utf-8");
	});

	test("accepting a copy onto a saved collaborative file adds one version for the copy only", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/data/canonical.json", content: plain_copy_canonical, contentType: "application/json" },
				{ path: "/docs/rich-target.md", content: "old rich\n", withRealYjsSnapshot: true },
			],
		});
		const richTarget = await get_seeded_node(runner, "/docs/rich-target.md");

		// A saved collaborative file: its current asset already is its newest version row, the
		// state a finished materialization leaves behind.
		await runner.t.run((ctx) =>
			ctx.db.insert("files_snapshots", {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				fileNodeId: richTarget._id,
				assetId: richTarget.assetId!,
				createdBy: runner.seeded.userId,
				archivedAt: -1,
				contentType: richTarget.contentType!,
				yjsRootKind: "rich_text",
				collaborationEnabled: true,
			}),
		);
		const versionsBefore = await version_snapshot_asset_ids(runner, richTarget._id);

		const copied = await runner.run(
			`cp ${test_db_files_mount}/data/canonical.json ${test_db_files_mount}/docs/rich-target.md`,
		);
		expect(copied.stderr).toBe("");
		await accept_pending_replacement_for_test(runner, richTarget._id);

		// No edit past the snapshot, so the old text needs no backup row.
		const versionsAfter = await version_snapshot_asset_ids(runner, richTarget._id);
		expect(versionsAfter).toHaveLength(versionsBefore.length + 1);
		expect(await read_version_text(runner, versionsAfter[versionsAfter.length - 1]!)).toBe(plain_copy_canonical);
	});

	test("accepting a copy keeps the destination's unsaved edits as a version", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/data/canonical.json", content: plain_copy_canonical, contentType: "application/json" },
				{ path: "/docs/rich-target.md", content: "old rich\n", withRealYjsSnapshot: true },
			],
		});
		const richTarget = await get_seeded_node(runner, "/docs/rich-target.md");

		// An edit the materializer has not saved to the content asset yet.
		await push_unsaved_rich_text_edit(runner, richTarget, "# Unsaved edit");

		const versionsBefore = await version_snapshot_asset_ids(runner, richTarget._id);

		const copied = await runner.run(
			`cp ${test_db_files_mount}/data/canonical.json ${test_db_files_mount}/docs/rich-target.md`,
		);
		expect(copied.stderr).toBe("");
		await accept_pending_replacement_for_test(runner, richTarget._id);

		// One version for the edited text, then one for the copy.
		const versionsAfter = await version_snapshot_asset_ids(runner, richTarget._id);
		expect(versionsAfter).toHaveLength(versionsBefore.length + 2);
		expect(await read_version_text(runner, versionsAfter[versionsAfter.length - 2]!)).toContain("Unsaved edit");
		expect(await read_committed_text(runner, richTarget._id)).toBe(plain_copy_canonical);
	});

	test("an edit during copy acceptance refuses the old copy and survives a fresh copy", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/data/canonical.json", content: plain_copy_canonical, contentType: "application/json" },
				{ path: "/docs/rich-target.md", content: "old rich\n", withRealYjsSnapshot: true },
			],
		});
		const richTarget = await get_seeded_node(runner, "/docs/rich-target.md");
		const copied = await runner.run(
			`cp ${test_db_files_mount}/data/canonical.json ${test_db_files_mount}/docs/rich-target.md`,
		);
		expect(copied.stderr).toBe("");
		const copyRow = (await list_pending_updates_for_node(runner, richTarget._id)).find(
			(row) => row.userId === runner.seeded.userId,
		);
		if (!copyRow) {
			throw new Error("No pending copy");
		}

		// The accept action reads the document state first and writes last. Its first R2 read
		// sits between the two, so an edit pushed there is one the action never saw.
		const fetchMock = vi.mocked(globalThis.fetch);
		const baseFetch = fetchMock.getMockImplementation();
		if (baseFetch == null) {
			throw new Error("expected the fetch stub to have an implementation");
		}
		let raced = false;
		fetchMock.mockImplementation(async (input, init) => {
			const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (!raced && href.includes("/object/")) {
				raced = true;
				await push_unsaved_rich_text_edit(runner, richTarget, "# Edit during accept");
			}
			return await baseFetch(input, init);
		});
		const refused = await runner_as_user(runner).action(api.files_pending_updates.accept_file_pending_replacement, {
			membershipId: runner.seeded.membershipId,
			target: { kind: "saved", id: richTarget._id },
			pendingUpdateId: copyRow._id,
			reviewedRevision: copyRow.revision,
		});
		fetchMock.mockImplementation(baseFetch);
		expect(raced).toBe(true);
		expect(refused._nay?.message).toBe(files_PENDING_REPLACEMENT_BASE_CHANGED_MESSAGE);
		const rowsAfterRefusal = await list_pending_updates_for_node(runner, richTarget._id);
		expect(rowsAfterRefusal.find((row) => row._id === copyRow._id)?.pendingReplacement).toBeDefined();

		// A fresh copy captures the new target version. Acceptance keeps the edit in history.
		const discarded = await runner_as_user(runner).mutation(
			api.files_pending_updates.discard_file_pending_structural,
			await pending_review_for_test(runner, richTarget._id),
		);
		expect(discarded._nay).toBeUndefined();
		const recopied = await runner.run(
			`cp ${test_db_files_mount}/data/canonical.json ${test_db_files_mount}/docs/rich-target.md`,
		);
		expect(recopied.metadata.exitCode, recopied.stderr).toBe(0);
		await accept_pending_replacement_for_test(runner, richTarget._id);
		const versions = await version_snapshot_asset_ids(runner, richTarget._id);
		expect(await read_version_text(runner, versions[versions.length - 2]!)).toContain("Edit during accept");
		expect(await read_committed_text(runner, richTarget._id)).toBe(plain_copy_canonical);
	});

	test("a text write onto a file with a pending copy is refused until the copy is reviewed", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/data/canonical.json", content: plain_copy_canonical, contentType: "application/json" },
				{ path: "/docs/rich-target.md", content: "old rich\n", withRealYjsSnapshot: true },
			],
		});
		const richTarget = await get_seeded_node(runner, "/docs/rich-target.md");

		const copied = await runner.run(
			`cp ${test_db_files_mount}/data/canonical.json ${test_db_files_mount}/docs/rich-target.md`,
		);
		expect(copied.stderr).toBe("");

		// The copy carries the source's type and shape. A text edit on top of it would turn it into
		// a plain edit in the file's old shape, so the write waits for the review.
		const written = await runner.run(`echo edited > ${test_db_files_mount}/docs/rich-target.md`);
		expect(written.metadata.exitCode).not.toBe(0);
		expect(written.stderr).toContain(
			"This file has a pending copy. Accept or discard the copy in Files before writing to the file.",
		);
		const rows = await list_pending_updates_for_node(runner, richTarget._id);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.pendingReplacement).toBeDefined();
		const read = await runner.run(`cat ${test_db_files_mount}/docs/rich-target.md`);
		expect(read.stdout).toBe(plain_copy_canonical);
	});

	test("cp onto a new path gives the copy the source's type in both directions", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/data/canonical.json", content: plain_copy_canonical, contentType: "application/json" }],
		});

		// Markdown copied to a .txt name is still Markdown.
		const richToPlain = await runner.run(
			`cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/data/readme-copy.txt`,
		);
		expect(richToPlain.stderr).toBe("");
		expect(richToPlain.metadata.exitCode).toBe(0);
		expect(richToPlain.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		const markdownCopy = await get_private_entry(runner, "/data/readme-copy.txt");
		expect(markdownCopy.pendingUpdate.createIntent).toMatchObject({
			kind: "text",
			textKind: "rich_text",
			contentType: "text/markdown;charset=utf-8",
		});
		const markdownProposed = await runner.run(`cat ${test_db_files_mount}/data/readme-copy.txt`);
		expect(markdownProposed.stdout).toBe(readme_copy_content);

		// JSON copied to a .md name is still JSON.
		const plainToRich = await runner.run(
			`cp ${test_db_files_mount}/data/canonical.json ${test_db_files_mount}/docs/canonical-copy.md`,
		);
		expect(plainToRich.stderr).toBe("");
		expect(plainToRich.metadata.exitCode).toBe(0);
		expect(plainToRich.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		const jsonCopy = await get_private_entry(runner, "/docs/canonical-copy.md");
		expect(jsonCopy.pendingUpdate.createIntent).toMatchObject({
			kind: "text",
			textKind: "plain_text",
			contentType: "application/json",
		});
		const jsonProposed = await runner.run(`cat ${test_db_files_mount}/docs/canonical-copy.md`);
		expect(jsonProposed.stdout).toBe(plain_copy_canonical);

		// Save publishes the JSON copy. Discard closes the private Markdown copy.
		const jsonSavedId = await save_private_copy_for_test(runner, "/docs/canonical-copy.md");
		expect(await list_pending_updates_for_node(runner, jsonSavedId)).toHaveLength(0);
		const jsonCommitted = await runner.run(`cat ${test_db_files_mount}/docs/canonical-copy.md`);
		expect(jsonCommitted.stdout).toBe(plain_copy_canonical);
		expect((await get_seeded_node(runner, "/docs/canonical-copy.md")).textKind).toBe("plain_text");
		const discarded = await runner_as_user(runner).mutation(api.files_pending_updates.discard_file_pending_update, {
			membershipId: runner.seeded.membershipId,
			target: { kind: "private", id: markdownCopy.node._id },
			pendingUpdateId: markdownCopy.pendingUpdate._id,
			reviewedRevision: markdownCopy.pendingUpdate.revision,
		});
		expect(discarded._nay).toBeUndefined();
		expect(await runner.t.run((ctx) => ctx.db.get("files_pending_nodes", markdownCopy.node._id))).toMatchObject({
			state: "discarded",
		});
		expect((await runner.run(`cat ${test_db_files_mount}/data/readme-copy.txt`)).metadata.exitCode).not.toBe(0);
	});

	test("cp of a plain text file onto a Markdown file keeps the text exactly, before review and after accept", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/data/notes.txt", content: plain_copy_lossy, contentType: "text/plain;charset=utf-8" },
				{ path: "/docs/rich-target.md", content: "old rich\n", withRealYjsSnapshot: true },
			],
		});
		const targetId = await get_seeded_node_id(runner, "/docs/rich-target.md");

		const copied = await runner.run(
			`cp ${test_db_files_mount}/data/notes.txt ${test_db_files_mount}/docs/rich-target.md`,
		);
		expect(copied.stderr).toBe("");
		expect(copied.metadata.exitCode).toBe(0);

		// Nothing is converted: the copy is the plain text file as a whole, so the HTML comment
		// that Markdown would drop stays, in the proposal and in the accepted file.
		const proposed = await runner.run(`cat ${test_db_files_mount}/docs/rich-target.md`);
		expect(proposed.stdout).toBe(plain_copy_lossy);

		await accept_pending_replacement_for_test(runner, targetId);
		const committed = await runner.run(`cat ${test_db_files_mount}/docs/rich-target.md`);
		expect(committed.stdout).toBe(plain_copy_lossy);
		const target = await get_seeded_node(runner, "/docs/rich-target.md");
		expect(target.contentType).toBe("text/plain;charset=utf-8");
		expect(target.textKind).toBe("plain_text");
	});

	test("cp keeps CRLF plain text when replacing a Markdown file with collaboration off", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{
					path: "/data/notes.txt",
					content: plain_copy_lossy.replaceAll("\n", "\r\n"),
					contentType: "text/plain;charset=utf-8",
				},
				{ path: "/docs/off-notes.md", content: "old saved\n", nonCollaborative: true },
			],
		});
		const targetBefore = await get_seeded_node(runner, "/docs/off-notes.md");

		const copied = await runner.run(
			`cp ${test_db_files_mount}/data/notes.txt ${test_db_files_mount}/docs/off-notes.md`,
		);
		expect(copied.stderr).toBe("");
		expect(copied.metadata.exitCode).toBe(0);
		expect(copied.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		expect(await list_pending_updates_for_node(runner, targetBefore._id)).toHaveLength(1);

		// The old content stays in history. The source's line endings and comment survive.
		await accept_pending_replacement_for_test(runner, targetBefore._id);
		expect(await list_pending_updates_for_node(runner, targetBefore._id)).toHaveLength(0);
		const targetAfter = await get_seeded_node(runner, "/docs/off-notes.md");
		expect(targetAfter._id).toBe(targetBefore._id);
		const versionAssetIds = await version_snapshot_asset_ids(runner, targetAfter._id);
		expect(versionAssetIds).toContain(targetBefore.assetId);
		expect(versionAssetIds).toContain(targetAfter.assetId);
		expect(targetAfter.contentType).toBe("text/plain;charset=utf-8");
		expect(targetAfter.textKind).toBe("plain_text");
		const saved = await runner.run(`cat ${test_db_files_mount}/docs/off-notes.md`);
		expect(saved.stdout).toBe(plain_copy_lossy.replaceAll("\n", "\r\n"));
	});

	test("cp onto a file with collaboration off still refuses a locked destination, and a member save keeps the copy pending", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/data/settings.yaml", content: "a: 1\n", contentType: "application/yaml", nonCollaborative: true },
				{ path: "/data/locked.yaml", content: "b: 2\n", contentType: "application/yaml", nonCollaborative: true },
			],
		});
		const lockedId = await get_seeded_node_id(runner, "/data/locked.yaml");
		const savedOverId = await get_seeded_node_id(runner, "/data/settings.yaml");

		// Lock: the copy is refused before anything is staged.
		await runner.t.run((ctx) =>
			ctx.db.patch("files_nodes", lockedId, { writePolicyScopeNodeId: lockedId, writePolicy: { mode: "read_only" } }),
		);
		const locked = await runner.run(`cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/data/locked.yaml`);
		expect(locked.metadata.exitCode).not.toBe(0);
		expect(locked.stderr).toContain("read-only");
		const lockedRead = await runner.run(`cat ${test_db_files_mount}/data/locked.yaml`);
		expect(lockedRead.stdout).toBe("b: 2\n");
		expect(await count_version_snapshots(runner, lockedId)).toBe(0);
		expect(await list_pending_updates_for_node(runner, lockedId)).toHaveLength(0);

		// A member saves the file while the copy waits for review. Accept refuses, because the
		// copy was proposed against the older text, and the copy stays pending for the user.
		const copied = await runner.run(
			`cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/data/settings.yaml`,
		);
		expect(copied.stderr).toBe("");
		const copyRow = (await list_pending_updates_for_node(runner, savedOverId)).find(
			(row) => row.userId === runner.seeded.userId,
		);
		if (!copyRow) {
			throw new Error("No pending copy");
		}
		const memberSave = await runner_as_user(runner).action(api.files_nodes_content.replace_file_content, {
			membershipId: runner.seeded.membershipId,
			nodeId: savedOverId,
			text: "someone else: 1\n",
		});
		expect(memberSave._nay).toBeUndefined();
		const refused = await runner_as_user(runner).action(api.files_pending_updates.accept_file_pending_replacement, {
			membershipId: runner.seeded.membershipId,
			target: { kind: "saved", id: savedOverId },
			pendingUpdateId: copyRow._id,
			reviewedRevision: copyRow.revision,
		});
		expect(refused._nay?.message).toBe(files_PENDING_REPLACEMENT_BASE_CHANGED_MESSAGE);
		const rowsAfterRefusal = await list_pending_updates_for_node(runner, savedOverId);
		expect(rowsAfterRefusal).toHaveLength(1);
		expect(rowsAfterRefusal[0]!.pendingReplacement).toBeDefined();
		expect(await read_committed_text(runner, savedOverId)).toBe("someone else: 1\n");
	});

	test("a file that received a copy of another content type can turn collaboration off and on again and keep taking edits", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/data/canonical.json", content: plain_copy_canonical, contentType: "application/json" },
				{ path: "/docs/rich-target.md", content: "old rich\n", withRealYjsSnapshot: true },
			],
		});
		const targetBefore = await get_seeded_node(runner, "/docs/rich-target.md");
		const copied = await runner.run(
			`cp ${test_db_files_mount}/data/canonical.json ${test_db_files_mount}/docs/rich-target.md`,
		);
		expect(copied.stderr).toBe("");
		expect(copied.metadata.exitCode).toBe(0);
		await accept_pending_replacement_for_test(runner, targetBefore._id);

		const asUser = runner_as_user(runner);
		const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: runner.seeded.membershipId,
			nodeId: targetBefore._id,
			acknowledgeDropCollaborativeHistory: true,
		});
		expect(off._nay).toBeUndefined();
		await drain_scheduled_continuations(runner);
		const offNode = await get_seeded_node(runner, "/docs/rich-target.md");
		expect(offNode.collaborationEnabled).toBe(false);
		expect(offNode.yjsSnapshotId).toBeNull();
		expect(offNode.yjsLastSequenceId).toBeNull();
		const offRead = await runner.run(`cat ${test_db_files_mount}/docs/rich-target.md`);
		expect(offRead.stdout).toBe(plain_copy_canonical);

		// Back on: a fresh document, not the old one restored, with the same text.
		const on = await asUser.action(api.files_nodes_content.set_file_collaborative, {
			membershipId: runner.seeded.membershipId,
			nodeId: targetBefore._id,
		});
		expect(on._nay).toBeUndefined();
		const onNode = await get_seeded_node(runner, "/docs/rich-target.md");
		expect(onNode.collaborationEnabled).toBe(true);
		// The copy made the file JSON, so the rebuilt document is plain text.
		expect(onNode.textKind).toBe("plain_text");
		expect(onNode.yjsSnapshotId).toBeDefined();
		expect(onNode.yjsSnapshotId).not.toBe(targetBefore.yjsSnapshotId);
		expect(onNode.yjsLastSequenceId).toBeDefined();
		expect(onNode.yjsLastSequenceId).not.toBe(targetBefore.yjsLastSequenceId);
		const onRead = await runner.run(`cat ${test_db_files_mount}/docs/rich-target.md`);
		expect(onRead.stdout).toBe(plain_copy_canonical);

		// The rebuilt document takes a normal edit, accept, and materialization.
		const appended = await runner.run(`printf '\\ntail line\\n' >> ${test_db_files_mount}/docs/rich-target.md`);
		expect(appended.metadata.exitCode).toBe(0);
		await accept_pending_update_for_test(runner, { nodeId: targetBefore._id, path: "/docs/rich-target.md" });
		const committed = await read_committed_text(runner, targetBefore._id);
		expect(committed).toContain('"deep": true');
		expect(committed).toContain("tail line");
	});

	test("cp no-clobber leaves an existing app destination unchanged", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/docs/no-clobber-target.md", content: "keep me\n", withRealYjsSnapshot: true }],
		});
		const targetId = await get_seeded_node_id(runner, "/docs/no-clobber-target.md");

		for (const flag of ["-n", "--no-clobber"]) {
			const result = await runner.run(
				`cp ${flag} ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/no-clobber-target.md`,
			);
			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toMatch(
				/^Transfer \S+: 0 ready for review, 1 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
			);
			expect(result.stderr).toBe("");
		}

		const rows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", targetId))
				.collect(),
		);
		expect(rows).toHaveLength(0);
		const readBack = await runner.run(`cat ${test_db_files_mount}/docs/no-clobber-target.md`);
		expect(readBack.stdout).toBe("keep me\n");
	});

	test("cp no-clobber leaves a destination created during the command unchanged", async () => {
		const runner = await create_bash_runner();
		const baseImpl = runner.runMutation.getMockImplementation();
		if (baseImpl == null) {
			throw new Error("expected the runner runMutation spy to have an implementation");
		}
		let raced = false;
		runner.runMutation.mockImplementation(async (ref, actionArgs) => {
			if (!raced && function_name_of(ref) === "files_transfer:start_for_agent") {
				raced = true;
				await runner.t.run((ctx) =>
					seed_organization_node(
						ctx,
						{
							organizationId: runner.seeded.organizationId,
							workspaceId: runner.seeded.workspaceId,
							userId: runner.seeded.userId,
						},
						{ path: "/docs/raced-target.md", content: "raced content\n", withRealYjsSnapshot: true },
						999,
					),
				);
			}
			return await baseImpl(ref, actionArgs);
		});

		const result = await runner.run(
			`cp -n ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/raced-target.md`,
		);
		const targetId = await get_seeded_node_id(runner, "/docs/raced-target.md");
		const pendingUpdates = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", targetId))
				.collect(),
		);
		const readBack = await runner.run(`cat ${test_db_files_mount}/docs/raced-target.md`);

		expect(raced).toBe(true);
		expect(result).toMatchObject({ stderr: "", metadata: { exitCode: 0 } });
		expect(result.stdout).toMatch(
			/^Transfer \S+: 0 ready for review, 1 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		expect(pendingUpdates).toHaveLength(0);
		expect(readBack.stdout).toBe("raced content\n");
	});

	test("cp creates a private file at a path vacated by the user's pending move", async () => {
		const runner = await create_bash_runner();

		const move = await runner.run(`mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/guide.md`);
		expect(move.metadata.exitCode).toBe(0);
		const tutorialId = await get_seeded_node_id(runner, "/docs/tutorial.md");

		// The vacated path must not become a silent content replacement on the moving node.
		const vacatedCopy = await runner.run(
			`cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/tutorial.md`,
		);
		expect(vacatedCopy.metadata.exitCode, vacatedCopy.stderr).toBe(0);
		const copyDraft = await get_private_entry(runner, "/docs/tutorial.md");
		expect(copyDraft.pendingUpdate.target).toEqual({ kind: "private", id: copyDraft.node._id });

		// The moving node keeps its single move-only pending update doc without attached content.
		const rows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", tutorialId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].pendingMove).toMatchObject({ destName: "guide.md" });
		expect(rows[0].content).toBeUndefined();

		// The copy and moved source keep separate content and identities.
		const vacatedRead = await runner.run(`cat ${test_db_files_mount}/docs/tutorial.md`);
		expect(vacatedRead.metadata.exitCode).toBe(0);
		expect(vacatedRead.stdout).toContain("# Readme");
		const movedRead = await runner.run(`cat ${test_db_files_mount}/docs/guide.md`);
		expect(movedRead.metadata.exitCode).toBe(0);
		expect(movedRead.stdout).toContain("zeta");

		// A genuinely free path still takes a plain pending copy.
		const freeCopy = await runner.run(`cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/fresh.md`);
		expect(freeCopy.metadata.exitCode).toBe(0);
		expect(freeCopy.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
	});

	test("keeps a private cwd after another chat renames and saves its folder", async () => {
		const runner = await create_bash_runner();
		const entered = await runner.run("mkdir draft-cwd && cd draft-cwd");
		expect(entered.metadata.exitCode).toBe(0);
		const draft = await get_private_entry(runner, "/draft-cwd");
		const target = { kind: "private" as const, id: draft.node._id };
		const moved = await runner.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId: runner.seeded.userId,
			target,
			destParent: { kind: "root" },
			destName: "renamed-cwd",
		});
		expect(moved._nay).toBeUndefined();
		const read = await runner.run("pwd");
		expect(read.stdout).toBe(`${test_db_files_mount}/renamed-cwd\n`);
		const proposal = await runner.t.run((ctx) => ctx.db.get("files_pending_updates", draft.pendingUpdate._id));
		const saved = await runner.t
			.withIdentity({ issuer: "https://clerk.test", external_id: runner.seeded.userId })
			.action(api.files_pending_updates.save_file_pending_update, {
				membershipId: runner.seeded.membershipId,
				target,
				pendingUpdateId: draft.pendingUpdate._id,
				reviewedRevision: proposal!.revision,
			});
		if (saved._nay) throw new Error(saved._nay.message);
		expect((await runner.run("pwd")).stdout).toBe(`${test_db_files_mount}/renamed-cwd\n`);
		expect((await get_shell(runner.t, runner.threadId))?.cwdTarget).toEqual(saved._yay.target);
	});

	test("leaves a discarded cwd instead of adopting a new folder at the same path", async () => {
		const runner = await create_bash_runner();
		expect((await runner.run("mkdir draft-cwd && cd draft-cwd")).metadata.exitCode).toBe(0);
		const draft = await get_private_entry(runner, "/draft-cwd");
		const discarded = await runner.t
			.withIdentity({ issuer: "https://clerk.test", external_id: runner.seeded.userId })
			.mutation(api.files_pending_updates.discard_file_pending_update, {
				membershipId: runner.seeded.membershipId,
				target: { kind: "private", id: draft.node._id },
				pendingUpdateId: draft.pendingUpdate._id,
				reviewedRevision: draft.pendingUpdate.revision,
			});
		expect(discarded._nay).toBeUndefined();
		const replacement = await runner.t.mutation(internal.files_nodes.create_private_node_by_path, {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId: runner.seeded.userId,
			path: "/draft-cwd",
			kind: "folder",
		});
		expect(replacement._nay).toBeUndefined();
		expect((await runner.run("pwd")).stdout).toBe(`${test_db_files_mount}\n`);
	});

	test("mv of the current working folder follows the pending move for cwd", async () => {
		const runner = await create_bash_runner();

		const cdResult = await runner.run(`cd ${test_db_files_mount}/docs`);
		expect(cdResult.metadata.nextCwd).toBe(`${test_db_files_mount}/docs`);

		// Moving the cwd's own folder keeps the shell inside it at its new visible path
		// instead of resetting to the workspace root.
		const moved = await runner.run("mv ../docs ../archive");
		expect(moved.metadata.exitCode).toBe(0);
		expect(moved.metadata.nextCwd).toBe(`${test_db_files_mount}/archive`);

		// The next call runs from the moved folder and reads through the overlay.
		const read = await runner.run("cat readme.md");
		expect(read.metadata.exitCode).toBe(0);
		expect(read.stdout).toContain("# Readme");
	});

	test.each(["", "; cat ../docs/replacement.txt", "; (cd ..; cd docs; cat replacement.txt)"])(
		"keeps the moved cwd when the old path is reused%s",
		async (afterReuse) => {
			const runner = await create_bash_runner();
			const folderId = await get_seeded_node_id(runner, "/docs");
			expect((await runner.run("cd docs")).metadata.exitCode).toBe(0);
			const moved = await runner.run(
				`mv ../docs ../archive; mkdir ../docs; printf replacement > ../docs/replacement.txt${afterReuse}`,
			);
			expect(moved.metadata.exitCode, moved.stderr).toBe(0);
			expect(moved.metadata.nextCwd).toBe(`${test_db_files_mount}/archive`);
			expect((await get_shell(runner.t, runner.threadId))?.cwdTarget).toEqual({ kind: "saved", id: folderId });
			expect((await runner.run("cat readme.md")).stdout).toContain("# Readme");
			expect((await runner.run("cat ../docs/replacement.txt")).stdout).toBe("replacement");
		},
	);

	test.each(["cd ..; cd docs", "cd .", "builtin cd .", "go=cd; $go ."])(
		"cd can enter a new folder at the moved cwd's old path: %s",
		async (command) => {
			const runner = await create_bash_runner();
			expect((await runner.run("cd docs")).metadata.exitCode).toBe(0);
			const entered = await runner.run(`mv ../docs ../archive; mkdir ../docs; ${command}`);
			expect(entered.metadata.exitCode, entered.stderr).toBe(0);
			expect(entered.metadata.nextCwd).toBe(`${test_db_files_mount}/docs`);
			const replacement = await get_private_entry(runner, "/docs");
			expect((await get_shell(runner.t, runner.threadId))?.cwdTarget).toEqual({
				kind: "private",
				id: replacement.node._id,
			});
		},
	);

	test.each(["PWD=/tmp", "unset PWD", "exit 0"])("persists the actual cwd after %s", async (command) => {
		const runner = await create_bash_runner();
		const entered = await runner.run(`cd docs; ${command}`);
		expect(entered.metadata.exitCode, entered.stderr).toBe(0);
		expect(entered.metadata.nextCwd).toBe(`${test_db_files_mount}/docs`);
		expect((await runner.run("cat readme.md")).stdout).toContain("# Readme");
	});

	test("keeps the outer cwd when a subshell moves it before any app command observes it", async () => {
		const runner = await create_bash_runner();
		const moved = await runner.run("cd docs; (cd ..; mv docs archive; mkdir docs)");
		expect(moved.metadata.exitCode, moved.stderr).toBe(0);
		expect(moved.metadata.nextCwd).toBe(`${test_db_files_mount}/archive`);
		expect((await runner.run("cat readme.md")).stdout).toContain("# Readme");
	});

	test("leaves an archived cwd when a new folder reuses its path in the same call", async () => {
		const runner = await create_bash_runner();
		const archived = await runner.run("cd docs; rm -r ../docs; mkdir ../docs");
		expect(archived.metadata.exitCode, archived.stderr).toBe(0);
		expect(archived.metadata.nextCwd).toBe(test_db_files_mount);
	});

	test("a stale thread cwd follows a pending move proposed outside the thread", async () => {
		const runner = await create_bash_runner();

		const cdResult = await runner.run(`cd ${test_db_files_mount}/reports`);
		expect(cdResult.metadata.nextCwd).toBe(`${test_db_files_mount}/reports`);

		// The same user proposes the folder move from another thread at the workspace
		// root, so this thread's persisted cwd is never touched by the end-of-command
		// projection of that call.
		const otherThread = await create_bash_runner({ shared: { t: runner.t, seeded: runner.seeded } });
		const moved = await otherThread.run(`mv ${test_db_files_mount}/reports ${test_db_files_mount}/archive`);
		expect(moved.metadata.exitCode).toBe(0);
		expect(moved.metadata.nextCwd).toBe(test_db_files_mount);

		// The next call in the original thread starts inside the moved folder's visible
		// path instead of resetting to the workspace root.
		const read = await runner.run("pwd && cat summary.md");
		expect(read.metadata.exitCode).toBe(0);
		expect(read.metadata.cwd).toBe(`${test_db_files_mount}/archive`);
		expect(read.stdout).toContain(`${test_db_files_mount}/archive`);
		expect(read.stdout).toContain("summary");
	});

	test("mv into an existing folder keeps the visible name of a moved source", async () => {
		const runner = await create_bash_runner();

		await runner.run(`mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/guide.md`);

		// Moving by the visible path into a folder keeps its visible name.
		const folderMove = await runner.run(`mv ${test_db_files_mount}/docs/guide.md ${test_db_files_mount}/reports`);
		expect(folderMove.metadata.exitCode).toBe(0);
		expect(folderMove.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		const list = await runner.run(`ls ${test_db_files_mount}/reports`);
		expect(list.metadata.exitCode).toBe(0);
		expect(list.stdout.trim().split("\n")).toContain("guide.md");
		expect(list.stdout).not.toContain("tutorial.md");
	});

	test("mv into a moved destination folder uses its visible path", async () => {
		const runner = await create_bash_runner();

		const folderMove = await runner.run(`mv ${test_db_files_mount}/reports ${test_db_files_mount}/archive`);
		expect(folderMove.metadata.exitCode).toBe(0);

		// The parent keeps its saved identity while the shell uses its visible path.
		const move = await runner.run(`mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/archive`);
		expect(move.stderr).toBe("");
		expect(move.metadata.exitCode).toBe(0);
		expect(move.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		const list = await runner.run(`ls ${test_db_files_mount}/archive`);
		expect(list.metadata.exitCode).toBe(0);
		expect(list.stdout.trim().split("\n")).toContain("tutorial.md");
	});

	test("mv into a moved destination folder surfaces the visible-name conflict", async () => {
		const runner = await create_bash_runner({
			// The -f content replacement fetches the committed child's yjs snapshot from R2.
			extraFiles: [
				{ path: "/old/report.md", content: "old report\n", withRealYjsSnapshot: true },
				{ path: "/other/report.md", content: "new report\n", withRealYjsSnapshot: true },
				{ path: "/other/claim.md", content: "claim body\n" },
				{ path: "/third/claim.md", content: "third body\n" },
			],
		});

		const folderMove = await runner.run(`mv ${test_db_files_mount}/old ${test_db_files_mount}/new`);
		expect(folderMove.metadata.exitCode).toBe(0);

		// The committed child at the visible destination is a real conflict, not a claim.
		const conflict = await runner.run(`mv ${test_db_files_mount}/other/report.md ${test_db_files_mount}/new`);
		expect(conflict.metadata.exitCode).not.toBe(0);
		expect(conflict.stderr).toBe("mv: The destination already exists\n");

		// A visible path claimed by a file's own pending move is still rejected: one visible path, one proposal.
		const claim = await runner.run(`mv ${test_db_files_mount}/other/claim.md ${test_db_files_mount}/new/claim.md`);
		expect(claim.metadata.exitCode).toBe(0);
		const claimedDest = await runner.run(`mv ${test_db_files_mount}/third/claim.md ${test_db_files_mount}/new`);
		expect(claimedDest.metadata.exitCode).not.toBe(0);
		expect(claimedDest.stderr).toBe("mv: The destination already exists\n");

		// -f proposes the structural replace on the committed child, under the folder's
		// committed identity, so the replacement travels with the folder when its move is accepted.
		const forced = await runner.run(`mv -f ${test_db_files_mount}/other/report.md ${test_db_files_mount}/new`);
		expect(forced.stderr).toBe("");
		expect(forced.metadata.exitCode).toBe(0);
		expect(forced.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		const oldId = await get_seeded_node_id(runner, "/old");
		const targetId = await get_seeded_node_id(runner, "/old/report.md");
		const sourceId = await get_seeded_node_id(runner, "/other/report.md");
		const sourceRows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", sourceId))
				.collect(),
		);
		expect(sourceRows).toHaveLength(1);
		expect(sourceRows[0].pendingMove).toMatchObject({
			destParent: { kind: "saved", id: oldId },
			destName: "report.md",
			replacesTarget: { kind: "saved", id: targetId },
		});
		expect(sourceRows[0].copiedFrom).toBeUndefined();
		const targetRows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", targetId))
				.collect(),
		);
		expect(targetRows).toHaveLength(0);
	});

	test("mv -f onto a committed child of a moved destination folder proposes the replace", async () => {
		const runner = await create_bash_runner({
			// The -f content replacement fetches the committed child's yjs snapshot from R2.
			extraFiles: [
				{ path: "/docs/incoming.md", content: "incoming body\n", withRealYjsSnapshot: true },
				{ path: "/reports/existing.md", content: "existing target\n", withRealYjsSnapshot: true },
				{ path: "/reports/plain.md", content: "plain target\n" },
			],
		});
		const reportsId = await get_seeded_node_id(runner, "/reports");

		const folderMove = await runner.run(`mv ${test_db_files_mount}/reports ${test_db_files_mount}/archive`);
		expect(folderMove.metadata.exitCode).toBe(0);

		// Without -f the committed child at the exact visible path is a normal conflict,
		// not a claimed-by-pending-move rejection.
		const conflict = await runner.run(
			`mv ${test_db_files_mount}/docs/incoming.md ${test_db_files_mount}/archive/existing.md`,
		);
		expect(conflict.metadata.exitCode).not.toBe(0);
		expect(conflict.stderr).toBe("mv: The destination already exists\n");

		// -f proposes the structural replace on the committed child.
		const forced = await runner.run(
			`mv -f ${test_db_files_mount}/docs/incoming.md ${test_db_files_mount}/archive/existing.md`,
		);
		expect(forced.stderr).toBe("");
		expect(forced.metadata.exitCode).toBe(0);
		expect(forced.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		const targetId = await get_seeded_node_id(runner, "/reports/existing.md");
		const sourceId = await get_seeded_node_id(runner, "/docs/incoming.md");
		const sourceRows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", sourceId))
				.collect(),
		);
		expect(sourceRows).toHaveLength(1);
		expect(sourceRows[0].pendingMove).toMatchObject({
			destParent: { kind: "saved", id: reportsId },
			destName: "existing.md",
			replacesTarget: { kind: "saved", id: targetId },
		});
		expect(await list_pending_updates_for_node(runner, targetId)).toHaveLength(0);

		// A stored upload keeps the same structural replacement on the committed identity,
		// so the replacement travels with the folder when the move is accepted.
		const uploadedId = await get_seeded_node_id(runner, "/uploaded.md");
		const plainId = await get_seeded_node_id(runner, "/reports/plain.md");
		const structural = await runner.run(
			`mv -f ${test_db_files_mount}/uploaded.md ${test_db_files_mount}/archive/plain.md`,
		);
		expect(structural.stderr).toBe("");
		expect(structural.metadata.exitCode).toBe(0);
		expect(structural.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		const structuralRows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", uploadedId))
				.collect(),
		);
		expect(structuralRows).toHaveLength(1);
		expect(structuralRows[0].pendingMove).toMatchObject({
			destParent: { kind: "saved", id: reportsId },
			destName: "plain.md",
			replacesTarget: { kind: "saved", id: plainId },
		});

		// An exact dest path presented by its own pending move is still rejected.
		const claim = await runner.run(`mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/claim.md`);
		expect(claim.metadata.exitCode).toBe(0);
		const claimedDest = await runner.run(
			`mv -f ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/claim.md`,
		);
		expect(claimedDest.metadata.exitCode).not.toBe(0);
		expect(claimedDest.stderr).toBe("mv: Path already exists\n");
	});

	test("cp into an existing folder keeps the visible name of a moved source", async () => {
		const runner = await create_bash_runner();

		await runner.run(`mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/guide.md`);

		// Copying by the visible path into a folder keeps the visible basename, like real cp.
		const folderCopy = await runner.run(`cp ${test_db_files_mount}/docs/guide.md ${test_db_files_mount}/reports`);
		expect(folderCopy.metadata.exitCode).toBe(0);
		expect(folderCopy.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		const read = await runner.run(`cat ${test_db_files_mount}/reports/guide.md`);
		expect(read.metadata.exitCode).toBe(0);
		expect(read.stdout).toContain("zeta");
	});

	test("cp into a moved destination folder creates the file under the committed folder", async () => {
		const runner = await create_bash_runner();
		const reportsId = await get_seeded_node_id(runner, "/reports");

		const folderMove = await runner.run(`mv ${test_db_files_mount}/reports ${test_db_files_mount}/archive`);
		expect(folderMove.metadata.exitCode).toBe(0);

		// cp uses the moved folder's visible path.
		const copy = await runner.run(`cp ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/archive`);
		expect(copy.stderr).toBe("");
		expect(copy.metadata.exitCode).toBe(0);
		expect(copy.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// The new file lists under the visible folder path and reads back.
		const list = await runner.run(`ls ${test_db_files_mount}/archive`);
		expect(list.metadata.exitCode).toBe(0);
		expect(list.stdout.trim().split("\n")).toContain("tutorial.md");
		const read = await runner.run(`cat ${test_db_files_mount}/archive/tutorial.md`);
		expect(read.metadata.exitCode).toBe(0);
		expect(read.stdout).toContain("zeta");

		// The private child keeps the saved folder's identity as its parent.
		const created = await get_private_entry(runner, "/archive/tutorial.md");
		expect(created.node.parent).toEqual({ kind: "saved", id: reportsId });
	});

	test("cp with an explicit dest path under a moved folder creates under the committed folder", async () => {
		const runner = await create_bash_runner();
		const reportsId = await get_seeded_node_id(runner, "/reports");

		const folderMove = await runner.run(`mv ${test_db_files_mount}/reports ${test_db_files_mount}/archive`);
		expect(folderMove.metadata.exitCode).toBe(0);

		// cp can name a new private child under the moved folder's visible path.
		const copy = await runner.run(`cp ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/archive/copy.md`);
		expect(copy.stderr).toBe("");
		expect(copy.metadata.exitCode).toBe(0);
		expect(copy.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// The child stays private while its parent has a pending move.
		const created = await get_private_entry(runner, "/archive/copy.md");
		expect(created.node.parent).toEqual({ kind: "saved", id: reportsId });
		const committedArchive = await runner.t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", runner.seeded.organizationId)
						.eq("workspaceId", runner.seeded.workspaceId)
						.eq("path", "/archive")
						.eq("archiveOperationId", null),
				)
				.first(),
		);
		expect(committedArchive).toBeNull();

		const list = await runner.run(`ls ${test_db_files_mount}/archive`);
		expect(list.metadata.exitCode).toBe(0);
		expect(list.stdout.trim().split("\n")).toContain("copy.md");

		// Saving the parent move keeps the same private child at the visible path.
		const asUser = runner.t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-bash-cp-accept",
			external_id: runner.seeded.userId,
			email: "bash-cp-accept@test.local",
		});
		const accepted = await asUser.mutation(
			api.files_pending_updates.apply_file_pending_move,
			await pending_review_for_test(runner, reportsId),
		);
		expect(accepted._nay).toBeUndefined();
		const movedFolder = await get_seeded_node(runner, "/archive");
		expect(movedFolder._id).toBe(reportsId);
		const movedCopy = await get_private_entry(runner, "/archive/copy.md");
		expect(movedCopy.node._id).toBe(created.node._id);
		const savedCopyId = await save_private_copy_for_test(runner, "/archive/copy.md");
		expect((await get_seeded_node(runner, "/archive/copy.md"))._id).toBe(savedCopyId);
	});

	test("mkdir under a moved folder's visible path creates under the committed folder", async () => {
		const runner = await create_bash_runner();
		const reportsId = await get_seeded_node_id(runner, "/reports");

		const folderMove = await runner.run(`mv ${test_db_files_mount}/reports ${test_db_files_mount}/archive`);
		expect(folderMove.metadata.exitCode).toBe(0);

		// mkdir at the moved folder's VISIBLE path succeeds, plain and -p.
		const made = await runner.run(`mkdir ${test_db_files_mount}/archive/sub`);
		expect(made.stderr).toBe("");
		expect(made.metadata.exitCode).toBe(0);
		const madeRecursive = await runner.run(`mkdir -p ${test_db_files_mount}/archive/deep/sub`);
		expect(madeRecursive.stderr).toBe("");
		expect(madeRecursive.metadata.exitCode).toBe(0);

		const list = await runner.run(`ls ${test_db_files_mount}/archive`);
		expect(list.metadata.exitCode).toBe(0);
		expect(list.stdout.trim().split("\n")).toContain("sub/");
		expect(list.stdout.trim().split("\n")).toContain("deep/");

		// New folders stay private and keep their parent's identity.
		const sub = await get_private_entry(runner, "/archive/sub");
		expect(sub.node.parent).toEqual({ kind: "saved", id: reportsId });
		const deepSub = await get_private_entry(runner, "/archive/deep/sub");
		const committedArchive = await runner.t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", runner.seeded.organizationId)
						.eq("workspaceId", runner.seeded.workspaceId)
						.eq("path", "/archive")
						.eq("archiveOperationId", null),
				)
				.first(),
		);
		expect(committedArchive).toBeNull();

		// Saving the parent move keeps both private folders in place.
		const asUser = runner.t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-bash-mkdir-accept",
			external_id: runner.seeded.userId,
			email: "bash-mkdir-accept@test.local",
		});
		const accepted = await asUser.mutation(
			api.files_pending_updates.apply_file_pending_move,
			await pending_review_for_test(runner, reportsId),
		);
		expect(accepted._nay).toBeUndefined();
		const movedSub = await get_private_entry(runner, "/archive/sub");
		expect(movedSub.node._id).toBe(sub.node._id);
		const movedDeepSub = await get_private_entry(runner, "/archive/deep/sub");
		expect(movedDeepSub.node._id).toBe(deepSub.node._id);
	});

	test("mkdir can create private folders at a path vacated by the user's pending move", async () => {
		const runner = await create_bash_runner();

		const folderMove = await runner.run(`mv ${test_db_files_mount}/reports ${test_db_files_mount}/archive`);
		expect(folderMove.metadata.exitCode).toBe(0);

		// Plain mkdir still needs a visible parent. Recursive mkdir creates private parents.
		const plain = await runner.run(`mkdir ${test_db_files_mount}/reports/sub`);
		expect(plain.metadata.exitCode).not.toBe(0);
		expect(plain.stderr).toContain(
			`mkdir: cannot create directory '${test_db_files_mount}/reports/sub': No such file or directory`,
		);
		const recursive = await runner.run(`mkdir -p ${test_db_files_mount}/reports/sub`);
		expect(recursive.metadata.exitCode, recursive.stderr).toBe(0);
		const parent = await get_private_entry(runner, "/reports");
		const child = await get_private_entry(runner, "/reports/sub");
		expect(child.node.parent).toEqual({ kind: "private", id: parent.node._id });

		// No committed node was created under the vacated path.
		const committedSub = await runner.t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", runner.seeded.organizationId)
						.eq("workspaceId", runner.seeded.workspaceId)
						.eq("path", "/reports/sub")
						.eq("archiveOperationId", null),
				)
				.first(),
		);
		expect(committedSub).toBeNull();
	});

	test("mkdir -p under a pending file-move claim is rejected without creating committed folders", async () => {
		const runner = await create_bash_runner();

		// The pending file move makes /foo.md a visible file; nothing sits there committed.
		const fileMove = await runner.run(`mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/foo.md`);
		expect(fileMove.metadata.exitCode).toBe(0);

		const made = await runner.run(`mkdir -p ${test_db_files_mount}/foo.md/sub`);
		expect(made.metadata.exitCode).not.toBe(0);
		expect(made.stderr).toContain(
			`mkdir: cannot create directory '${test_db_files_mount}/foo.md/sub': Not a directory`,
		);

		// No committed folder grew under the pending file claim.
		const committedFoo = await runner.t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", runner.seeded.organizationId)
						.eq("workspaceId", runner.seeded.workspaceId)
						.eq("path", "/foo.md")
						.eq("archiveOperationId", null),
				)
				.first(),
		);
		expect(committedFoo).toBeNull();
	});

	test("cp under a pending file-move claim is rejected without creating committed folders", async () => {
		const runner = await create_bash_runner();

		const fileMove = await runner.run(`mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/foo.md`);
		expect(fileMove.metadata.exitCode).toBe(0);

		const copy = await runner.run(`cp ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/foo.md/sub/y.md`);
		expect(copy.metadata.exitCode).not.toBe(0);
		expect(copy.stderr).toBe("cp: the destination parent is not a directory\n");

		// No committed folder grew under the pending file claim.
		const committedFoo = await runner.t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", runner.seeded.organizationId)
						.eq("workspaceId", runner.seeded.workspaceId)
						.eq("path", "/foo.md")
						.eq("archiveOperationId", null),
				)
				.first(),
		);
		expect(committedFoo).toBeNull();
	});

	test("mkdir -p under a committed file fails without creating committed folders", async () => {
		const runner = await create_bash_runner();

		const made = await runner.run(`mkdir -p ${test_db_files_mount}/docs/readme.md/sub`);
		expect(made.metadata.exitCode).not.toBe(0);
		expect(made.stderr).toContain(
			`mkdir: cannot create directory '${test_db_files_mount}/docs/readme.md/sub': Not a directory`,
		);

		const committedSub = await runner.t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", runner.seeded.organizationId)
						.eq("workspaceId", runner.seeded.workspaceId)
						.eq("path", "/docs/readme.md/sub")
						.eq("archiveOperationId", null),
				)
				.first(),
		);
		expect(committedSub).toBeNull();
	});

	test("rejects unsupported app copy shapes without creating proposals", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/conflict/readme.md", kind: "folder" }],
		});

		const sameFile = await runner.run(`cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs`);
		expect(sameFile.metadata.exitCode).not.toBe(0);
		expect(sameFile.stderr).toBe("cp: A copy cannot replace or merge into its sources\n");

		const folderOccupant = await runner.run(`cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/conflict`);
		expect(folderOccupant.metadata.exitCode).not.toBe(0);
		expect(folderOccupant.stderr).toBe("cp: The source and destination types differ\n");

		const folderSource = await runner.run(`cp ${test_db_files_mount}/docs ${test_db_files_mount}/docs-copy`);
		expect(folderSource.metadata.exitCode).not.toBe(0);
		expect(folderSource.stderr).toBe("cp: copying a folder requires -R\n");

		const missingSource = await runner.run(`cp ${test_db_files_mount}/nope.md ${test_db_files_mount}/copy.md`);
		expect(missingSource.metadata.exitCode).not.toBe(0);
		expect(missingSource.stderr).toBe(`cp: source '${test_db_files_mount}/nope.md' is not available\n`);

		const rows = await runner.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		expect(rows).toHaveLength(0);
	});

	test.each(["cp", "mv"] as const)("%s handles multiple app sources in one transfer", async (command) => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/data/one.txt", content: "one\n" },
				{ path: "/data/two.txt", content: "two\n" },
			],
		});
		const result = await runner.run(
			`${command} ${test_db_files_mount}/data/one.txt ${test_db_files_mount}/data/two.txt ${test_db_files_mount}/reports`,
		);
		expect(result.metadata.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toMatch(
			/^Transfer \S+: 2 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		expect(
			(await runner.run(`cat ${test_db_files_mount}/reports/one.txt ${test_db_files_mount}/reports/two.txt`)).stdout,
		).toBe("one\ntwo\n");
		const rows = await list_pending_updates(runner);
		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.target.kind)).toEqual([
			command === "cp" ? "private" : "saved",
			command === "cp" ? "private" : "saved",
		]);
		expect((await get_seeded_node(runner, "/data/one.txt")).path).toBe("/data/one.txt");
		expect((await get_seeded_node(runner, "/data/two.txt")).path).toBe("/data/two.txt");
	});

	test("cp -R creates a private folder tree with its child content", async () => {
		const runner = await create_bash_runner();
		const result = await runner.run(`cp -R ${test_db_files_mount}/docs ${test_db_files_mount}/docs-copy`);
		expect(result.metadata.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toMatch(
			/^Transfer \S+: 5 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		const folder = await get_private_entry(runner, "/docs-copy");
		const nested = await get_private_entry(runner, "/docs-copy/nested");
		const child = await get_private_entry(runner, "/docs-copy/nested/deep.md");
		expect(nested.node.parent).toEqual({ kind: "private", id: folder.node._id });
		expect(child.node.parent).toEqual({ kind: "private", id: nested.node._id });
		expect((await runner.run(`cat ${test_db_files_mount}/docs-copy/nested/deep.md`)).stdout).toBe(
			"one:two\nthree:four\n",
		);
		expect(await list_pending_updates(runner)).toHaveLength(5);
		expect(
			await runner.t.run(async (ctx) =>
				(await ctx.db.query("files_nodes").collect()).filter((node) => node.path.startsWith("/docs-copy")),
			),
		).toEqual([]);
	});

	test("cp -R into a descendant copies only the checked source tree", async () => {
		const runner = await create_bash_runner();
		const before = await runner.t.run((ctx) => ctx.db.query("files_nodes").collect());
		const result = await runner.run(`cp -R ${test_db_files_mount}/docs ${test_db_files_mount}/docs/nested`);
		expect(result.metadata.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toMatch(
			/^Transfer \S+: 5 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		expect((await runner.run(`cat ${test_db_files_mount}/docs/nested/docs/nested/deep.md`)).stdout).toBe(
			"one:two\nthree:four\n",
		);
		const items = await runner.t.run((ctx) => ctx.db.query("files_transfer_items").collect());
		expect(items).toHaveLength(5);
		expect(items.every((item) => item.state === "completed" && item.outputTarget?.kind === "private")).toBe(true);
		expect(items.some((item) => item.sourcePath.startsWith("/docs/nested/docs"))).toBe(false);
		expect(await runner.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
	});

	test("cp of a stored file stages a byte copy that accepting turns into the same kind of file", async () => {
		const runner = await create_bash_runner();
		// The copy happens on the R2 server side. Stand in for it with the in-memory objects.
		const copySpy = vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, copyArgs) => {
			const bytes = test_r2_objects.get(copyArgs.sourceKey);
			if (!bytes) {
				return { outcome: "source_missing" as const };
			}
			test_r2_objects.set(copyArgs.destinationKey, bytes);
			return { outcome: "copied" as const, size: bytes.byteLength, etag: "copied-etag" };
		});
		const sourceId = await get_seeded_node_id(runner, "/source.pdf");

		const result = await runner.run(`cp ${test_db_files_mount}/source.pdf ${test_db_files_mount}/source-copy.pdf`);
		expect(result.stderr).toBe("");
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		expect(copySpy).toHaveBeenCalledTimes(1);

		// The private copy owns the same bytes and type as its source.
		const draft = await get_private_entry(runner, "/source-copy.pdf");
		expect(draft.pendingUpdate.copiedFrom).toMatchObject({
			target: { kind: "saved", id: sourceId },
			path: "/source.pdf",
		});
		const intent = draft.pendingUpdate.createIntent;
		if (intent?.kind !== "stored") throw new Error("Expected a stored copy");
		expect(intent).toMatchObject({ contentType: "application/pdf", size: 4096 });
		const copyAsset = await runner.t.run((ctx) => ctx.db.get("files_r2_assets", intent.assetId));
		expect(test_r2_objects.get(copyAsset!.r2Key!)).toEqual(test_r2_objects.get("bash-test/source.pdf"));

		// Accepting makes the copy a stored PDF like its source: no text and no document.
		const savedId = await save_private_copy_for_test(runner, "/source-copy.pdf");
		const accepted = await get_seeded_node(runner, "/source-copy.pdf");
		expect(accepted._id).toBe(savedId);
		expect(accepted.contentType).toBe("application/pdf");
		expect(accepted.textKind).toBeNull();
		expect(accepted.yjsSnapshotId).toBeNull();
		expect(accepted.assetId).toBe(intent.assetId);
		const unreadable = await runner.run(`cat ${test_db_files_mount}/source-copy.pdf`);
		expect(unreadable.metadata.exitCode).not.toBe(0);
		expect(unreadable.stderr).toContain("Bash can read editable text files only");
	});

	test("degrades to a replace when the destination is created concurrently", async () => {
		const runner = await create_bash_runner();
		const racedPath = "/docs/raced-copy.md";

		// Another user creates the destination between the shell check and transfer planning.
		const baseImpl = runner.runMutation.getMockImplementation();
		if (baseImpl == null) {
			throw new Error("expected the runner runMutation spy to have an implementation");
		}
		let raced = false;
		runner.runMutation.mockImplementation(async (ref, actionArgs) => {
			if (!raced && function_name_of(ref) === "files_transfer:start_for_agent") {
				raced = true;
				await runner.t.run(async (ctx) => {
					await seed_organization_node(
						ctx,
						{
							organizationId: runner.seeded.organizationId,
							workspaceId: runner.seeded.workspaceId,
							userId: runner.seeded.userId,
						},
						{ path: racedPath, content: "raced\n", withRealYjsSnapshot: true },
						99,
					);
				});
			}
			return await baseImpl(ref, actionArgs);
		});

		const result = await runner.run(`cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}${racedPath}`);

		expect(raced).toBe(true);
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// The raced saved node becomes the replacement target and survives Discard.
		const racedNode = await get_seeded_node(runner, racedPath);
		const pendingRows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", racedNode._id))
				.collect(),
		);
		expect(pendingRows).toHaveLength(1);
		expect(pendingRows[0].copiedFrom).toBeDefined();
		const discarded = await runner_as_user(runner).mutation(
			api.files_pending_updates.discard_file_pending_structural,
			await pending_review_for_test(runner, racedNode._id),
		);
		expect(discarded._nay).toBeUndefined();
		expect((await get_seeded_node(runner, racedPath))._id).toBe(racedNode._id);
		expect((await runner.run(`cat ${test_db_files_mount}${racedPath}`)).stdout).toBe("raced\n");
	});

	test.each(["throw", "http"] as const)("cp closes its private output after an upload %s failure", async (failure) => {
		const runner = await create_bash_runner();
		const fetchMock = vi.mocked(globalThis.fetch);
		const baseFetch = fetchMock.getMockImplementation()!;
		let failedUploads = 0;
		fetchMock.mockImplementation(async (input, init) => {
			if (init?.method === "PUT") {
				failedUploads += 1;
				if (failure === "throw") throw new Error("simulated upload failure");
				return new Response(null, { status: 503 });
			}
			return await baseFetch(input, init);
		});

		const copied = await runner.run(
			`cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/failed-copy.md`,
		);
		expect(copied.metadata.exitCode).not.toBe(0);
		expect(copied.stderr).toBe("cp: Could not copy file\n");
		expect(copied.stdout).toMatch(
			/^Transfer \S+: 0 ready for review, 0 skipped, 1 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		// Each of the three attempts writes content and a Yjs snapshot.
		expect(failedUploads).toBe(6);
		const items = await runner.t.run((ctx) => ctx.db.query("files_transfer_items").collect());
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ state: "failed", attempt: 3 });
		expect((await runner.run(`cat ${test_db_files_mount}/docs/failed-copy.md`)).metadata.exitCode).not.toBe(0);
		expect(
			await runner.t.run(async (ctx) =>
				(await ctx.db.query("files_pending_nodes").collect()).filter((node) => node.state === "active"),
			),
		).toEqual([]);
		expect(
			await runner.t.run(async (ctx) =>
				(await ctx.db.query("files_nodes").collect()).filter((node) => node.path === "/docs/failed-copy.md"),
			),
		).toEqual([]);
		expect((await runner.run(`cat ${test_db_files_mount}/docs/readme.md`)).stdout).toBe(readme_seed_content);
	});

	test("a failed cp leaves an existing target and another member's draft unchanged", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/docs/copy-target.md", content: "saved target\n" }],
		});
		const targetId = await get_seeded_node_id(runner, "/docs/copy-target.md");
		const member = await runner.t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "copy-failure-member" });
			await test_mocks_fill_db_with.plan(ctx, { userId, plan: "Pay As You Go" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				userId,
				active: true,
				updatedAt: Date.now(),
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				userId,
				role: "member",
				now: Date.now(),
			});
			return { userId, membershipId };
		});
		const other = await create_bash_runner({ shared: { t: runner.t, seeded: { ...runner.seeded, ...member } } });
		expect(
			(await other.run(`printf 'member draft\\n' > ${test_db_files_mount}/docs/copy-target.md`)).metadata.exitCode,
		).toBe(0);
		const otherDraft = await list_pending_updates(other);
		expect(otherDraft).toHaveLength(1);
		vi.spyOn(R2.prototype, "generateUploadUrl").mockRejectedValue(new Error("simulated upload failure"));

		const copied = await runner.run(
			`cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/copy-target.md`,
		);
		expect(copied.metadata.exitCode).not.toBe(0);
		expect(copied.stderr).toBe("cp: Could not copy file\n");
		expect((await get_seeded_node(runner, "/docs/copy-target.md"))._id).toBe(targetId);
		expect(await read_committed_text(runner, targetId)).toBe("saved target\n");
		expect(await list_pending_updates(other)).toEqual(otherDraft);
		expect((await other.run(`cat ${test_db_files_mount}/docs/copy-target.md`)).stdout).toBe("member draft\n");
		expect(await list_pending_updates(runner)).toEqual([]);
	});

	test("supports the broader Native Just Bash /tmp command surface", async () => {
		const { run } = await create_bash_runner();

		const result = await run(
			[
				"cd /tmp",
				"printf 'alpha\\nbeta\\n' > data.txt",
				"rev data.txt",
				"tac data.txt",
				"nl data.txt",
				"printf alpha | base64",
				'printf \'{"name":"alpha"}\\n\' > meta.json',
				"jq -r .name meta.json",
				"sha256sum data.txt",
				"du data.txt",
				"diff data.txt data.txt",
				"rg beta data.txt",
			].join(" && "),
		);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("ahpla");
		expect(result.stdout).toContain("beta");
		expect(result.stdout).toContain("1\talpha");
		expect(result.stdout).toContain("YWxwaGE=");
		expect(result.stdout).toContain("alpha");
		expect(result.stdout).toContain("data.txt");
		expect(result.stderr).not.toContain("db-backed");
		expect(result.stderr).not.toContain("app-aware commands");
	});

	test("delegates /tmp grep file operands to Native Just Bash", async () => {
		const { run } = await create_bash_runner();

		const result = await run(
			"printf 'example: command not found\\n' > /tmp/literal.txt && grep -n 'command not found' /tmp/literal.txt",
		);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe("1:example: command not found\n");
		expect(result.stderr).not.toContain("grep over multiple/app-wide files is not supported");
		expect(result.stderr).not.toContain("db-backed");
	});

	test("treats /dev/null and /dev/zero as Native Just Bash devices outside the app mount", async () => {
		const { run } = await create_bash_runner();

		const nullResult = await run(
			"printf hi > /dev/null && printf 'alpha\\n' > /tmp/a.txt && tee /dev/null /tmp/b.txt < /tmp/a.txt >/dev/null && cat /tmp/b.txt",
		);
		const zeroResult = await run("head -c 5 /dev/zero | wc -c");

		expect(nullResult.metadata.exitCode).toBe(0);
		expect(nullResult.stdout).toBe("alpha\n");
		expect(nullResult.stderr).not.toContain("read-only file system");
		expect(nullResult.stderr).not.toContain("db-backed");
		expect(zeroResult.metadata.exitCode).toBe(0);
		expect(zeroResult.stdout).toBe("5\n");
		expect(zeroResult.stderr).not.toContain("No such file");
		expect(zeroResult.stderr).not.toContain("db-backed");
	});

	test("does not append app-mount guidance for /tmp Native Just Bash command failures", async () => {
		const { run } = await create_bash_runner();

		const result = await run("printf alpha > /tmp/a.txt && rg missing /tmp/a.txt");

		expect(result.metadata.exitCode).not.toBe(0);
		expect(result.stderr).not.toContain("db-backed");
		expect(result.stderr).not.toContain("Native Just Bash /tmp commands cannot access app files directly");
	});

	test("does not append app-mount guidance when a Native Just Bash command fails without touching a file", async () => {
		const { run } = await create_bash_runner();

		// Both run at the default cwd inside the app tree. Neither names a file, so the failure has
		// nothing to do with app paths and the cwd must not be offered as the culprit.
		const badDuration = await run("sleep abc");
		const badOption = await run("rev --bogus");

		expect(badDuration.metadata.exitCode).not.toBe(0);
		expect(badDuration.stderr).toContain("sleep: invalid time interval 'abc'");
		expect(badDuration.stderr).not.toContain("db-backed");
		expect(badDuration.stderr).not.toContain("Native Just Bash /tmp commands cannot access app files directly");
		expect(badOption.metadata.exitCode).not.toBe(0);
		expect(badOption.stderr).not.toContain("db-backed");
		expect(badOption.stderr).not.toContain("Native Just Bash /tmp commands cannot access app files directly");
	});

	test("names the app file a Native Just Bash command tried to read from an app cwd", async () => {
		const { run } = await create_bash_runner();

		// A bare file name looks nothing like a path, so the guidance has to come from the read the
		// restricted view refused, not from argv.
		const result = await run(`cd ${test_db_files_mount}/docs && sed 's/a/b/' readme.md`);

		expect(result.metadata.exitCode).not.toBe(0);
		expect(result.stderr).toContain("sed: readme.md: No such file or directory");
		expect(result.stderr).toContain(
			`Native Just Bash /tmp commands cannot access app files directly: '${test_db_files_mount}/docs/readme.md'.`,
		);
	});

	test("does not read a sed script as an app operand", async () => {
		const { run } = await create_bash_runner();

		const missingScratch = await run("sed 's/a/b/' /tmp/missing");
		const appAfterScratch = await run(
			`printf 'alpha\\n' > /tmp/a.txt && sed 's/a/b/' /tmp/a.txt ${test_db_files_mount}/docs/readme.md`,
		);

		// `s/a/b/` has slashes, but it is the script, not a path under the cwd.
		expect(missingScratch.metadata.exitCode).not.toBe(0);
		expect(missingScratch.stderr).toContain("sed: /tmp/missing: No such file or directory");
		expect(missingScratch.stderr).not.toContain("db-backed");
		expect(missingScratch.stderr).not.toContain("Native Just Bash /tmp commands cannot access app files directly");
		expect(missingScratch.stderr).not.toContain("/s/a/b/");
		// A /tmp operand must not hide the app operand next to it.
		expect(appAfterScratch.metadata.exitCode).not.toBe(0);
		expect(appAfterScratch.stderr).toContain(
			`Native Just Bash /tmp commands cannot access app files directly: '${test_db_files_mount}/docs/readme.md'.`,
		);
		expect(appAfterScratch.stderr).not.toContain("/s/a/b/");
	});

	test("keeps the Unix file command unavailable", async () => {
		const { run } = await create_bash_runner();

		const result = await run("printf hi > /tmp/a.txt && file /tmp/a.txt");

		expect(result.metadata.exitCode).not.toBe(0);
		expect(result.stderr).toContain("file: command not found");
		expect(result.stderr).toContain("run 'help'");
		expect(result.stderr).toContain(
			"the Unix file command is intentionally unavailable. Try: stat /tmp/a.txt && wc -c /tmp/a.txt && head -n 5 /tmp/a.txt",
		);
	});

	test("ignores shell comment lines when hinting unavailable file commands", async () => {
		const { run } = await create_bash_runner();

		const result = await run("# Try file (intentionally unavailable)\nprintf hi > /tmp/a.txt\nfile /tmp/a.txt");

		expect(result.metadata.exitCode).not.toBe(0);
		expect(result.stderr).toContain("file: command not found");
		expect(result.stderr).toContain(
			"the Unix file command is intentionally unavailable. Try: stat /tmp/a.txt && wc -c /tmp/a.txt && head -n 5 /tmp/a.txt",
		);
		expect(result.stderr).not.toContain("stat '(intentionally'");
	});

	test("prevents scratch symlinks from escaping into the app mount", async () => {
		const { run } = await create_bash_runner();

		const result = await run(`ln -s ${test_db_files_mount}/docs/readme.md /tmp/readme-link && cat /tmp/readme-link`);

		expect(result.metadata.exitCode).not.toBe(0);
		expect(result.stdout).not.toContain("unique-token");
		expect(result.stderr).toContain("db-backed");
		expect(result.stderr).toContain("Native Just Bash /tmp commands cannot access app files directly");
		// Pre-checked before the inner shell, so the sanitizer never redacts the paths.
		expect(result.stderr).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(result.stderr).not.toContain("<path>");
	});

	test("rejects expanded Native Just Bash /tmp commands when direct app operands are involved", async () => {
		const { run } = await create_bash_runner();

		const duResult = await run(`du ${test_db_files_mount}/docs`);
		const rgResult = await run(`rg unique-token ${test_db_files_mount}/docs/readme.md`);
		const diffResult = await run(
			`printf '# Readme\\n' > /tmp/readme.md && diff ${test_db_files_mount}/docs/readme.md /tmp/readme.md`,
		);
		const duWithFlagsResult = await run(`du -sh ${test_db_files_mount}/docs`);
		const defaultCwdResult = await run(`cd ${test_db_files_mount}/docs && du`);

		for (const result of [duResult, rgResult, diffResult, duWithFlagsResult, defaultCwdResult]) {
			expect(result.metadata.exitCode).not.toBe(0);
			expect(result.stderr).toContain("db-backed");
			expect(result.stderr).toContain("app-aware commands");
		}
		expect(duResult.stderr).toContain(test_db_files_mount);
		expect(duResult.stderr).not.toContain("No such file or directory");
		expect(duResult.stderr).toContain(
			`du: app-mount paths do not expose POSIX disk usage. Try: stat ${test_db_files_mount}/docs && find ${test_db_files_mount}/docs -type f --limit 20`,
		);
		expect(rgResult.stderr).toContain(
			`rg: app paths do not support direct Native Just Bash rg. Try: grep unique-token ${test_db_files_mount}/docs/readme.md`,
		);
		expect(duWithFlagsResult.stderr).not.toContain("No such file or directory");
		expect(diffResult.stderr).not.toContain("No such file or directory");
		// Without an operand, du reads `.` through the restricted view, which refuses the app cwd.
		expect(defaultCwdResult.stderr).toContain("du: cannot access '.': No such file or directory");
		expect(defaultCwdResult.stderr).toContain(
			`Native Just Bash /tmp commands cannot access app files directly: '${test_db_files_mount}/docs'.`,
		);
	});

	test("allows app reads to stream into expanded Native Just Bash text utilities", async () => {
		const { run } = await create_bash_runner();

		const result = await run(
			[
				`cat ${test_db_files_mount}/docs/readme.md | rev | head -n 1`,
				`cat ${test_db_files_mount}/docs/readme.md | sha256sum`,
			].join(" && "),
		);

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("emdaeR #");
		expect(result.stdout).toContain("-");
		expect(result.stderr).not.toContain("db-backed");
	});

	test("keeps nested shells, xargs, and which inside the curated command surface", async () => {
		const { run } = await create_bash_runner();

		const nested = await run(`bash -c 'ls --limit 1 ${test_db_files_mount}/docs'`);
		const nestedLoginForm = await run(`bash -lc 'ls --limit 1 ${test_db_files_mount}/docs'`);
		const nestedMixed = await run(
			`bash -c 'printf nested-ok > /tmp/nested-ok.txt && cat /tmp/nested-ok.txt'; bash -c 'printf blocked > /home/cloud-usr/nested-blocked.md'`,
		);
		const nestedAppWrite = await run(
			`bash -c 'printf nested-app > ${test_db_files_mount}/nested-app.md && cat ${test_db_files_mount}/nested-app.md'`,
		);
		const xargsResult = await run(`printf '${test_db_files_mount}/docs/readme.md\\n' | xargs cat`);
		const xargsParallel = await run("printf hi | xargs -P 2 echo");
		const xargsHelp = await run("xargs --help");
		const xargsCombined = await run("printf 'a b' | xargs -rt echo");
		const xargsNullCombined = await run("printf 'a\\0b\\0' | xargs -0t echo");
		const whichResult = await run("which ls find cat du rg sha256sum search meta textgrep && which --silent bash");
		const whichAll = await run("which --all search");
		const whichCombined = await run("which -as search");
		const whichHelp = await run("which --help");
		const whichMissing = await run("which");
		const whichEndOptions = await run("which -- --not-a-command");

		expect(nested.metadata.exitCode).toBe(0);
		expect(nested.stdout).toContain("nested/");
		expect(nestedLoginForm.metadata.exitCode).toBe(0);
		expect(nestedLoginForm.stdout).toContain("nested/");
		expect(nestedMixed.metadata.exitCode).not.toBe(0);
		expect(nestedMixed.stdout).toContain("nested-ok");
		expect(nestedMixed.stderr).toContain("read-only file system");
		// Nested shells share the outer fs, so app redirects create pending proposals there too.
		expect(nestedAppWrite.metadata.exitCode).toBe(0);
		expect(nestedAppWrite.stdout).toBe("nested-app\n");
		expect(xargsResult.metadata.exitCode).toBe(0);
		expect(xargsResult.stdout).toContain("unique-token");
		expect(xargsParallel.metadata.exitCode).toBe(2);
		expect(xargsParallel.stderr).toContain("parallel execution");
		expect(xargsHelp.metadata.exitCode).toBe(0);
		expect(xargsHelp.stdout).toContain("[-P 0|1]");
		expect(xargsHelp.stdout).not.toContain("-a FILE");
		expect(xargsCombined.metadata.exitCode).toBe(0);
		expect(xargsCombined.stdout).toBe("a b\n");
		expect(xargsCombined.stderr).toBe("echo a b\n");
		expect(xargsNullCombined.metadata.exitCode).toBe(0);
		expect(xargsNullCombined.stdout).toBe("a b\n");
		expect(xargsNullCombined.stderr).toBe("echo a b\n");
		expect(whichResult.metadata.exitCode).toBe(0);
		expect(whichResult.stdout).toContain("/usr/bin/ls");
		expect(whichResult.stdout).toContain("/usr/bin/find");
		expect(whichResult.stdout).toContain("/usr/bin/cat");
		expect(whichResult.stdout).toContain("/usr/bin/du");
		expect(whichResult.stdout).toContain("/usr/bin/rg");
		expect(whichResult.stdout).toContain("/usr/bin/sha256sum");
		expect(whichResult.stdout).toContain("/usr/bin/search");
		expect(whichResult.stdout).toContain("/usr/bin/meta");
		expect(whichResult.stdout).toContain("/usr/bin/textgrep");
		expect(whichAll.metadata.exitCode).toBe(0);
		expect(whichAll.stdout).toBe("/usr/bin/search\n/bin/search\n");
		expect(whichCombined.metadata.exitCode).toBe(0);
		expect(whichCombined.stdout).toBe("");
		expect(whichHelp.metadata.exitCode).toBe(0);
		expect(whichHelp.stdout).toContain("Usage: which [-a] [-s] NAME...");
		expect(whichMissing.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(whichMissing.stderr).toContain("which: missing command name");
		expect(whichMissing.stderr).toContain("Usage: which [-a] [-s] NAME...");
		expect(whichEndOptions.metadata.exitCode).toBe(1);
		expect(whichEndOptions.stderr).toContain("which: no --not-a-command in (/usr/bin:/bin)");
	});

	test("keeps synthetic Native Just Bash lookup paths native-only", async () => {
		const { run } = await create_bash_runner();

		const result = await run("du -a /usr/bin");

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("/usr/bin/grep");
		expect(result.stdout).not.toContain("/usr/bin/file");
		expect(result.stdout).not.toContain("/usr/bin/search");
		expect(result.stdout).not.toContain("/usr/bin/textgrep");
	});

	test("forwards nested shell stdin and handles script files cleanly", async () => {
		const { run } = await create_bash_runner();

		const nestedStdin = await run("printf nested-stdin | bash -c 'cat'");
		const nestedShStdin = await run("printf nested-sh-stdin | sh -c 'cat'");
		const nestedInlineArgs = await run("bash -c 'echo inline:$0:$1:$#' script forwarded");
		const writeScript = await run("printf 'echo script:$1\\n' > /tmp/nested-script.sh");
		const scriptPath = await run("bash /tmp/nested-script.sh forwarded");
		const nestedTmpGlob = await run(
			"printf 'nested-a\\n' > /tmp/nested-a.txt && printf 'nested-b\\n' > /tmp/nested-b.txt && bash -c 'cat /tmp/nested-*.txt'",
		);
		const sourceTmpScript = await run(
			"printf 'echo sourced:$BONOBO\\n' > /tmp/source-script.sh && BONOBO=ok source /tmp/source-script.sh",
		);
		const cdTmpBeforeDot = await run("cd /tmp");
		const dotTmpScriptFromCwd = await run(". source-script.sh");
		const missingScript = await run("bash /tmp/missing-script.sh");
		const directoryScript = await run("sh /tmp");
		const appScript = await run(`bash ${test_db_files_mount}/docs/readme.md`);
		const appSourceScript = await run(`source ${test_db_files_mount}/docs/readme.md`);
		const appDotScript = await run(`. ${test_db_files_mount}/docs/readme.md`);
		const appEnvSourceScript = await run(`BONOBO=1 source ${test_db_files_mount}/docs/readme.md`);
		const appRedirectSourceScript = await run(`2>/tmp/source.err source ${test_db_files_mount}/docs/readme.md`);
		const appCommandSourceScript = await run(`command source ${test_db_files_mount}/docs/readme.md`);
		const appEvalSourceScript = await run(`eval 'source ${test_db_files_mount}/docs/readme.md'`);
		const appEvalEnvSourceScript = await run(`eval 'BONOBO=1 source ${test_db_files_mount}/docs/readme.md'`);
		const nestedAppSourceScript = await run(`bash -c 'source ${test_db_files_mount}/docs/readme.md'`);
		const nestedAppRedirectSourceScript = await run(
			`bash -c '2>/tmp/source.err source ${test_db_files_mount}/docs/readme.md'`,
		);
		const nestedEchoSource = await run("bash -c 'echo source'");
		const missingInlineScript = await run("bash -c");
		const unsupportedFlag = await run("sh -e");

		expect(nestedStdin.metadata.exitCode).toBe(0);
		expect(nestedStdin.stdout).toBe("nested-stdin");
		expect(nestedShStdin.metadata.exitCode).toBe(0);
		expect(nestedShStdin.stdout).toBe("nested-sh-stdin");
		expect(nestedInlineArgs.metadata.exitCode).toBe(0);
		expect(nestedInlineArgs.stdout).toBe("inline:script:forwarded:1\n");
		expect(writeScript.metadata.exitCode).toBe(0);
		expect(scriptPath.metadata.exitCode).toBe(0);
		expect(scriptPath.stdout).toBe("script:forwarded\n");
		expect(nestedTmpGlob.metadata.exitCode).toBe(0);
		expect(nestedTmpGlob.stdout).toContain("nested-a\n");
		expect(nestedTmpGlob.stdout).toContain("nested-b\n");
		expect(sourceTmpScript.metadata.exitCode).toBe(0);
		expect(sourceTmpScript.stdout).toBe("sourced:ok\n");
		expect(cdTmpBeforeDot.metadata.exitCode).toBe(0);
		expect(dotTmpScriptFromCwd.metadata.exitCode).toBe(0);
		expect(dotTmpScriptFromCwd.stdout).toBe("sourced:\n");
		expect(missingScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_NOT_FOUND);
		expect(missingScript.stderr).toBe("bash: /tmp/missing-script.sh: No such file or directory\n");
		expect(missingScript.stderr).not.toContain("ENOENT");
		expect(directoryScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
		expect(directoryScript.stderr).toBe("sh: /tmp: Is a directory\n");
		expect(directoryScript.stderr).not.toContain("EISDIR");
		expect(appScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
		expect(appScript.stderr).toContain("app-mounted script files are not executable");
		expect(appScript.stderr).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(appSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
		expect(appSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
		expect(appDotScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
		expect(appDotScript.stderr).toContain("cannot load app files or agent-only external mounts");
		expect(appEnvSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
		expect(appEnvSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
		expect(appRedirectSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
		expect(appRedirectSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
		expect(appCommandSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
		expect(appCommandSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
		expect(appEvalSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
		expect(appEvalSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
		expect(appEvalEnvSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
		expect(appEvalEnvSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
		expect(nestedAppSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
		expect(nestedAppSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
		expect(nestedAppRedirectSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
		expect(nestedAppRedirectSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
		expect(nestedEchoSource.metadata.exitCode).toBe(0);
		expect(nestedEchoSource.stdout).toBe("source\n");
		expect(missingInlineScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(missingInlineScript.stderr).toContain("option requires an argument");
		expect(unsupportedFlag.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(unsupportedFlag.stderr).toContain("sh -c 'script'");
		expect(unsupportedFlag.stderr).toContain("sh /tmp/script.sh");
	});

	test("keeps nested command loaders from executing app files", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/loaded-script.sh", content: "echo app-loaded\n" }],
		});

		for (const command of [
			`bash -c "$(cat ${test_db_files_mount}/loaded-script.sh)"`,
			`sh -c "$(cat ${test_db_files_mount}/loaded-script.sh)"`,
			`eval "$(cat ${test_db_files_mount}/loaded-script.sh)"`,
			`bash -c "$(command cat ${test_db_files_mount}/loaded-script.sh)"`,
			`bash -c "$(command -- cat ${test_db_files_mount}/loaded-script.sh)"`,
			`bash -c "$(command -p cat ${test_db_files_mount}/loaded-script.sh)"`,
			'bash -c "$(command cat $(pwd)/loaded-script.sh)"',
			'bash -c "$($(echo cat) loaded-script.sh)"',
			'bash -c "$(head -n 1 loaded-script.sh)"',
			'bash -c "$(tail -n 1 loaded-script.sh)"',
			'bash -c "$(grep app-loaded loaded-script.sh)"',
			"bash -c \"$(sed -n '1p' loaded-script.sh)\"",
			'bash -c "$(textgrep app-loaded loaded-script.sh)"',
			"script='source loaded-script.sh'; bash -c \"$script\"",
		]) {
			const result = await runner.run(command);
			expect(result.metadata.exitCode).not.toBe(0);
			expect(result.stdout).not.toContain("loaded");
			expect(result.stderr).toContain("cannot load app files or agent-only external mounts");
		}

		const tmpScript = await runner.run(
			"printf 'echo tmp-loaded\\n' > /tmp/loaded-script.sh && bash -c \"$(cat /tmp/loaded-script.sh)\"",
		);
		expect(tmpScript.metadata.exitCode).toBe(0);
		expect(tmpScript.stdout).toBe("tmp-loaded\n");

		const appPathAsData = await runner.run(`bash -c "$(echo 'echo app-path' ${test_db_files_mount}/loaded-script.sh)"`);
		expect(appPathAsData.metadata.exitCode).toBe(0);
		expect(appPathAsData.stdout).toBe(`app-path ${test_db_files_mount}/loaded-script.sh\n`);

		const dynamicCommandAsData = await runner.run(`bash -c "$($(echo echo) 'echo dynamic-command')"`);
		expect(dynamicCommandAsData.metadata.exitCode).toBe(0);
		expect(dynamicCommandAsData.stdout).toBe("dynamic-command\n");
	});

	test("rejects app shell code captured in assignments", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/loaded-script.sh", content: "echo app-loaded\n" }],
		});

		const executed = await runner.run('script="$(cat loaded-script.sh)"; bash -c "$script"');
		expect(executed.metadata.exitCode).not.toBe(0);
		expect(executed.stdout).not.toContain("app-loaded");
		expect(executed.stderr).toContain("cannot load app files or agent-only external mounts");

		const readAsData = await runner.run('script="$(cat loaded-script.sh)"; printf "%s" "$script"');
		expect(readAsData.metadata.exitCode).toBe(0);
		expect(readAsData.stdout).toBe("echo app-loaded");
	});

	test("rejects nested app-file reader command substitutions", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/loaded-script.sh", content: "echo\n" }],
		});

		const result = await runner.run('eval "$($(cat loaded-script.sh) echo nested-loaded)"');
		expect(result.metadata.exitCode).not.toBe(0);
		expect(result.stdout).not.toContain("nested-loaded");
		expect(result.stderr).toContain("cannot load app files or agent-only external mounts");
	});

	test("allows resolved echo commands to print app paths without reading them", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/loaded-script.sh", content: "echo app-loaded\n" }],
		});

		const result = await runner.run('bash -c "$($(echo echo) echo safe loaded-script.sh)"');
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe("safe loaded-script.sh\n");
	});

	test("rejects xargs -n with a non-positive or non-numeric value instead of silently batching all items", async () => {
		const { run } = await create_bash_runner();

		const zero = await run("printf 'a\\nb\\nc\\n' | xargs -n 0 echo");
		const nonNumeric = await run("printf 'a\\nb\\nc\\n' | xargs -n x echo");
		const attachedNonNumeric = await run("printf 'a\\nb\\nc\\n' | xargs -nx echo");
		const valid = await run("printf 'a\\nb\\nc\\n' | xargs -n 1 echo");

		expect(zero.metadata.exitCode).toBe(2);
		expect(zero.stderr).toContain("xargs: -n requires a positive integer");
		expect(zero.stderr).toContain("Supported: xargs");
		expect(nonNumeric.metadata.exitCode).toBe(2);
		expect(nonNumeric.stderr).toContain("xargs: -n requires a positive integer");
		expect(nonNumeric.stderr).toContain("Supported: xargs");
		expect(attachedNonNumeric.metadata.exitCode).toBe(2);
		expect(attachedNonNumeric.stderr).toContain("xargs: -n requires a positive integer");
		expect(attachedNonNumeric.stderr).toContain("Supported: xargs");
		expect(valid.metadata.exitCode).toBe(0);
	});

	test("validates xargs replacement delimiter and parallel option values", async () => {
		const { run } = await create_bash_runner();

		const missingReplace = await run("printf a | xargs -I");
		const emptyReplace = await run("printf a | xargs -I '' echo");
		const missingDelimiter = await run("printf a | xargs -d");
		const emptyDelimiter = await run("printf a | xargs -d '' echo");
		const missingParallel = await run("printf a | xargs -P");
		const invalidParallel = await run("printf a | xargs -P nope echo");
		const zeroParallel = await run("printf hi | xargs -P0 echo");
		const oneParallel = await run("printf hi | xargs -P 1 echo");
		const hugeParallel = await run(`printf a | xargs -P ${"9".repeat(400)} echo`);

		expect(missingReplace.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(missingReplace.stderr).toContain("xargs: -I requires a value");
		expect(emptyReplace.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(emptyReplace.stderr).toContain("xargs: -I requires a value");
		expect(missingDelimiter.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(missingDelimiter.stderr).toContain("xargs: -d requires a value");
		expect(emptyDelimiter.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(emptyDelimiter.stderr).toContain("xargs: -d requires a value");
		expect(missingParallel.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(missingParallel.stderr).toContain("xargs: -P requires a non-negative integer");
		expect(invalidParallel.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(invalidParallel.stderr).toContain("xargs: -P requires a non-negative integer");
		expect(zeroParallel.metadata.exitCode).toBe(0);
		expect(zeroParallel.stdout).toBe("hi\n");
		expect(oneParallel.metadata.exitCode).toBe(0);
		expect(oneParallel.stdout).toBe("hi\n");
		expect(hugeParallel.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(hugeParallel.stderr).toContain("parallel execution");
	});

	test("supports GNU-style xargs long aliases", async () => {
		const { run } = await create_bash_runner();

		const maxArgsSeparate = await run("printf 'a b c' | xargs --max-args 2 echo");
		const maxArgsEquals = await run("printf 'a b c' | xargs --max-args=2 echo");
		const replaceBare = await run("printf 'a\\n' | xargs --replace echo '<{}>'");
		const replaceEquals = await run("printf 'zeta\\n' | xargs --replace={} printf '({})\\n'");
		const delimiterSeparate = await run("printf 'a,b,c' | xargs --delimiter , echo");
		const delimiterEquals = await run("printf 'a:b:c' | xargs --delimiter=: echo");
		const missingMaxArgs = await run("printf a | xargs --max-args");
		const emptyReplace = await run("printf a | xargs --replace= echo");
		const emptyDelimiter = await run("printf a | xargs --delimiter= echo");

		expect(maxArgsSeparate.metadata.exitCode).toBe(0);
		expect(maxArgsSeparate.stdout).toBe("a b\nc\n");
		expect(maxArgsEquals.metadata.exitCode).toBe(0);
		expect(maxArgsEquals.stdout).toBe("a b\nc\n");
		expect(replaceBare.metadata.exitCode).toBe(0);
		expect(replaceBare.stdout).toBe("<a>\n");
		expect(replaceEquals.metadata.exitCode).toBe(0);
		expect(replaceEquals.stdout).toBe("(zeta)\n");
		expect(delimiterSeparate.metadata.exitCode).toBe(0);
		expect(delimiterSeparate.stdout).toBe("a b c\n");
		expect(delimiterEquals.metadata.exitCode).toBe(0);
		expect(delimiterEquals.stdout).toBe("a b c\n");
		expect(missingMaxArgs.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(missingMaxArgs.stderr).toContain("xargs: -n requires a positive integer");
		expect(emptyReplace.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(emptyReplace.stderr).toContain("xargs: -I requires a value");
		expect(emptyDelimiter.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(emptyDelimiter.stderr).toContain("xargs: -d requires a value");
	});

	test("keeps xargs replacement input newline-delimited and UTF-8 decoded", async () => {
		const { run } = await create_bash_runner();

		const replacement = await run("printf 'alpha beta\\ncafé file\\n' | xargs -I{} printf '<{}>\\n'");
		const doubleDash = await run("printf ok | xargs -- echo");
		const emptyInput = await run("printf '' | xargs echo should-not-run");

		expect(replacement.metadata.exitCode).toBe(0);
		expect(replacement.stdout).toBe("<alpha beta>\n<café file>\n");
		expect(doubleDash.metadata.exitCode).toBe(0);
		expect(doubleDash.stdout).toBe("ok\n");
		expect(emptyInput.metadata.exitCode).toBe(0);
		expect(emptyInput.stdout).toBe("");
	});

	test("parses options after the search query", async () => {
		const { run, runQuery } = await create_bash_runner();

		await run("search unique-token --limit 5");

		expect(runQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				query: "unique-token",
				numItems: 5,
			}),
		);
	});

	test("reports stdout truncation without path-index truncation", async () => {
		const { run } = await create_bash_runner();

		// A wide zero pad reaches the cap in one command; seq now stops at the loop-iteration limit
		// well below it.
		const result = await run("printf '%0200000d' 1");

		expect(result.metadata.stdoutTruncated).toBe(true);
		expect(result.metadata.stdoutLength).toBeGreaterThan(128 * 1024);
		expect(result.metadata.pathIndexTruncated).toBe(false);
		expect(result.stdout).toContain("[truncated after 131072 characters]");
	});

	describe("github mounts (Phase F7)", () => {
		// README content is markdown-hostile on purpose and small enough to read inline from the
		// committed plain-text chunks (no R2 round-trip), matching how the sync materializes external mount content.
		const README_TEXT = "# experiment--t3-chat\n\nMounted repo readme.\nZorptelemetry marker line.\n";
		const GUIDE_TEXT = "guide alpha\nguide beta\n";
		const MOUNT_COMMIT_SHA = "a".repeat(40);

		// Seed reserved-scope (`GLOBAL`/`GITHUB`) plain-text nodes via the real Phase D path, under the
		// commit-keyed root a finished sync would produce. Bash only mounts sources whose
		// `lastCommitSha` is set, so the source row is part of the fixture.
		async function seed_github_mount(
			runner: Awaited<ReturnType<typeof create_bash_runner>>,
			name: string,
			files: { path: string; rawText: string }[],
		) {
			const inserted = (await runner.t.mutation(internal.github_mounts.upsert_mount, {
				name,
				owner: "raythurnvoid",
				repo: "experiment--t3-chat",
				ref: "main",
			})) as { _yay?: { mountId: Id<"github_mounts"> }; _nay?: { message: string } };
			if (!inserted._yay) {
				throw new Error(`Failed to seed github mount ${name}: ${inserted._nay?.message}`);
			}
			const mountId = inserted._yay.mountId;
			await runner.t.run((ctx) => ctx.db.patch("github_mounts", mountId, { lastCommitSha: MOUNT_COMMIT_SHA }));
			for (const file of files) {
				const created = (await runner.t.action(internal.files_nodes_content.create_file_node_internal, {
					workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
					path: `/${name}/${MOUNT_COMMIT_SHA}${file.path}`,
					rawText: file.rawText,
				})) as { _yay?: unknown; _nay?: { message: string } };
				if (!created._yay) {
					throw new Error(`Failed to seed mount file /${name}${file.path}: ${created._nay?.message}`);
				}
			}
		}

		test("lists reserved top-level mount folders at the synthetic /.mounts root", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount(runner, "t3-chat", [{ path: "/README.md", rawText: README_TEXT }]);
			await seed_github_mount(runner, "examples", [{ path: "/hello.md", rawText: "hello\n" }]);

			const result = await runner.run("ls /.mounts");

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("t3-chat");
			expect(result.stdout).toContain("examples");
		});

		test("lists and reads files inside a mount byte-identically", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount(runner, "t3-chat", [
				{ path: "/README.md", rawText: README_TEXT },
				{ path: "/docs/guide.md", rawText: GUIDE_TEXT },
			]);

			const listing = await runner.run("ls /.mounts/t3-chat");
			expect(listing.metadata.exitCode).toBe(0);
			expect(listing.stdout).toContain("README.md");
			expect(listing.stdout).toContain("docs");

			runner.runQuery.mockClear();
			const readme = await runner.run("cat /.mounts/t3-chat/README.md");
			expect(readme.metadata.exitCode).toBe(0);
			expect(readme.stdout).toBe(README_TEXT);

			const guide = await runner.run("cat /.mounts/t3-chat/docs/guide.md");
			expect(guide.metadata.exitCode).toBe(0);
			expect(guide.stdout).toBe(GUIDE_TEXT);
			expect(
				runner.runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_pending_updates:get_by_file_node"),
			).toBe(false);
		});

		test("rejects mount glob patterns without shell-expanding reserved db files", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount(runner, "t3-chat", [{ path: "/README.md", rawText: README_TEXT }]);

			const result = await runner.run("ls /.mounts/t3-chat/*.md");

			expect(result.metadata.exitCode).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("app file glob patterns are not supported");
			expect(result.stderr).toContain("Try: find /.mounts/t3-chat -type f --extension md --limit 20");
		});

		test("reports mount folders as directories for readers", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount(runner, "t3-chat", [{ path: "/docs/guide.md", rawText: GUIDE_TEXT }]);

			for (const command of [
				"cat /.mounts/t3-chat/docs",
				"head /.mounts/t3-chat/docs",
				"sed -n '1p' /.mounts/t3-chat/docs",
				"wc /.mounts/t3-chat/docs",
			]) {
				const result = await runner.run(command);
				expect(result.metadata.exitCode).not.toBe(0);
				expect(result.stdout).toBe("");
				expect(result.stderr).toContain("Is a directory");
			}
		});

		test("cd into a mount persists across invocations", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount(runner, "t3-chat", [{ path: "/docs/guide.md", rawText: GUIDE_TEXT }]);

			const moved = await runner.run("cd /.mounts/t3-chat/docs");
			expect(moved.metadata.exitCode).toBe(0);

			const here = await runner.run("pwd");
			expect(here.metadata.exitCode).toBe(0);
			expect(here.stdout).toBe("/.mounts/t3-chat/docs\n");
		});

		test("grep and search find content scoped to a mount", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount(runner, "t3-chat", [{ path: "/README.md", rawText: README_TEXT }]);

			const grepped = await runner.run("grep Zorptelemetry /.mounts/t3-chat/README.md");
			expect(grepped.metadata.exitCode).toBe(0);
			expect(grepped.stdout).toContain("Zorptelemetry marker line.");

			const searched = await runner.run("search --path /.mounts/t3-chat Zorptelemetry");
			expect(searched.metadata.exitCode).toBe(0);
			expect(searched.stdout).toContain("README.md");
		});

		test("find --prefix resolves relative to mount cwd and returns zero matches for absent prefixes", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount(runner, "t3-chat", [
				{ path: "/docs/guide.md", rawText: GUIDE_TEXT },
				{ path: "/docs/notes.md", rawText: "notes\n" },
				{ path: "/docs-archive/leak.md", rawText: "leak\n" },
			]);

			const fromMount = await runner.run("cd /.mounts/t3-chat && find --prefix docs --limit 20 -type f");
			expect(fromMount.metadata.exitCode).toBe(0);
			expect(fromMount.stdout).toContain("/.mounts/t3-chat/docs/guide.md");
			expect(fromMount.stdout).toContain("/.mounts/t3-chat/docs/notes.md");
			expect(fromMount.stdout).not.toContain("/.mounts/t3-chat/docs-archive/leak.md");

			const fromDocs = await runner.run("cd /.mounts/t3-chat/docs && find --prefix . --limit 1");
			expect(fromDocs.metadata.exitCode).toBe(0);
			expect(fromDocs.stdout).toContain("/.mounts/t3-chat/docs/");

			const paged = await runner.run("cd /.mounts/t3-chat && find --prefix docs --limit 1");
			expect(paged.metadata.exitCode).toBe(0);
			expect(paged.stdout).toMatch(/Next page: find --prefix \/.mounts\/t3-chat\/docs --limit 1 --cursor \S+/u);

			const missing = await runner.run("find --prefix /.mounts/nope --limit 20");
			expect(missing.metadata.exitCode).toBe(0);
			expect(missing.stdout).toContain("0 matches.");
		});

		test("keeps mount content isolated from the tenant app file tree", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount(runner, "t3-chat", [{ path: "/README.md", rawText: README_TEXT }]);

			// The default app file tree has no Zorptelemetry marker, so an app-scope search misses it:
			// the reserved mount scope is reachable only through the /.mounts prefix.
			const workspaceSearch = await runner.run("search Zorptelemetry");
			expect(workspaceSearch.metadata.exitCode).toBe(0);
			expect(workspaceSearch.stdout).not.toContain("README.md");

			// The runner starts in the app file tree root; listing it shows app folders, never mounts.
			const workspaceRoot = await runner.run("ls");
			expect(workspaceRoot.metadata.exitCode).toBe(0);
			expect(workspaceRoot.stdout).toContain("docs");
			expect(workspaceRoot.stdout).not.toContain("t3-chat");

			// The stored reserved path (without the /.mounts prefix) is not addressable from the shell.
			const bare = await runner.run("cat /t3-chat/README.md");
			expect(bare.metadata.exitCode).not.toBe(0);
		});

		test("rejects every write into a read-only mount and leaves it intact", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount(runner, "t3-chat", [{ path: "/README.md", rawText: README_TEXT }]);

			const writes = [
				"touch /.mounts/t3-chat/new.txt",
				"rm /.mounts/t3-chat/README.md",
				"mv /.mounts/t3-chat/README.md /.mounts/t3-chat/renamed.md",
				"echo hi | tee /.mounts/t3-chat/new.txt",
				"cp /.mounts/t3-chat/README.md /.mounts/t3-chat/copy.md",
			];
			for (const command of writes) {
				const result = await runner.run(command);
				expect(result.metadata.exitCode).not.toBe(0);
				expect(result.stderr).toContain("is a read-only mount of an external source");
			}

			// The mount file is still present and unchanged after all rejected writes.
			const readme = await runner.run("cat /.mounts/t3-chat/README.md");
			expect(readme.metadata.exitCode).toBe(0);
			expect(readme.stdout).toBe(README_TEXT);
		});

		test("allows copying a mount file out to /tmp scratch", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount(runner, "t3-chat", [{ path: "/README.md", rawText: README_TEXT }]);

			const copied = await runner.run("cp /.mounts/t3-chat/README.md /tmp/readme.md && cat /tmp/readme.md");
			expect(copied.metadata.exitCode).toBe(0);
			expect(copied.stdout).toBe(README_TEXT);
		});

		test("refuses to execute a mount file through bash", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount(runner, "t3-chat", [{ path: "/script.sh", rawText: "echo pwned\n" }]);

			for (const command of ["bash /.mounts/t3-chat/script.sh"]) {
				const result = await runner.run(command);
				expect(result.metadata.exitCode).not.toBe(0);
				expect(result.stdout).not.toContain("pwned");
				expect(result.stderr).toContain("not executable through bash");
			}

			for (const command of [
				"source /.mounts/t3-chat/script.sh",
				". /.mounts/t3-chat/script.sh",
				"BONOBO=1 source /.mounts/t3-chat/script.sh",
				"2>/tmp/source.err source /.mounts/t3-chat/script.sh",
				"command source /.mounts/t3-chat/script.sh",
				"command -- source /.mounts/t3-chat/script.sh",
				"command -p source /.mounts/t3-chat/script.sh",
				"eval 'source /.mounts/t3-chat/script.sh'",
				"eval 'BONOBO=1 source /.mounts/t3-chat/script.sh'",
				"bash -c 'source /.mounts/t3-chat/script.sh'",
				"bash -c '2>/tmp/source.err source /.mounts/t3-chat/script.sh'",
				"sh -c '. /.mounts/t3-chat/script.sh'",
			]) {
				const result = await runner.run(command);
				expect(result.metadata.exitCode).not.toBe(0);
				expect(result.stdout).not.toContain("pwned");
				expect(result.stderr).toContain("cannot load app files or agent-only external mounts");
			}
		});

		test("keeps nested command loaders from executing mount files", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount(runner, "t3-chat", [{ path: "/script.sh", rawText: "echo mount-loaded\n" }]);

			for (const command of [
				"printf '%s\\n' '/.mounts/t3-chat/script.sh' | xargs source",
				"printf '%s\\n' '/.mounts/t3-chat/script.sh' | xargs .",
				'bash -c "$(cat /.mounts/t3-chat/script.sh)"',
				'sh -c "$(cat /.mounts/t3-chat/script.sh)"',
				'eval "$(cat /.mounts/t3-chat/script.sh)"',
			]) {
				const result = await runner.run(command);
				expect(result.metadata.exitCode).not.toBe(0);
				expect(result.stdout).not.toContain("loaded");
				expect(result.stderr).toContain("cannot load app files or agent-only external mounts");
			}
		});

		test("reports missing mount targets as no such file", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount(runner, "t3-chat", [{ path: "/README.md", rawText: README_TEXT }]);

			const listMissing = await runner.run("ls /.mounts/nope");
			expect(listMissing.metadata.exitCode).not.toBe(0);
			expect(listMissing.stderr).toContain("No such file");

			const catMissing = await runner.run("cat /.mounts/nope/x.md");
			expect(catMissing.metadata.exitCode).not.toBe(0);
			expect(catMissing.stderr).toContain("No such file");
		});

		test("keeps the launching call's mounts inside a background job", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount(runner, "t3-chat", [{ path: "/README.md", rawText: README_TEXT }]);

			expect((await runner.run("{ ls /.mounts; cat /.mounts/t3-chat/README.md; } &")).metadata.exitCode).toBe(0);

			// The worker builds its own filesystem, so it must fetch the mount list itself. Without
			// that query `/.mounts` is empty inside the job even though the launching call saw it.
			const row = await job_row(runner, 1);
			await bash_run_job(runner.ctx, { invocationId: row._id });

			const finished = await job_row(runner, 1);
			expect(finished.result?.metadata.exitCode, finished.result?.stderr).toBe(0);
			expect(finished.result?.stdout).toBe(`t3-chat\n${README_TEXT}`);
		});
	});

	describe("run_plugin_review", () => {
		const reviewRoot = `/review-${"a".repeat(32)}`;
		const otherRoot = `/review-${"b".repeat(32)}`;
		const source = "// Reviewneedle marker\nexport const ready = true;\n";

		async function create_review_runner() {
			const runner = await create_bash_runner();
			for (const [path, rawText] of [
				[`${reviewRoot}/dist/worker.js`, source],
				[`${reviewRoot}/script.sh`, "printf 'executed-source-marker'\n"],
				[`${otherRoot}/other.js`, "Reviewneedle Otherreviewprivate\n"],
			]) {
				const created = await runner.t.action(internal.files_nodes_content.create_file_node_internal, {
					workspaceId: organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
					path,
					rawText,
				});
				expect(created._nay).toBeUndefined();
			}
			let cwd = "/.plugins/review";
			let scratch: bash_ReviewScratch = { fileNodes: [], fileNodesContent: [] };
			const run = async (command: string) => {
				const result = await runner.t.action(internal.bash.run_plugin_review, {
					reviewRoot,
					userId: runner.seeded.userId,
					command,
					cwd,
					scratch,
				});
				cwd = result.cwd;
				scratch = result.scratch;
				return result;
			};
			return { runner, run };
		}

		test("reads and searches only the pinned source tree with ordinary Bash commands", async () => {
			const { run } = await create_review_runner();
			const read = await run("cat dist/worker.js");
			expect(read.exitCode).toBe(0);
			expect(read.output).toContain(source.trim());
			for (const command of [
				"ls dist",
				"find .",
				"grep -n Reviewneedle dist/worker.js",
				"search Reviewneedle",
				"tree /.plugins",
				"find /.plugins",
				"search --path /.plugins Reviewneedle",
				"cd /tmp && search Reviewneedle",
				`meta search --where '{"eq":["metadata.source","plugin-source"]}'`,
				"cd / && search Reviewneedle",
			]) {
				const result = await run(command);
				expect(result.exitCode, result.output).toBe(0);
				expect(result.output).toContain("worker.js");
				expect(result.output).not.toContain("Otherreviewprivate");
				expect(result.output).not.toContain("other.js");
			}
		});

		test("has no /shells mount and no jobs, wait or kill; & runs inline", async () => {
			const { run } = await create_review_runner();
			expect((await run("ls /shells")).exitCode).not.toBe(0);
			for (const command of ["jobs", "kill 1"]) {
				const result = await run(command);
				expect(result.exitCode, result.output).toBe(127);
			}
			const inline = await run("echo inline &");
			expect(inline.exitCode, inline.output).toBe(0);
			expect(inline.output).toContain("inline");
			expect(inline.output).not.toContain("started job");
		});

		test("resolve refuses tenant and reserved IDs in plugin review", async () => {
			const { runner, run } = await create_review_runner();
			const tenantId = await get_seeded_node_id(runner, "/docs/readme.md");
			const reserved = await runner.t.query(internal.files_nodes.get_by_path, {
				organizationId: "GLOBAL",
				workspaceId: organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
				visibilityUserId: runner.seeded.userId,
				path: `${reviewRoot}/dist/worker.js`,
			});
			expect(reserved).not.toBeNull();
			vi.mocked(fetch).mockClear();

			for (const nodeId of [tenantId, reserved!._id]) {
				const result = await run(`resolve '${nodeId}'`);
				expect(result.exitCode).toBe(1);
				expect(result.output).toContain("unavailable in the current workspace");
				expect(result.output).not.toContain("/docs/readme.md");
				expect(result.output).not.toContain("dist/worker.js");
			}
			const tenantLookup = await runner.run(`resolve '${reserved!._id}'`);
			expect(tenantLookup.metadata.exitCode).toBe(1);
			expect(tenantLookup.stdout).toBe("");
			expect(tenantLookup.metadata.observedPaths).toEqual([]);
			expect(fetch).not.toHaveBeenCalled();
		});

		test("keeps cwd and scratch between calls without writing a chat thread", async () => {
			const { runner, run } = await create_review_runner();
			const before = await runner.t.run((ctx) => ctx.db.query("ai_chat_threads").collect());
			expect((await run("mkdir /tmp/notes && printf 'follow the backend' > /tmp/notes/plan && cd dist")).exitCode).toBe(
				0,
			);
			const next = await run("cat /tmp/notes/plan && cat worker.js");
			expect(next.exitCode).toBe(0);
			expect(next.cwd).toBe("/.plugins/review/dist");
			expect(next.output).toContain("follow the backend");
			expect(next.output).toContain(source.trim());
			expect(await runner.t.run((ctx) => ctx.db.query("ai_chat_threads").collect())).toEqual(before);
			expect(await runner.t.run((ctx) => ctx.db.query("ai_chat_files").collect())).toEqual([]);
		});

		test("hides review files from the main agent and blocks unrelated paths in review", async () => {
			const { runner, run } = await create_review_runner();
			expect((await runner.run("search Reviewneedle")).stdout).not.toContain("worker.js");
			expect((await runner.run("cat /.plugins/review/dist/worker.js")).metadata.exitCode).not.toBe(0);
			for (const path of [
				"/home/cloud-usr/w/personal/home/docs/readme.md",
				`${otherRoot}/other.js`,
				`/.plugins/review/../../${otherRoot.slice(1)}/other.js`,
				"/.plugins/other/other.js",
				"/.mounts/other/other.js",
				"/etc/passwd",
			]) {
				const result = await run(`cat ${path}`);
				expect(result.exitCode, result.output).not.toBe(0);
				expect(result.output).not.toContain("Otherreviewprivate");
				expect(result.output).not.toContain("unique-token");
			}
		});

		test("refuses source changes and mounted shell execution", async () => {
			const { run } = await create_review_runner();
			for (const command of [
				"printf changed > dist/worker.js",
				"printf changed | tee dist/worker.js",
				"rm dist/worker.js",
				"mv dist/worker.js dist/changed.js",
				"cp dist/worker.js dist/copy.js",
				"touch dist/new.js",
				"mkdir new",
				"bash script.sh",
				"source script.sh",
			]) {
				const result = await run(command);
				expect(result.exitCode, result.output).not.toBe(0);
				expect(result.output).not.toContain("executed-source-marker");
			}
			expect((await run("cat dist/worker.js")).output).toContain(source.trim());
		});

		test("bounds scratch and keeps guidance when a pipeline discards stderr", async () => {
			const { run } = await create_review_runner();
			const scratch = await run("printf '%3000s' x > /tmp/large.txt");
			expect(scratch.output).toContain("not persisted");
			expect(scratch.scratch.fileNodes).toEqual([]);
			expect((await run("cat /tmp/large.txt")).exitCode).not.toBe(0);
			const invalid = await run("cat --invalid dist/worker.js 2>/dev/null | head");
			expect(invalid.output).toContain("cat: unsupported option");
		});

		test("rejects a host request for a root outside the review namespace", async () => {
			const { runner } = await create_review_runner();
			await expect(
				runner.t.action(internal.bash.run_plugin_review, {
					reviewRoot: "/",
					userId: runner.seeded.userId,
					command: "ls",
					cwd: "/.plugins/review",
					scratch: { fileNodes: [], fileNodesContent: [] },
				}),
			).rejects.toThrow("Invalid plugin review root");
		});

		test("stages exact source and cleans only that attempt's nodes, chunks, and assets", async () => {
			const { runner } = await create_review_runner();
			const preserved = await runner.t.run((ctx) => ctx.db.query("files_nodes").collect());
			const beforeAssets = await runner.t.run((ctx) => ctx.db.query("files_r2_assets").collect());
			const staged = await runner.t.action(internal.plugins_review.stage_sources, {
				files: [{ path: "dist/worker.js", source: "// café 🦜\r\nexport const value = 1;\r\n" }],
			});
			expect(staged._nay).toBeUndefined();
			if (!staged._yay) throw new Error("Source staging failed");
			const read = await runner.t.action(internal.bash.run_plugin_review, {
				reviewRoot: staged._yay.reviewRoot,
				userId: runner.seeded.userId,
				command: "cat dist/worker.js",
				cwd: "/.plugins/review",
				scratch: { fileNodes: [], fileNodesContent: [] },
			});
			expect(read.exitCode).toBe(0);
			expect(read.output).toContain("// café 🦜\nexport const value = 1;");
			const nodes = await runner.t.run((ctx) => ctx.db.query("files_nodes").collect());
			const stagedNodeIds = new Set(
				nodes.filter((node) => node.path.startsWith(`${staged._yay.reviewRoot}/`)).map((node) => node._id),
			);
			const file = nodes.find((node) => node.path === `${staged._yay.reviewRoot}/dist/worker.js`);
			if (!file?.assetId) throw new Error("Staged source has no asset");
			const asset = await runner.t.run((ctx) => ctx.db.get("files_r2_assets", file.assetId!));
			expect(test_r2_objects.get(asset!.r2Key!)).toEqual(
				new TextEncoder().encode("// café 🦜\r\nexport const value = 1;\r\n"),
			);
			const stored = await runner.t.run((ctx) => ctx.db.query("files_text_chunks").collect());
			expect(stored.some((chunk) => chunk.sourceKind === "committed" && stagedNodeIds.has(chunk.fileNodeId))).toBe(
				true,
			);
			await runner.t.mutation(internal.plugins.delete_review_source_tree, { reviewRoot: staged._yay.reviewRoot });
			expect(await runner.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(preserved);
			expect(await runner.t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toEqual(beforeAssets);
			for (const table of ["files_text_chunks", "files_plain_text_chunks"] as const) {
				const chunks = await runner.t.run((ctx) => ctx.db.query(table).collect());
				expect(chunks.some((chunk) => chunk.sourceKind === "committed" && stagedNodeIds.has(chunk.fileNodeId))).toBe(
					false,
				);
			}
		});

		test("schedules cleanup before staging so an abandoned attempt expires", async () => {
			const { runner } = await create_review_runner();
			const before = await runner.t.run((ctx) => ctx.db.query("files_nodes").collect());
			vi.useFakeTimers();
			try {
				const staged = await runner.t.action(internal.plugins_review.stage_sources, {
					files: Array.from({ length: 30 }, (_, index) => ({ path: `dist/module-${index}.js`, source })),
				});
				expect(staged._nay).toBeUndefined();
				expect((await runner.t.run((ctx) => ctx.db.query("files_nodes").collect())).length).toBeGreaterThan(
					before.length,
				);
				await runner.t.finishAllScheduledFunctions(() => vi.runAllTimers());
				expect(await runner.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			} finally {
				vi.useRealTimers();
			}
		});

		test("reads a bounded window near the end of a large minified file", async () => {
			const { runner } = await create_review_runner();
			const staged = await runner.t.action(internal.plugins_review.stage_sources, {
				files: [{ path: "dist/large.js", source: `${"x".repeat(780_000)};const payload = 'Largetailneedle';` }],
			});
			if (!staged._yay) throw new Error(staged._nay.message);
			const read = await runner.t.action(internal.bash.run_plugin_review, {
				reviewRoot: staged._yay.reviewRoot,
				userId: runner.seeded.userId,
				command: "grep --start-index 780000 --max-chars 2000 payload dist/large.js",
				cwd: "/.plugins/review",
				scratch: { fileNodes: [], fileNodesContent: [] },
			});
			expect(read.exitCode, read.output).toBe(0);
			expect(read.output).toContain("Largetailneedle");
			expect(read.output.length).toBeLessThan(3000);
		});

		test.each(["../escape.js", "/escape.js", "dist/../escape.js", "dist//escape.js"])(
			"refuses source path %s before writing anything",
			async (path) => {
				const { runner } = await create_review_runner();
				const before = await runner.t.run((ctx) => ctx.db.query("files_nodes").collect());
				const staged = await runner.t.action(internal.plugins_review.stage_sources, {
					files: [
						{ path: "dist/valid.js", source },
						{ path, source },
					],
				});
				expect(staged._nay?.message).toContain("normalized relative paths");
				expect(await runner.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			},
		);

		test("cleans partial staging when a later file cannot be created", async () => {
			const { runner } = await create_review_runner();
			const before = await runner.t.run((ctx) => ctx.db.query("files_nodes").collect());
			vi.useFakeTimers();
			try {
				const staged = await runner.t.action(internal.plugins_review.stage_sources, {
					files: [
						{ path: "dist/worker.js", source },
						{ path: "dist/worker.js/child.js", source },
					],
				});
				expect(staged._nay).toBeDefined();
				await runner.t.finishAllScheduledFunctions(() => vi.runAllTimers());
				expect(await runner.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("plugin source mounts", () => {
		const WORKER_TEXT = "export const plugin = 'media';\nGlomtelemetry marker line.\n";
		const PLUGIN_README_TEXT = "# media plugin\n\nPlugin source readme.\n";

		// Seed a registered plugin version with a version-keyed source tree in the reserved
		// GLOBAL/PLUGINS scope, plus an enabled installation in the runner's workspace — the
		// same rows the publish + install flows produce, without the full publish pipeline.
		async function seed_plugin_mount(
			runner: Awaited<ReturnType<typeof create_bash_runner>>,
			pluginName: string,
			files: { path: string; rawText: string }[],
			opts?: { installed?: boolean },
		) {
			const now = Date.now();
			const pluginVersionId = await runner.t.run((ctx) =>
				ctx.db.insert("plugins_versions", {
					name: pluginName,
					displayName: pluginName,
					version: "0.1.0",
					description: `${pluginName} plugin`,
					reviewStatus: "passed",
					reviewId: null,
					isLatest: true,
					artifactHash: `sha256:${"a".repeat(64)}`,
					sourceRepositoryUrl: `https://github.com/bonobo/${pluginName}-plugin`,
					sourceOwner: "bonobo",
					sourceRepo: `${pluginName}-plugin`,
					sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
					manifestR2Key: `plugins/${pluginName}/manifest.json`,
					backendEntrypointFile: {
						entry: "dist/backend/worker.js",
						moduleName: "plugin.js",
						r2Key: `plugins/${pluginName}/backend/worker.js`,
						sha256: `sha256:${"b".repeat(64)}`,
						compatibilityDate: "2026-07-01",
						compatibilityFlags: ["nodejs_compat"],
					},
					configuration: null,
					events: [{ type: "files.upload.completed", contentTypes: ["image/png"], filters: [] }],
					pages: [],
					fileViews: [],
					capabilities: [],
					outboundOrigins: [],
					uiOutboundOrigins: [],
					files: [],
					sourceStatus: "ready",
					sourceLastError: null,
					createdBy: runner.seeded.userId,
					updatedAt: now,
				}),
			);
			for (const file of files) {
				const created = (await runner.t.action(internal.files_nodes_content.create_file_node_internal, {
					workspaceId: organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
					path: `/${pluginVersionId}${file.path}`,
					rawText: file.rawText,
				})) as { _yay?: unknown; _nay?: { message: string } };
				if (!created._yay) {
					throw new Error(`Failed to seed plugin source file ${file.path}: ${created._nay?.message}`);
				}
			}
			let installationId: Id<"plugins_workspace_installations"> | null = null;
			if (opts?.installed !== false) {
				installationId = await runner.t.run(async (ctx) => {
					const serviceAccountId = await ctx.db.insert("access_control_service_accounts", {
						organizationId: runner.seeded.organizationId,
						workspaceId: runner.seeded.workspaceId,
						name: pluginName,
						createdBy: runner.seeded.userId,
						createdAt: now,
						updatedAt: now,
						revokedAt: null,
					});
					await ctx.db.insert("plugins_service_account_bindings", {
						organizationId: runner.seeded.organizationId,
						workspaceId: runner.seeded.workspaceId,
						pluginName,
						publisherUserId: runner.seeded.userId,
						sourceRepositoryUrl: `https://github.com/bonobo/${pluginName}-plugin`,
						serviceAccountId,
					});
					return await ctx.db.insert("plugins_workspace_installations", {
						organizationId: runner.seeded.organizationId,
						workspaceId: runner.seeded.workspaceId,
						serviceAccountId,
						pluginVersionId,
						pluginName,
						status: "enabled",
						configurationYaml: null,
						acceptedCapabilities: [],
						capabilitiesAcceptedAt: now,
						acceptedOutboundOrigins: [],
						acceptedUiOutboundOrigins: [],
						outboundOriginsAcceptedAt: now,
						installedBy: runner.seeded.userId,
						updatedBy: runner.seeded.userId,
						updatedAt: now,
					});
				});
			}
			return { pluginVersionId, installationId };
		}

		test("hides /.plugins entirely when no plugin is installed", async () => {
			const runner = await create_bash_runner();
			// Published but not installed in this workspace: no existence leak.
			await seed_plugin_mount(runner, "media", [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }], {
				installed: false,
			});

			const listing = await runner.run("ls /.plugins");
			expect(listing.metadata.exitCode).not.toBe(0);
			expect(listing.stderr).toContain("No such file");

			const read = await runner.run("cat /.plugins/media/dist/backend/worker.js");
			expect(read.metadata.exitCode).not.toBe(0);
			expect(read.stderr).toContain("No such file");

			// The fan-out commands also treat the root as nonexistent with zero installations.
			const tree = await runner.run("tree /.plugins");
			expect(tree.metadata.exitCode).not.toBe(0);
			expect(tree.stderr).toContain("No such file");

			const found = await runner.run("find /.plugins");
			expect(found.metadata.exitCode).not.toBe(0);
			expect(found.stderr).toContain("No such file");

			const searched = await runner.run("search --path /.plugins Glomtelemetry");
			expect(searched.metadata.exitCode).not.toBe(0);
			expect(searched.stderr).toContain("No such file");
		});

		test("lists installed plugin names at the synthetic /.plugins root", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount(runner, "media", [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }]);
			await seed_plugin_mount(runner, "alpha-notes", [{ path: "/README.md", rawText: PLUGIN_README_TEXT }]);

			const result = await runner.run("ls /.plugins");

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("media");
			expect(result.stdout).toContain("alpha-notes");
		});

		test("lists and reads files inside an installed plugin byte-identically", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount(runner, "media", [
				{ path: "/README.md", rawText: PLUGIN_README_TEXT },
				{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT },
			]);

			const listing = await runner.run("ls /.plugins/media");
			expect(listing.metadata.exitCode).toBe(0);
			expect(listing.stdout).toContain("README.md");
			expect(listing.stdout).toContain("dist");

			const readme = await runner.run("cat /.plugins/media/README.md");
			expect(readme.metadata.exitCode).toBe(0);
			expect(readme.stdout).toBe(PLUGIN_README_TEXT);

			const worker = await runner.run("cat /.plugins/media/dist/backend/worker.js");
			expect(worker.metadata.exitCode).toBe(0);
			expect(worker.stdout).toBe(WORKER_TEXT);
		});

		test("grep and search find content scoped to one plugin", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount(runner, "media", [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }]);

			const grepped = await runner.run("grep Glomtelemetry /.plugins/media/dist/backend/worker.js");
			expect(grepped.metadata.exitCode).toBe(0);
			expect(grepped.stdout).toContain("Glomtelemetry marker line.");

			const searched = await runner.run("search --path /.plugins/media Glomtelemetry");
			expect(searched.metadata.exitCode).toBe(0);
			expect(searched.stdout).toContain("worker.js");
		});

		test("fans out root-scope tree, find, and search across installed plugins in name order", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount(runner, "media", [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }]);
			await seed_plugin_mount(runner, "alpha-notes", [{ path: "/README.md", rawText: PLUGIN_README_TEXT }]);

			const tree = await runner.run("tree /.plugins");
			expect(tree.metadata.exitCode).toBe(0);
			expect(tree.stdout).toContain("/.plugins");
			expect(tree.stdout).toContain("|-- alpha-notes/");
			expect(tree.stdout).toContain("|-- media/");
			expect(tree.stdout).toContain("README.md");
			expect(tree.stdout).toContain("worker.js");
			expect(tree.stdout.indexOf("alpha-notes")).toBeLessThan(tree.stdout.indexOf("media"));

			const found = await runner.run("find /.plugins -type f --limit 20");
			expect(found.metadata.exitCode).toBe(0);
			expect(found.stdout).toContain("/.plugins/alpha-notes/README.md");
			expect(found.stdout).toContain("/.plugins/media/dist/backend/worker.js");

			// Depth predicates are relative to /.plugins: -maxdepth 1 keeps only plugin folders.
			const top = await runner.run("find /.plugins -maxdepth 1 --limit 20");
			expect(top.metadata.exitCode).toBe(0);
			expect(top.stdout).toContain("/.plugins/alpha-notes/");
			expect(top.stdout).toContain("/.plugins/media/");
			expect(top.stdout).not.toContain("README.md");

			const searched = await runner.run("search --path /.plugins Glomtelemetry");
			expect(searched.metadata.exitCode).toBe(0);
			expect(searched.stdout).toContain("under /.plugins");
			expect(searched.stdout).toContain("/.plugins/media/dist/backend/worker.js");
		});

		test("pages the /.plugins fan-out with a composite cursor and detects listing changes", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount(runner, "alpha-notes", [{ path: "/README.md", rawText: PLUGIN_README_TEXT }]);
			const { installationId } = await seed_plugin_mount(runner, "media", [
				{ path: "/README.md", rawText: PLUGIN_README_TEXT },
			]);

			const firstPage = await runner.run("find /.plugins -type f --limit 1");
			expect(firstPage.metadata.exitCode).toBe(0);
			expect(firstPage.stdout).toContain("/.plugins/alpha-notes/README.md");
			expect(firstPage.stdout).not.toContain("/.plugins/media/README.md");
			const continuation = firstPage.stdout.match(/Next page: (find .+)/)?.[1];
			expect(continuation).toBeTruthy();

			// The composite cursor resumes into the next plugin in name order.
			const secondPage = await runner.run(String(continuation));
			expect(secondPage.metadata.exitCode).toBe(0);
			expect(secondPage.stdout).toContain("/.plugins/media/README.md");

			// Uninstalling between pages invalidates the pinned listing snapshot.
			const restartPage = await runner.run("find /.plugins -type f --limit 1");
			const staleContinuation = restartPage.stdout.match(/Next page: (find .+)/)?.[1];
			expect(staleContinuation).toBeTruthy();
			await runner.t.run(async (ctx) => {
				if (installationId == null) {
					throw new Error("Expected seeded installation");
				}
				await ctx.db.delete("plugins_workspace_installations", installationId);
			});
			const changed = await runner.run(String(staleContinuation));
			expect(changed.metadata.exitCode).not.toBe(0);
			expect(changed.stderr).toContain("listing changed");
		});

		test("keeps guidance for root-scope --prefix and meta search", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount(runner, "media", [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }]);

			const prefixed = await runner.run("find --prefix /.plugins --limit 5");
			expect(prefixed.metadata.exitCode).not.toBe(0);
			expect(prefixed.stderr).toContain("--prefix cannot scan the /.plugins root");

			const metaSearched = await runner.run(`meta search --path /.plugins --where '{"exists":"frontmatter.cc"}'`);
			expect(metaSearched.metadata.exitCode).not.toBe(0);
			expect(metaSearched.stderr).toContain("choose a single plugin to search");
		});

		test("scoped tree and find work inside one plugin", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount(runner, "media", [
				{ path: "/README.md", rawText: PLUGIN_README_TEXT },
				{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT },
			]);

			const tree = await runner.run("tree /.plugins/media");
			expect(tree.metadata.exitCode).toBe(0);
			expect(tree.stdout).toContain("README.md");
			expect(tree.stdout).toContain("worker.js");

			const found = await runner.run("find /.plugins/media -type f --limit 20");
			expect(found.metadata.exitCode).toBe(0);
			expect(found.stdout).toContain("/.plugins/media/README.md");
			expect(found.stdout).toContain("/.plugins/media/dist/backend/worker.js");
		});

		test("cd into a plugin mount persists across invocations", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount(runner, "media", [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }]);

			const moved = await runner.run("cd /.plugins/media/dist");
			expect(moved.metadata.exitCode).toBe(0);

			const here = await runner.run("pwd");
			expect(here.metadata.exitCode).toBe(0);
			expect(here.stdout).toBe("/.plugins/media/dist\n");
		});

		test("rejects every write into a plugin mount and leaves it intact", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount(runner, "media", [{ path: "/README.md", rawText: PLUGIN_README_TEXT }]);

			const writes = [
				"touch /.plugins/media/new.txt",
				"rm /.plugins/media/README.md",
				"mv /.plugins/media/README.md /.plugins/media/renamed.md",
				"echo hi | tee /.plugins/media/new.txt",
				"cp /.plugins/media/README.md /.plugins/media/copy.md",
			];
			for (const command of writes) {
				const result = await runner.run(command);
				expect(result.metadata.exitCode).not.toBe(0);
				expect(result.stderr).toContain("read-only mount of installed plugin sources");
			}

			const readme = await runner.run("cat /.plugins/media/README.md");
			expect(readme.metadata.exitCode).toBe(0);
			expect(readme.stdout).toBe(PLUGIN_README_TEXT);
		});

		test("allows copying a plugin file out to /tmp scratch", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount(runner, "media", [{ path: "/README.md", rawText: PLUGIN_README_TEXT }]);

			const copied = await runner.run("cp /.plugins/media/README.md /tmp/readme.md && cat /tmp/readme.md");
			expect(copied.metadata.exitCode).toBe(0);
			expect(copied.stdout).toBe(PLUGIN_README_TEXT);
		});

		test("refuses to execute plugin source through bash and source", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount(runner, "media", [{ path: "/script.sh", rawText: "echo pwned\n" }]);

			const executed = await runner.run("bash /.plugins/media/script.sh");
			expect(executed.metadata.exitCode).not.toBe(0);
			expect(executed.stdout).not.toContain("pwned");
			expect(executed.stderr).toContain("not executable through bash");

			const sourced = await runner.run("source /.plugins/media/script.sh");
			expect(sourced.metadata.exitCode).not.toBe(0);
			expect(sourced.stdout).not.toContain("pwned");
			expect(sourced.stderr).toContain("cannot load app files or agent-only external mounts");
		});

		test("reports not-installed plugin names as plain missing paths", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount(runner, "media", [{ path: "/README.md", rawText: PLUGIN_README_TEXT }]);

			const listMissing = await runner.run("ls /.plugins/nope");
			expect(listMissing.metadata.exitCode).not.toBe(0);
			expect(listMissing.stderr).toContain("No such file");

			const catMissing = await runner.run("cat /.plugins/nope/x.md");
			expect(catMissing.metadata.exitCode).not.toBe(0);
			expect(catMissing.stderr).toContain("No such file");
		});

		test("keeps plugin source isolated from the tenant app tree", async () => {
			const runner = await create_bash_runner();
			const { pluginVersionId } = await seed_plugin_mount(runner, "media", [
				{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT },
			]);

			// App-scope search never reaches the reserved plugin scope.
			const workspaceSearch = await runner.run("search Glomtelemetry");
			expect(workspaceSearch.metadata.exitCode).toBe(0);
			expect(workspaceSearch.stdout).not.toContain("worker.js");

			// The stored version-keyed path is not addressable outside the /.plugins prefix.
			const bare = await runner.run(`cat /${pluginVersionId}/dist/backend/worker.js`);
			expect(bare.metadata.exitCode).not.toBe(0);
		});

		test("drops the mount when the installation is removed", async () => {
			const runner = await create_bash_runner();
			const { installationId } = await seed_plugin_mount(runner, "media", [
				{ path: "/README.md", rawText: PLUGIN_README_TEXT },
			]);

			const visible = await runner.run("cat /.plugins/media/README.md");
			expect(visible.metadata.exitCode).toBe(0);

			await runner.t.run(async (ctx) => {
				if (installationId == null) {
					throw new Error("Expected seeded installation");
				}
				await ctx.db.delete("plugins_workspace_installations", installationId);
			});

			// Mounts are derived per command run, so the next call already reflects the uninstall.
			const gone = await runner.run("cat /.plugins/media/README.md");
			expect(gone.metadata.exitCode).not.toBe(0);
			expect(gone.stderr).toContain("No such file");
		});

		test("keeps the launching call's plugin mounts inside a background job", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount(runner, "media", [{ path: "/README.md", rawText: PLUGIN_README_TEXT }]);

			expect((await runner.run("{ ls /.plugins; cat /.plugins/media/README.md; } &")).metadata.exitCode).toBe(0);

			// The worker builds its own filesystem, so it must fetch the installed plugins itself.
			// Without that query `/.plugins` is empty inside the job.
			const row = await job_row(runner, 1);
			await bash_run_job(runner.ctx, { invocationId: row._id });

			const finished = await job_row(runner, 1);
			expect(finished.result?.metadata.exitCode, finished.result?.stderr).toBe(0);
			expect(finished.result?.stdout).toBe(`media\n${PLUGIN_README_TEXT}`);
		});
	});
});
