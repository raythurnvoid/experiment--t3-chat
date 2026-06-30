import { R2 } from "@convex-dev/r2";
import { zipSync, strToU8 } from "fflate";
import { afterEach, beforeEach, describe, expect, test as baseTest, vi } from "vitest";
import { internal } from "./_generated/api.js";
import { test_convex } from "./setup.test.ts";
import {
	github_source_validate_name,
	github_source_classify_rel_path,
	github_source_is_lfs_pointer,
	github_source_codeload_url,
} from "./github_sources.ts";
import { files_MAX_TEXT_CONTENT_BYTES } from "../shared/files.ts";
import { workspaces_GLOBAL_WORKSPACE_ID, workspaces_GLOBAL_GITHUB_PROJECT_ID } from "../shared/workspaces.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import type { Id } from "./_generated/dataModel.js";

const test = baseTest.sequential;

const OWNER = "raythurnvoid";
const REPO = "experiment--t3-chat";
const REF = "main";
const MOUNT = "t3-chat";
const COMMIT_1 = "a".repeat(40);
const TREE_1 = "b".repeat(40);
const COMMIT_2 = "c".repeat(40);
const TREE_2 = "d".repeat(40);

// Captured R2 PUT bodies keyed by R2 object key, so per-file content writes are visible to assertions and
// the hard-delete path has a real key to clean. Mirrors files_nodes.test.ts install_r2_object_capture.
let r2Objects: Map<string, BodyInit>;
let fetchMock: ReturnType<typeof vi.fn>;

/** Build a codeload-shaped ZIP: every entry lives under a single `<repo>-<sha>/` top-level folder. */
function build_repo_zip(commitSha: string, files: Record<string, string | Uint8Array>): Uint8Array {
	const top = `${REPO}-${commitSha}`;
	const entries: Record<string, Uint8Array> = {};
	for (const [relPath, content] of Object.entries(files)) {
		entries[`${top}/${relPath}`] = typeof content === "string" ? strToU8(content) : content;
	}
	return zipSync(entries);
}

type github_fetch_plan = {
	defaultBranch?: string;
	commitSha: string;
	treeSha: string;
	zip: Uint8Array;
	/** Reject the R2 PUT whose body equals this string (simulates a per-file write failure). */
	failUploadForBody?: string;
	/** Return 404 for the branch-metadata endpoint (simulates a hard metadata failure). */
	failBranchMetadata?: boolean;
};

/**
 * Install a fetch dispatcher covering the GitHub REST metadata endpoints, the commit-pinned codeload
 * archive, and the R2 upload PUT used by the Phase D write path.
 */
function install_fetch(plan: github_fetch_plan) {
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey?: string) => {
		const key = customKey ?? "test-upload-key";
		return { key, url: `https://r2.test/upload?key=${encodeURIComponent(key)}` };
	});
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key: string) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);

	fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
		if (urlString === `https://api.github.com/repos/${OWNER}/${REPO}`) {
			return new Response(JSON.stringify({ default_branch: plan.defaultBranch ?? "main" }), { status: 200 });
		}
		if (urlString === `https://api.github.com/repos/${OWNER}/${REPO}/branches/${REF}`) {
			if (plan.failBranchMetadata) {
				return new Response("Not Found", { status: 404 });
			}
			return new Response(
				JSON.stringify({ commit: { sha: plan.commitSha, commit: { tree: { sha: plan.treeSha } } } }),
				{ status: 200 },
			);
		}
		if (urlString === github_source_codeload_url({ owner: OWNER, repo: REPO, commitSha: plan.commitSha })) {
			// Copy into a fresh ArrayBuffer-backed view so the body types as BodyInit.
			return new Response(new Uint8Array(plan.zip), {
				status: 200,
				headers: { "content-length": String(plan.zip.length) },
			});
		}
		if (urlString.startsWith("https://r2.test/upload?key=") && init?.method === "PUT") {
			if (plan.failUploadForBody !== undefined && init.body === plan.failUploadForBody) {
				return new Response("upload rejected", { status: 500 });
			}
			const key = decodeURIComponent(urlString.slice("https://r2.test/upload?key=".length));
			r2Objects.set(key, init.body ?? "");
			return new Response(null, { status: 200 });
		}
		return new Response(null, { status: 404 });
	});
	vi.stubGlobal("fetch", fetchMock);
}

function count_codeload_fetches(commitSha: string): number {
	const target = github_source_codeload_url({ owner: OWNER, repo: REPO, commitSha });
	return fetchMock.mock.calls.filter((call) => call[0] === target).length;
}

/** Drive the registered workpool until the source reaches a terminal (idle/error) status. */
async function drain_until_settled(t: ReturnType<typeof test_convex>, sourceId: Id<"github_sources">) {
	for (let i = 0; i < 400; i++) {
		const source = await t.run((ctx) => ctx.db.get("github_sources", sourceId));
		if (source && source.status !== "running") {
			return source;
		}
		vi.advanceTimersByTime(1000);
		await t.finishInProgressScheduledFunctions();
	}
	throw new Error("Sync did not settle");
}

/** A bare user id, valid for the `v.id("users")` read arg (reserved-scope reads ignore the caller). */
async function make_reader_user(t: ReturnType<typeof test_convex>): Promise<Id<"users">> {
	return await t.run((ctx) => ctx.db.insert("users", { clerkUserId: null }));
}

async function create_running_source(
	t: ReturnType<typeof test_convex>,
	args: { name: string; syncRunId: string },
) {
	const inserted = await t.mutation(internal.github_sources.upsert_github_source, {
		name: args.name,
		owner: OWNER,
		repo: REPO,
		ref: REF,
	});
	if (inserted._nay) throw new Error(inserted._nay.message);
	await t.run((ctx) =>
		ctx.db.patch("github_sources", inserted._yay.sourceId, {
			status: "running",
			syncRunId: args.syncRunId,
			lockedAt: Date.now(),
		}),
	);
	return inserted._yay.sourceId;
}

async function list_mount_file_paths(t: ReturnType<typeof test_convex>, mount: string): Promise<string[]> {
	return await t.run(async (ctx) => {
		const nodes = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_treePath", (q) =>
				q
					.eq("workspaceId", workspaces_GLOBAL_WORKSPACE_ID)
					.eq("projectId", workspaces_GLOBAL_GITHUB_PROJECT_ID)
					.gte("treePath", `/${mount}/`)
					.lt("treePath", `/${mount}/￿`),
			)
			.collect();
		return nodes.filter((node) => node.kind === "file").map((node) => node.path);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	r2Objects = new Map();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllTimers();
	vi.useRealTimers();
});

// #region pure helpers

describe("github_source_validate_name", () => {
	test("accepts mount-safe slugs", () => {
		expect(github_source_validate_name("t3-chat")._yay).toBe("t3-chat");
		expect(github_source_validate_name("repo.v2")._yay).toBe("repo.v2");
		expect(github_source_validate_name("a")._yay).toBe("a");
	});

	test("rejects invalid / reserved names", () => {
		expect(github_source_validate_name("")._nay).toBeTruthy();
		expect(github_source_validate_name("Has-Upper")._nay).toBeTruthy();
		expect(github_source_validate_name("has space")._nay).toBeTruthy();
		expect(github_source_validate_name("-leading")._nay).toBeTruthy();
		expect(github_source_validate_name(".")._nay).toBeTruthy();
		expect(github_source_validate_name("..")._nay).toBeTruthy();
		expect(github_source_validate_name("tmp")._nay).toBeTruthy();
		expect(github_source_validate_name("a".repeat(64))._nay).toBeTruthy();
	});
});

describe("github_source_classify_rel_path", () => {
	test("keeps ordinary source paths", () => {
		expect(github_source_classify_rel_path("README.md")).toEqual({ keep: true });
		expect(github_source_classify_rel_path("src/index.ts")).toEqual({ keep: true });
		expect(github_source_classify_rel_path("a/b/c/file.txt")).toEqual({ keep: true });
	});

	test("rejects traversal / absolute / empty", () => {
		expect(github_source_classify_rel_path("").keep).toBe(false);
		expect(github_source_classify_rel_path("/etc/passwd").keep).toBe(false);
		expect(github_source_classify_rel_path("C:/win").keep).toBe(false);
		expect(github_source_classify_rel_path("../escape").keep).toBe(false);
		expect(github_source_classify_rel_path("a/../b").keep).toBe(false);
	});

	test("excludes dep/build dirs, lockfiles, and binary extensions", () => {
		expect(github_source_classify_rel_path("node_modules/dep/index.js").keep).toBe(false);
		expect(github_source_classify_rel_path("dist/bundle.js").keep).toBe(false);
		expect(github_source_classify_rel_path(".git/config").keep).toBe(false);
		expect(github_source_classify_rel_path("pnpm-lock.yaml").keep).toBe(false);
		expect(github_source_classify_rel_path("assets/logo.png").keep).toBe(false);
		expect(github_source_classify_rel_path("bin/tool.wasm").keep).toBe(false);
	});
});

describe("github_source_is_lfs_pointer", () => {
	test("detects an LFS pointer header", () => {
		expect(
			github_source_is_lfs_pointer("version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n"),
		).toBe(true);
		expect(github_source_is_lfs_pointer("just normal text\n")).toBe(false);
	});
});

// #endregion pure helpers

// #region source management + locks

describe("upsert_github_source", () => {
	test("inserts, then updates by name; rejects invalid name", async () => {
		const t = test_convex();

		const inserted = await t.mutation(internal.github_sources.upsert_github_source, {
			name: MOUNT,
			owner: OWNER,
			repo: REPO,
			ref: REF,
		});
		if (inserted._nay) throw new Error(inserted._nay.message);

		const updated = await t.mutation(internal.github_sources.upsert_github_source, {
			name: MOUNT,
			owner: "someone-else",
			repo: REPO,
			ref: "dev",
		});
		if (updated._nay) throw new Error(updated._nay.message);
		expect(updated._yay.sourceId).toBe(inserted._yay.sourceId);

		const row = await t.run((ctx) => ctx.db.get("github_sources", inserted._yay.sourceId));
		expect(row).toMatchObject({ owner: "someone-else", ref: "dev", status: "idle", lastCommitSha: null });

		const bad = await t.mutation(internal.github_sources.upsert_github_source, {
			name: "BAD NAME",
			owner: OWNER,
			repo: REPO,
			ref: REF,
		});
		expect(bad._nay).toBeTruthy();
	});

	test("rejects owner/repo that could inject into the fetch URL", async () => {
		const t = test_convex();

		const badOwner = await t.mutation(internal.github_sources.upsert_github_source, {
			name: MOUNT,
			owner: "evil/owner",
			repo: REPO,
			ref: REF,
		});
		expect(badOwner._nay?.message).toMatch(/owner/i);

		const traversalRepo = await t.mutation(internal.github_sources.upsert_github_source, {
			name: MOUNT,
			owner: OWNER,
			repo: "..",
			ref: REF,
		});
		expect(traversalRepo._nay?.message).toMatch(/repo/i);

		const slashRepo = await t.mutation(internal.github_sources.upsert_github_source, {
			name: MOUNT,
			owner: OWNER,
			repo: "a/b",
			ref: REF,
		});
		expect(slashRepo._nay?.message).toMatch(/repo/i);
	});
});

describe("acquire_sync_lock", () => {
	test("rejects a second fresh lock and reclaims a stale one", async () => {
		const t = test_convex();
		const inserted = await t.mutation(internal.github_sources.upsert_github_source, {
			name: MOUNT,
			owner: OWNER,
			repo: REPO,
			ref: REF,
		});
		if (inserted._nay) throw new Error(inserted._nay.message);
		const sourceId = inserted._yay.sourceId;

		const first = await t.mutation(internal.github_sources.acquire_sync_lock, { sourceId, syncRunId: "tok-1" });
		expect(first._yay).toBeTruthy();

		const second = await t.mutation(internal.github_sources.acquire_sync_lock, { sourceId, syncRunId: "tok-2" });
		expect(second._nay).toBeTruthy();

		// Advance past the stale-lock window → the next acquire reclaims it.
		vi.advanceTimersByTime(31 * 60 * 1000);
		const third = await t.mutation(internal.github_sources.acquire_sync_lock, { sourceId, syncRunId: "tok-3" });
		expect(third._yay).toBeTruthy();
		const source = await t.run((ctx) => ctx.db.get("github_sources", sourceId));
		expect(source?.syncRunId).toBe("tok-3");
	});
});

// #endregion source management + locks

// #region hard-delete barrier

describe("delete_mount_content_batch", () => {
	test("removes a mount's reserved-scope content and leaves prefix-overlapping mounts intact", async () => {
		const t = test_convex();
		install_fetch({ commitSha: COMMIT_1, treeSha: TREE_1, zip: build_repo_zip(COMMIT_1, { "README.md": "x" }) });
		const sourceId = await create_running_source(t, { name: MOUNT, syncRunId: "delete-token" });

		// Seed two mounts via the real write path: "t3-chat" and the prefix-overlapping "t3-chat-extra".
		await t.action(internal.files_nodes.create_file_node_internal, {
			path: `/${MOUNT}/README.md`,
			rawText: "hello mount",
		});
		await t.action(internal.files_nodes.create_file_node_internal, {
			path: `/${MOUNT}/src/index.ts`,
			rawText: "export const x = 1;\n",
		});
		await t.action(internal.files_nodes.create_file_node_internal, {
			path: `/${MOUNT}-extra/keep.md`,
			rawText: "do not delete me",
		});

		for (;;) {
			const batch = await t.mutation(internal.github_sources.delete_mount_content_batch, {
				sourceId,
				syncRunId: "delete-token",
			});
			expect(batch.superseded).toBe(false);
			if (batch.done) break;
		}

		expect(await list_mount_file_paths(t, MOUNT)).toEqual([]);
		expect(await list_mount_file_paths(t, `${MOUNT}-extra`)).toEqual([`/${MOUNT}-extra/keep.md`]);

		// No reserved-scope assets remain for the deleted mount; the surviving mount keeps exactly one.
		const remainingAssets = await t.run(async (ctx) => {
			const assets = await ctx.db
				.query("files_r2_assets")
				.withIndex("by_workspace_project", (q) =>
					q.eq("workspaceId", workspaces_GLOBAL_WORKSPACE_ID).eq("projectId", workspaces_GLOBAL_GITHUB_PROJECT_ID),
				)
				.collect();
			return assets.length;
		});
		expect(remainingAssets).toBe(1);
	});

	test("stale sync-run delete is superseded and preserves newer mount content", async () => {
		const t = test_convex();
		install_fetch({ commitSha: COMMIT_1, treeSha: TREE_1, zip: build_repo_zip(COMMIT_1, { "README.md": "x" }) });
		const sourceId = await create_running_source(t, { name: MOUNT, syncRunId: "fresh-token" });

		await t.action(internal.files_nodes.create_file_node_internal, {
			path: `/${MOUNT}/README.md`,
			rawText: "new content\n",
		});

		const batch = await t.mutation(internal.github_sources.delete_mount_content_batch, {
			sourceId,
			syncRunId: "old-token",
		});

		expect(batch).toEqual({ done: true, deletedCount: 0, superseded: true });
		expect(await list_mount_file_paths(t, MOUNT)).toEqual([`/${MOUNT}/README.md`]);
	});

	test("delete batches stay within the requested mutation budget", async () => {
		const t = test_convex();
		install_fetch({ commitSha: COMMIT_1, treeSha: TREE_1, zip: build_repo_zip(COMMIT_1, { "README.md": "x" }) });
		const sourceId = await create_running_source(t, { name: MOUNT, syncRunId: "bounded-token" });

		await t.action(internal.files_nodes.create_file_node_internal, {
			path: `/${MOUNT}/README.md`,
			rawText: "hello mount\n",
		});
		await t.action(internal.files_nodes.create_file_node_internal, {
			path: `/${MOUNT}/src/index.ts`,
			rawText: "export const x = 1;\n",
		});

		let done = false;
		for (let pass = 0; pass < 50 && !done; pass++) {
			const batch = await t.mutation(internal.github_sources.delete_mount_content_batch, {
				sourceId,
				syncRunId: "bounded-token",
				_test_batchSize: 2,
			});
			expect(batch.superseded).toBe(false);
			expect(batch.deletedCount).toBeLessThanOrEqual(2);
			done = batch.done;
		}

		expect(done).toBe(true);
		expect(await list_mount_file_paths(t, MOUNT)).toEqual([]);
	});

	test("stale materialization sync run writes no node or asset", async () => {
		const t = test_convex();
		install_fetch({ commitSha: COMMIT_1, treeSha: TREE_1, zip: build_repo_zip(COMMIT_1, { "README.md": "x" }) });
		const sourceId = await create_running_source(t, { name: MOUNT, syncRunId: "fresh-token" });

		const created = await t.action(internal.files_nodes.create_file_node_internal, {
			path: `/${MOUNT}/stale.ts`,
			rawText: "stale\n",
			sourceId,
			syncRunId: "old-token",
		});

		expect(created._nay?.message).toContain("superseded");
		expect(await list_mount_file_paths(t, MOUNT)).toEqual([]);
		const assetCount = await t.run(async (ctx) => {
			const assets = await ctx.db
				.query("files_r2_assets")
				.withIndex("by_workspace_project", (q) =>
					q.eq("workspaceId", workspaces_GLOBAL_WORKSPACE_ID).eq("projectId", workspaces_GLOBAL_GITHUB_PROJECT_ID),
				)
				.collect();
			return assets.length;
		});
		expect(assetCount).toBe(0);
	});
});

// #endregion hard-delete barrier

// #region full sync pipeline

describe("sync_github_source", () => {
	test("ingests a fresh repo into reserved scope, applying filters and finalizing to idle", async () => {
		const t = test_convex();
		install_fetch({
			commitSha: COMMIT_1,
			treeSha: TREE_1,
			zip: build_repo_zip(COMMIT_1, {
				"README.md": "# Title\nhello world\n",
				"src/index.ts": "export const x = 1;\n",
				"node_modules/dep/index.js": "module.exports = 1;\n",
				"pnpm-lock.yaml": "lockfileVersion: 9\n",
				"assets/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
			}),
		});

		const inserted = await t.mutation(internal.github_sources.upsert_github_source, {
			name: MOUNT,
			owner: OWNER,
			repo: REPO,
			ref: REF,
		});
		if (inserted._nay) throw new Error(inserted._nay.message);
		const sourceId = inserted._yay.sourceId;

		await t.action(internal.github_sources.sync_github_source, { sourceId });
		const settled = await drain_until_settled(t, sourceId);

		expect(settled.status).toBe("idle");
		expect(settled.lastCommitSha).toBe(COMMIT_1);
		expect(settled.lastTreeSha).toBe(TREE_1);
		expect(settled.defaultBranch).toBe("main");
		expect(settled.syncRunId).toBeUndefined();
		expect(settled.pendingCommitSha).toBeUndefined();
		expect(settled.enqueuedCount).toBe(2);
		expect(settled.completedCount).toBe(2);
		expect(settled.failedCount).toBe(0);
		expect(settled.skippedCount).toBe(3);

		const paths = await list_mount_file_paths(t, MOUNT);
		expect(paths.sort()).toEqual([`/${MOUNT}/README.md`, `/${MOUNT}/src/index.ts`]);

		// Content is byte-identical and SYSTEM-authored.
		const readerUserId = await make_reader_user(t);
		const readme = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			workspaceId: workspaces_GLOBAL_WORKSPACE_ID,
			projectId: workspaces_GLOBAL_GITHUB_PROJECT_ID,
			userId: readerUserId,
			path: `/${MOUNT}/README.md`,
			mode: { kind: "full", maxBytes: 1_000_000 },
		});
		expect(readme?.content).toBe("# Title\nhello world\n");

		// Reserved-scope nodes are SYSTEM-authored.
		const readmeNode = await t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_workspace_project_path_archiveOperation", (q) =>
					q
						.eq("workspaceId", workspaces_GLOBAL_WORKSPACE_ID)
						.eq("projectId", workspaces_GLOBAL_GITHUB_PROJECT_ID)
						.eq("path", `/${MOUNT}/README.md`)
						.eq("archiveOperationId", undefined),
				)
				.first(),
		);
		expect(readmeNode).toMatchObject({ createdBy: users_SYSTEM_AUTHOR, updatedBy: users_SYSTEM_AUTHOR });
	});

	test("re-sync at the same commit is a no-op (no archive re-download)", async () => {
		const t = test_convex();
		install_fetch({
			commitSha: COMMIT_1,
			treeSha: TREE_1,
			zip: build_repo_zip(COMMIT_1, { "README.md": "# Title\n" }),
		});

		const inserted = await t.mutation(internal.github_sources.upsert_github_source, {
			name: MOUNT,
			owner: OWNER,
			repo: REPO,
			ref: REF,
		});
		if (inserted._nay) throw new Error(inserted._nay.message);
		const sourceId = inserted._yay.sourceId;

		await t.action(internal.github_sources.sync_github_source, { sourceId });
		await drain_until_settled(t, sourceId);
		expect(count_codeload_fetches(COMMIT_1)).toBe(1);

		await t.action(internal.github_sources.sync_github_source, { sourceId });
		const settled = await drain_until_settled(t, sourceId);
		expect(settled.status).toBe("idle");
		expect(count_codeload_fetches(COMMIT_1)).toBe(1); // still 1 — early return before download
	});

	test("re-sync at a new commit replaces the mount content", async () => {
		const t = test_convex();
		install_fetch({
			commitSha: COMMIT_1,
			treeSha: TREE_1,
			zip: build_repo_zip(COMMIT_1, {
				"README.md": "v1\n",
				"src/old.ts": "export const old = 1;\n",
			}),
		});

		const inserted = await t.mutation(internal.github_sources.upsert_github_source, {
			name: MOUNT,
			owner: OWNER,
			repo: REPO,
			ref: REF,
		});
		if (inserted._nay) throw new Error(inserted._nay.message);
		const sourceId = inserted._yay.sourceId;

		await t.action(internal.github_sources.sync_github_source, { sourceId });
		await drain_until_settled(t, sourceId);
		expect((await list_mount_file_paths(t, MOUNT)).sort()).toEqual([
			`/${MOUNT}/README.md`,
			`/${MOUNT}/src/old.ts`,
		]);

		// New commit: old.ts is gone, new.ts appears, README rewritten.
		install_fetch({
			commitSha: COMMIT_2,
			treeSha: TREE_2,
			zip: build_repo_zip(COMMIT_2, {
				"README.md": "v2\n",
				"src/new.ts": "export const fresh = 2;\n",
			}),
		});

		await t.action(internal.github_sources.sync_github_source, { sourceId });
		const settled = await drain_until_settled(t, sourceId);
		expect(settled.lastCommitSha).toBe(COMMIT_2);
		expect((await list_mount_file_paths(t, MOUNT)).sort()).toEqual([
			`/${MOUNT}/README.md`,
			`/${MOUNT}/src/new.ts`,
		]);

		const readerUserId = await make_reader_user(t);
		const readme = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			workspaceId: workspaces_GLOBAL_WORKSPACE_ID,
			projectId: workspaces_GLOBAL_GITHUB_PROJECT_ID,
			userId: readerUserId,
			path: `/${MOUNT}/README.md`,
			mode: { kind: "full", maxBytes: 1_000_000 },
		});
		expect(readme?.content).toBe("v2\n");
	});

	test("oversize entries are skipped, not ingested", async () => {
		const t = test_convex();
		install_fetch({
			commitSha: COMMIT_1,
			treeSha: TREE_1,
			zip: build_repo_zip(COMMIT_1, {
				"README.md": "ok\n",
				"big.txt": "a".repeat(files_MAX_TEXT_CONTENT_BYTES + 10),
			}),
		});

		const inserted = await t.mutation(internal.github_sources.upsert_github_source, {
			name: MOUNT,
			owner: OWNER,
			repo: REPO,
			ref: REF,
		});
		if (inserted._nay) throw new Error(inserted._nay.message);
		const sourceId = inserted._yay.sourceId;

		await t.action(internal.github_sources.sync_github_source, { sourceId });
		const settled = await drain_until_settled(t, sourceId);

		expect(settled.status).toBe("idle");
		expect((await list_mount_file_paths(t, MOUNT))).toEqual([`/${MOUNT}/README.md`]);
		expect(settled.skippedCount).toBe(1);
	});

	test("many small files trip the completed-entry ZIP buffer cap instead of materializing unbounded memory", async () => {
		const t = test_convex();
		const files: Record<string, string> = {};
		for (let index = 0; index < 400; index++) {
			files[`src/file-${String(index).padStart(3, "0")}.ts`] = `export const value${index} = ${index};\n`;
		}
		install_fetch({
			commitSha: COMMIT_1,
			treeSha: TREE_1,
			zip: build_repo_zip(COMMIT_1, files),
		});

		const inserted = await t.mutation(internal.github_sources.upsert_github_source, {
			name: MOUNT,
			owner: OWNER,
			repo: REPO,
			ref: REF,
		});
		if (inserted._nay) throw new Error(inserted._nay.message);
		const sourceId = inserted._yay.sourceId;

		await t.action(internal.github_sources.sync_github_source, { sourceId });
		const settled = await drain_until_settled(t, sourceId);

		expect(settled.status).toBe("error");
		expect(settled.lastError).toContain("Buffered ZIP entries exceed");
		expect(settled.lastCommitSha).toBeNull();
		expect(await list_mount_file_paths(t, MOUNT)).toEqual([]);
	});

	test("aggregate accepted entry bytes trip the ZIP buffer cap before enqueueing", async () => {
		const t = test_convex();
		const files: Record<string, string> = {};
		for (let index = 0; index < 9; index++) {
			files[`src/large-${index}.txt`] = "a".repeat(files_MAX_TEXT_CONTENT_BYTES);
		}
		install_fetch({
			commitSha: COMMIT_1,
			treeSha: TREE_1,
			zip: build_repo_zip(COMMIT_1, files),
		});

		const inserted = await t.mutation(internal.github_sources.upsert_github_source, {
			name: MOUNT,
			owner: OWNER,
			repo: REPO,
			ref: REF,
		});
		if (inserted._nay) throw new Error(inserted._nay.message);
		const sourceId = inserted._yay.sourceId;

		await t.action(internal.github_sources.sync_github_source, { sourceId });
		const settled = await drain_until_settled(t, sourceId);

		expect(settled.status).toBe("error");
		expect(settled.lastError).toContain("Buffered ZIP bytes exceed");
		expect(settled.lastCommitSha).toBeNull();
		expect(await list_mount_file_paths(t, MOUNT)).toEqual([]);
	});

	test("a per-file write failure closes the run as error without promoting the commit", async () => {
		const t = test_convex();
		const poison = "POISON: this upload is rejected every attempt\n";
		install_fetch({
			commitSha: COMMIT_1,
			treeSha: TREE_1,
			zip: build_repo_zip(COMMIT_1, {
				"README.md": "ok\n",
				"src/good.ts": "export const ok = 1;\n",
				"src/bad.ts": poison,
			}),
			failUploadForBody: poison,
		});

		const inserted = await t.mutation(internal.github_sources.upsert_github_source, {
			name: MOUNT,
			owner: OWNER,
			repo: REPO,
			ref: REF,
		});
		if (inserted._nay) throw new Error(inserted._nay.message);
		const sourceId = inserted._yay.sourceId;

		await t.action(internal.github_sources.sync_github_source, { sourceId });
		const settled = await drain_until_settled(t, sourceId);

		// The barrier closes on completed + failed >= enqueued, so one file that exhausts all retries can no
		// longer stall the run. The failed run is not published as a stable mount and does not advance the SHA.
		expect(settled.status).toBe("error");
		expect(settled.lastError).toContain("failed to materialize 1 file");
		expect(settled.lastCommitSha).toBeNull();
		expect(settled.enqueuedCount).toBe(3);
		expect(settled.completedCount).toBe(2);
		expect(settled.failedCount).toBe(1);
		expect(settled.syncRunId).toBeUndefined();
		expect(settled.pendingCommitSha).toBeUndefined();

		// The poison file leaves no node (its asset is cleaned up); the healthy files are present.
		expect((await list_mount_file_paths(t, MOUNT)).sort()).toEqual([
			`/${MOUNT}/README.md`,
			`/${MOUNT}/src/good.ts`,
		]);
	});

	test("a metadata fetch failure marks the source errored without advancing the commit", async () => {
		const t = test_convex();
		install_fetch({
			commitSha: COMMIT_1,
			treeSha: TREE_1,
			zip: build_repo_zip(COMMIT_1, { "README.md": "x\n" }),
			failBranchMetadata: true,
		});

		const inserted = await t.mutation(internal.github_sources.upsert_github_source, {
			name: MOUNT,
			owner: OWNER,
			repo: REPO,
			ref: REF,
		});
		if (inserted._nay) throw new Error(inserted._nay.message);
		const sourceId = inserted._yay.sourceId;

		await t.action(internal.github_sources.sync_github_source, { sourceId });
		const settled = await drain_until_settled(t, sourceId);

		expect(settled.status).toBe("error");
		expect(settled.lastError).toMatch(/branch metadata/i);
		expect(settled.lastCommitSha).toBeNull();
		expect(settled.syncRunId).toBeUndefined();
		expect(settled.pendingCommitSha).toBeUndefined();
		expect(count_codeload_fetches(COMMIT_1)).toBe(0); // never reached the download
	});
});

// #endregion full sync pipeline
