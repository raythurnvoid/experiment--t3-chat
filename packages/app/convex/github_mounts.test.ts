import { R2 } from "@convex-dev/r2";
import { zipSync, strToU8 } from "fflate";
import { afterEach, beforeEach, describe, expect, test as baseTest, vi } from "vitest";
import { internal } from "./_generated/api.js";
import { test_convex } from "./setup.test.ts";
import {
	github_mount_validate_name,
	github_mount_classify_rel_path,
	github_mount_is_lfs_pointer,
} from "./github_mounts.ts";
import { github_codeload_url } from "../server/github.ts";
import { files_MAX_TEXT_CONTENT_BYTES } from "../shared/files.ts";
import { organizations_GLOBAL_ORGANIZATION_ID, organizations_GLOBAL_GITHUB_WORKSPACE_ID } from "../shared/organizations.ts";
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
const COMMIT_3 = "e".repeat(40);

/** Mirrors GITHUB_SYNC_GC_DELAY_MS: terminal sync mutations schedule the orphan-root sweep this far out. */
const GC_DELAY_MS = 5 * 60 * 1000;

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
	/** Return 404 for the head-commit metadata endpoint (simulates a hard metadata failure). */
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
		if (urlString === `https://api.github.com/repos/${OWNER}/${REPO}/commits/${REF}`) {
			if (plan.failBranchMetadata) {
				return new Response("Not Found", { status: 404 });
			}
			return new Response(JSON.stringify({ sha: plan.commitSha, commit: { tree: { sha: plan.treeSha } } }), {
				status: 200,
			});
		}
		if (urlString === github_codeload_url({ owner: OWNER, repo: REPO, commitSha: plan.commitSha })) {
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
	const target = github_codeload_url({ owner: OWNER, repo: REPO, commitSha });
	return fetchMock.mock.calls.filter((call) => call[0] === target).length;
}

/** Drive the registered workpool until the mount reaches a terminal (idle/error) status. */
async function drain_until_settled(t: ReturnType<typeof test_convex>, mountId: Id<"github_mounts">) {
	for (let i = 0; i < 400; i++) {
		const mount = await t.run((ctx) => ctx.db.get("github_mounts", mountId));
		if (mount && mount.status !== "running") {
			return mount;
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

async function create_running_mount(
	t: ReturnType<typeof test_convex>,
	args: { name: string; syncRunId: string; pendingCommitSha?: string },
) {
	const inserted = await t.mutation(internal.github_mounts.upsert_mount, {
		name: args.name,
		owner: OWNER,
		repo: REPO,
		ref: REF,
	});
	if (inserted._nay) throw new Error(inserted._nay.message);
	await t.run((ctx) =>
		ctx.db.patch("github_mounts", inserted._yay.mountId, {
			status: "running",
			syncRunId: args.syncRunId,
			lockedAt: Date.now(),
			pendingCommitSha: args.pendingCommitSha,
		}),
	);
	return inserted._yay.mountId;
}

/** Every file path under the mount, across ALL commit roots (used for GC assertions). */
async function list_mount_file_paths(t: ReturnType<typeof test_convex>, mount: string): Promise<string[]> {
	return await t.run(async (ctx) => {
		const nodes = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_treePath", (q) =>
				q
					.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
					.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID)
					.gte("treePath", `/${mount}/`)
					.lt("treePath", `/${mount}/￿`),
			)
			.collect();
		return nodes.filter((node) => node.kind === "file").map((node) => node.path);
	});
}

/** File paths inside one commit root only. */
async function list_root_file_paths(
	t: ReturnType<typeof test_convex>,
	mount: string,
	commitSha: string,
): Promise<string[]> {
	const paths = await list_mount_file_paths(t, mount);
	return paths.filter((path) => path.startsWith(`/${mount}/${commitSha}/`));
}

/** Advance past the GC delay and drive the (self-rescheduling) orphan-root sweep to quiescence. */
async function drain_gc_sweep(t: ReturnType<typeof test_convex>) {
	vi.advanceTimersByTime(GC_DELAY_MS + 1000);
	for (let i = 0; i < 50; i++) {
		await t.finishInProgressScheduledFunctions();
		vi.advanceTimersByTime(1000);
	}
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

describe("github_mount_validate_name", () => {
	test("accepts mount-safe slugs", () => {
		expect(github_mount_validate_name("t3-chat")._yay).toBe("t3-chat");
		expect(github_mount_validate_name("repo.v2")._yay).toBe("repo.v2");
		expect(github_mount_validate_name("a")._yay).toBe("a");
	});

	test("rejects invalid / reserved names", () => {
		expect(github_mount_validate_name("")._nay).toBeTruthy();
		expect(github_mount_validate_name("Has-Upper")._nay).toBeTruthy();
		expect(github_mount_validate_name("has space")._nay).toBeTruthy();
		expect(github_mount_validate_name("-leading")._nay).toBeTruthy();
		expect(github_mount_validate_name(".")._nay).toBeTruthy();
		expect(github_mount_validate_name("..")._nay).toBeTruthy();
		expect(github_mount_validate_name("tmp")._nay).toBeTruthy();
		expect(github_mount_validate_name("a".repeat(64))._nay).toBeTruthy();
	});
});

describe("github_mount_classify_rel_path", () => {
	test("keeps ordinary mount paths", () => {
		expect(github_mount_classify_rel_path("README.md")).toEqual({ keep: true });
		expect(github_mount_classify_rel_path("src/index.ts")).toEqual({ keep: true });
		expect(github_mount_classify_rel_path("a/b/c/file.txt")).toEqual({ keep: true });
	});

	test("rejects traversal / absolute / empty", () => {
		expect(github_mount_classify_rel_path("").keep).toBe(false);
		expect(github_mount_classify_rel_path("/etc/passwd").keep).toBe(false);
		expect(github_mount_classify_rel_path("C:/win").keep).toBe(false);
		expect(github_mount_classify_rel_path("../escape").keep).toBe(false);
		expect(github_mount_classify_rel_path("a/../b").keep).toBe(false);
	});

	test("excludes dep/build dirs, lockfiles, and binary extensions", () => {
		expect(github_mount_classify_rel_path("node_modules/dep/index.js").keep).toBe(false);
		expect(github_mount_classify_rel_path("dist/bundle.js").keep).toBe(false);
		expect(github_mount_classify_rel_path(".git/config").keep).toBe(false);
		expect(github_mount_classify_rel_path("pnpm-lock.yaml").keep).toBe(false);
		expect(github_mount_classify_rel_path("assets/logo.png").keep).toBe(false);
		expect(github_mount_classify_rel_path("bin/tool.wasm").keep).toBe(false);
	});
});

describe("github_mount_is_lfs_pointer", () => {
	test("detects an LFS pointer header", () => {
		expect(
			github_mount_is_lfs_pointer("version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n"),
		).toBe(true);
		expect(github_mount_is_lfs_pointer("just normal text\n")).toBe(false);
	});
});

// #endregion pure helpers

// #region mount management + locks

describe("upsert_mount", () => {
	test("inserts, then updates by name; rejects invalid name", async () => {
		const t = test_convex();

		const inserted = await t.mutation(internal.github_mounts.upsert_mount, {
			name: MOUNT,
			owner: OWNER,
			repo: REPO,
			ref: REF,
		});
		if (inserted._nay) throw new Error(inserted._nay.message);

		const updated = await t.mutation(internal.github_mounts.upsert_mount, {
			name: MOUNT,
			owner: "someone-else",
			repo: REPO,
			ref: "dev",
		});
		if (updated._nay) throw new Error(updated._nay.message);
		expect(updated._yay.mountId).toBe(inserted._yay.mountId);

		const row = await t.run((ctx) => ctx.db.get("github_mounts", inserted._yay.mountId));
		expect(row).toMatchObject({ owner: "someone-else", ref: "dev", status: "idle", lastCommitSha: null });

		const bad = await t.mutation(internal.github_mounts.upsert_mount, {
			name: "BAD NAME",
			owner: OWNER,
			repo: REPO,
			ref: REF,
		});
		expect(bad._nay).toBeTruthy();
	});

	test("rejects owner/repo that could inject into the fetch URL", async () => {
		const t = test_convex();

		const badOwner = await t.mutation(internal.github_mounts.upsert_mount, {
			name: MOUNT,
			owner: "evil/owner",
			repo: REPO,
			ref: REF,
		});
		expect(badOwner._nay?.message).toMatch(/owner/i);

		const traversalRepo = await t.mutation(internal.github_mounts.upsert_mount, {
			name: MOUNT,
			owner: OWNER,
			repo: "..",
			ref: REF,
		});
		expect(traversalRepo._nay?.message).toMatch(/repo/i);

		const slashRepo = await t.mutation(internal.github_mounts.upsert_mount, {
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
		const inserted = await t.mutation(internal.github_mounts.upsert_mount, {
			name: MOUNT,
			owner: OWNER,
			repo: REPO,
			ref: REF,
		});
		if (inserted._nay) throw new Error(inserted._nay.message);
		const mountId = inserted._yay.mountId;

		const first = await t.mutation(internal.github_mounts.acquire_sync_lock, { mountId, syncRunId: "tok-1" });
		expect(first._yay).toBeTruthy();

		const second = await t.mutation(internal.github_mounts.acquire_sync_lock, { mountId, syncRunId: "tok-2" });
		expect(second._nay).toBeTruthy();

		// Advance past the stale-lock window → the next acquire reclaims it.
		vi.advanceTimersByTime(31 * 60 * 1000);
		const third = await t.mutation(internal.github_mounts.acquire_sync_lock, { mountId, syncRunId: "tok-3" });
		expect(third._yay).toBeTruthy();
		const mount = await t.run((ctx) => ctx.db.get("github_mounts", mountId));
		expect(mount?.syncRunId).toBe("tok-3");
	});
});

describe("list_mounts", () => {
	test("returns raw docs in name order with the visibility pointer intact", async () => {
		const t = test_convex();

		// zeta-mount finished a sync; alpha-mount is mid-first-sync (running, pending staged, last null).
		const finished = await t.mutation(internal.github_mounts.upsert_mount, {
			name: "zeta-mount",
			owner: OWNER,
			repo: REPO,
			ref: REF,
		});
		if (finished._nay) throw new Error(finished._nay.message);
		await t.run((ctx) =>
			ctx.db.patch("github_mounts", finished._yay.mountId, { lastCommitSha: COMMIT_1, lastTreeSha: TREE_1 }),
		);
		await create_running_mount(t, { name: "alpha-mount", syncRunId: "first-sync", pendingCommitSha: COMMIT_2 });

		// Name order comes from the by_name index; callers mount only mounts with lastCommitSha set,
		// so the in-progress first sync stays invisible to bash while still being listed here.
		const mounts = await t.query(internal.github_mounts.list_mounts, {});
		expect(
			mounts.map((mount) => ({ name: mount.name, lastCommitSha: mount.lastCommitSha })),
		).toEqual([
			{ name: "alpha-mount", lastCommitSha: null },
			{ name: "zeta-mount", lastCommitSha: COMMIT_1 },
		]);
	});
});

// #endregion mount management + locks

// #region pending-root barrier + gc

describe("clear_pending_root_batch", () => {
	test("clears the pending root and leaves the active root and prefix-overlapping mounts intact", async () => {
		const t = test_convex();
		install_fetch({ commitSha: COMMIT_2, treeSha: TREE_2, zip: build_repo_zip(COMMIT_2, { "README.md": "x" }) });
		const mountId = await create_running_mount(t, {
			name: MOUNT,
			syncRunId: "clear-token",
			pendingCommitSha: COMMIT_2,
		});

		// Seed an active root, a partial pending root, and the prefix-overlapping "t3-chat-extra".
		await t.action(internal.files_nodes.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: `/${MOUNT}/${COMMIT_1}/README.md`,
			rawText: "active content",
		});
		await t.action(internal.files_nodes.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: `/${MOUNT}/${COMMIT_2}/partial.ts`,
			rawText: "export const partial = 1;\n",
		});
		await t.action(internal.files_nodes.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: `/${MOUNT}/${COMMIT_2}/src/index.ts`,
			rawText: "export const x = 1;\n",
		});
		await t.action(internal.files_nodes.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: `/${MOUNT}-extra/keep.md`,
			rawText: "do not delete me",
		});

		for (;;) {
			const batch = await t.mutation(internal.github_mounts.clear_pending_root_batch, {
				mountId,
				syncRunId: "clear-token",
			});
			expect(batch.superseded).toBe(false);
			if (batch.done) break;
		}

		expect(await list_root_file_paths(t, MOUNT, COMMIT_2)).toEqual([]);
		expect(await list_root_file_paths(t, MOUNT, COMMIT_1)).toEqual([`/${MOUNT}/${COMMIT_1}/README.md`]);
		expect(await list_mount_file_paths(t, `${MOUNT}-extra`)).toEqual([`/${MOUNT}-extra/keep.md`]);

		// Only the surviving files' assets remain (active-root README + the extra mount's file).
		const remainingAssets = await t.run(async (ctx) => {
			const assets = await ctx.db
				.query("files_r2_assets")
				.withIndex("by_organization_workspace", (q) =>
					q.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID).eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID),
				)
				.collect();
			return assets.length;
		});
		expect(remainingAssets).toBe(2);
	});

	test("stale sync-run clear is superseded and preserves the pending root", async () => {
		const t = test_convex();
		install_fetch({ commitSha: COMMIT_1, treeSha: TREE_1, zip: build_repo_zip(COMMIT_1, { "README.md": "x" }) });
		const mountId = await create_running_mount(t, {
			name: MOUNT,
			syncRunId: "fresh-token",
			pendingCommitSha: COMMIT_1,
		});

		await t.action(internal.files_nodes.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: `/${MOUNT}/${COMMIT_1}/README.md`,
			rawText: "new content\n",
		});

		const batch = await t.mutation(internal.github_mounts.clear_pending_root_batch, {
			mountId,
			syncRunId: "old-token",
		});

		expect(batch).toEqual({ done: true, deletedCount: 0, superseded: true });
		expect(await list_mount_file_paths(t, MOUNT)).toEqual([`/${MOUNT}/${COMMIT_1}/README.md`]);
	});

	test("clear batches stay within the requested mutation budget", async () => {
		const t = test_convex();
		install_fetch({ commitSha: COMMIT_1, treeSha: TREE_1, zip: build_repo_zip(COMMIT_1, { "README.md": "x" }) });
		const mountId = await create_running_mount(t, {
			name: MOUNT,
			syncRunId: "bounded-token",
			pendingCommitSha: COMMIT_1,
		});

		await t.action(internal.files_nodes.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: `/${MOUNT}/${COMMIT_1}/README.md`,
			rawText: "hello mount\n",
		});
		await t.action(internal.files_nodes.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: `/${MOUNT}/${COMMIT_1}/src/index.ts`,
			rawText: "export const x = 1;\n",
		});

		let done = false;
		for (let pass = 0; pass < 50 && !done; pass++) {
			const batch = await t.mutation(internal.github_mounts.clear_pending_root_batch, {
				mountId,
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
		const mountId = await create_running_mount(t, {
			name: MOUNT,
			syncRunId: "fresh-token",
			pendingCommitSha: COMMIT_1,
		});

		const created = await t.action(internal.files_nodes.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: `/${MOUNT}/${COMMIT_1}/stale.ts`,
			rawText: "stale\n",
			mountId,
			syncRunId: "old-token",
		});

		expect(created._nay?.message).toContain("superseded");
		expect(await list_mount_file_paths(t, MOUNT)).toEqual([]);
		const assetCount = await t.run(async (ctx) => {
			const assets = await ctx.db
				.query("files_r2_assets")
				.withIndex("by_organization_workspace", (q) =>
					q.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID).eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID),
				)
				.collect();
			return assets.length;
		});
		expect(assetCount).toBe(0);
	});

	test("materialization outside the pending commit root is rejected", async () => {
		const t = test_convex();
		install_fetch({ commitSha: COMMIT_1, treeSha: TREE_1, zip: build_repo_zip(COMMIT_1, { "README.md": "x" }) });
		const mountId = await create_running_mount(t, {
			name: MOUNT,
			syncRunId: "fresh-token",
			pendingCommitSha: COMMIT_1,
		});

		const created = await t.action(internal.files_nodes.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: `/${MOUNT}/README.md`,
			rawText: "not sha-nested\n",
			mountId,
			syncRunId: "fresh-token",
		});

		expect(created._nay?.message).toMatch(/pending sync root/i);
		expect(await list_mount_file_paths(t, MOUNT)).toEqual([]);
	});
});

describe("gc_sweep_mount_roots", () => {
	test("collects orphan roots but keeps the active root and a running sync's pending root", async () => {
		const t = test_convex();
		install_fetch({ commitSha: COMMIT_2, treeSha: TREE_2, zip: build_repo_zip(COMMIT_2, { "README.md": "x" }) });
		const mountId = await create_running_mount(t, {
			name: MOUNT,
			syncRunId: "sweep-token",
			pendingCommitSha: COMMIT_2,
		});
		await t.run((ctx) => ctx.db.patch("github_mounts", mountId, { lastCommitSha: COMMIT_1 }));

		// Active root, in-flight pending root, and an orphan left by an old crashed run.
		await t.action(internal.files_nodes.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: `/${MOUNT}/${COMMIT_1}/README.md`,
			rawText: "active\n",
		});
		await t.action(internal.files_nodes.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: `/${MOUNT}/${COMMIT_2}/README.md`,
			rawText: "pending\n",
		});
		await t.action(internal.files_nodes.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: `/${MOUNT}/${COMMIT_3}/orphan.ts`,
			rawText: "orphan\n",
		});

		for (let pass = 0; pass < 50; pass++) {
			const batch = await t.mutation(internal.github_mounts.gc_sweep_mount_roots, { mountId });
			if (batch.done) break;
		}

		expect(await list_root_file_paths(t, MOUNT, COMMIT_1)).toEqual([`/${MOUNT}/${COMMIT_1}/README.md`]);
		expect(await list_root_file_paths(t, MOUNT, COMMIT_2)).toEqual([`/${MOUNT}/${COMMIT_2}/README.md`]);
		expect(await list_root_file_paths(t, MOUNT, COMMIT_3)).toEqual([]);

		// Once the run is no longer running, its pending root loses protection and gets collected too.
		await t.run((ctx) => ctx.db.patch("github_mounts", mountId, { status: "idle" }));
		for (let pass = 0; pass < 50; pass++) {
			const batch = await t.mutation(internal.github_mounts.gc_sweep_mount_roots, { mountId });
			if (batch.done) break;
		}
		expect(await list_root_file_paths(t, MOUNT, COMMIT_1)).toEqual([`/${MOUNT}/${COMMIT_1}/README.md`]);
		expect(await list_root_file_paths(t, MOUNT, COMMIT_2)).toEqual([]);
	});
});

// #endregion pending-root barrier + gc

// #region full sync pipeline

describe("sync_mount", () => {
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

		const inserted = await t.mutation(internal.github_mounts.upsert_mount, {
			name: MOUNT,
			owner: OWNER,
			repo: REPO,
			ref: REF,
		});
		if (inserted._nay) throw new Error(inserted._nay.message);
		const mountId = inserted._yay.mountId;

		await t.action(internal.github_mounts.sync_mount, { mountId });
		const settled = await drain_until_settled(t, mountId);

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

		// Content lives in the immutable commit root `/<name>/<commitSha>/...`.
		const paths = await list_mount_file_paths(t, MOUNT);
		expect(paths.sort()).toEqual([`/${MOUNT}/${COMMIT_1}/README.md`, `/${MOUNT}/${COMMIT_1}/src/index.ts`]);

		// Content is byte-identical and SYSTEM-authored.
		const readerUserId = await make_reader_user(t);
		const readme = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			userId: readerUserId,
			path: `/${MOUNT}/${COMMIT_1}/README.md`,
			mode: { kind: "full", maxBytes: 1_000_000 },
		});
		expect(readme?.content).toBe("# Title\nhello world\n");

		// Reserved-scope nodes are SYSTEM-authored.
		const readmeNode = await t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
						.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID)
						.eq("path", `/${MOUNT}/${COMMIT_1}/README.md`)
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

		const inserted = await t.mutation(internal.github_mounts.upsert_mount, {
			name: MOUNT,
			owner: OWNER,
			repo: REPO,
			ref: REF,
		});
		if (inserted._nay) throw new Error(inserted._nay.message);
		const mountId = inserted._yay.mountId;

		await t.action(internal.github_mounts.sync_mount, { mountId });
		await drain_until_settled(t, mountId);
		expect(count_codeload_fetches(COMMIT_1)).toBe(1);

		await t.action(internal.github_mounts.sync_mount, { mountId });
		const settled = await drain_until_settled(t, mountId);
		expect(settled.status).toBe("idle");
		expect(count_codeload_fetches(COMMIT_1)).toBe(1); // still 1 — early return before download
	});

	test("re-sync at a new commit flips the pointer, keeps the old root until the sweep collects it", async () => {
		const t = test_convex();
		install_fetch({
			commitSha: COMMIT_1,
			treeSha: TREE_1,
			zip: build_repo_zip(COMMIT_1, {
				"README.md": "v1\n",
				"src/old.ts": "export const old = 1;\n",
			}),
		});

		const inserted = await t.mutation(internal.github_mounts.upsert_mount, {
			name: MOUNT,
			owner: OWNER,
			repo: REPO,
			ref: REF,
		});
		if (inserted._nay) throw new Error(inserted._nay.message);
		const mountId = inserted._yay.mountId;

		await t.action(internal.github_mounts.sync_mount, { mountId });
		await drain_until_settled(t, mountId);
		expect((await list_mount_file_paths(t, MOUNT)).sort()).toEqual([
			`/${MOUNT}/${COMMIT_1}/README.md`,
			`/${MOUNT}/${COMMIT_1}/src/old.ts`,
		]);

		install_fetch({
			commitSha: COMMIT_2,
			treeSha: TREE_2,
			zip: build_repo_zip(COMMIT_2, {
				"README.md": "v2\n",
				"src/new.ts": "export const fresh = 2;\n",
			}),
		});

		await t.action(internal.github_mounts.sync_mount, { mountId });
		const settled = await drain_until_settled(t, mountId);
		expect(settled.lastCommitSha).toBe(COMMIT_2);

		// Immediately after the flip the old root still exists (readers pinned to it keep working);
		// the delayed sweep has not fired yet.
		expect((await list_root_file_paths(t, MOUNT, COMMIT_1)).sort()).toEqual([
			`/${MOUNT}/${COMMIT_1}/README.md`,
			`/${MOUNT}/${COMMIT_1}/src/old.ts`,
		]);
		expect((await list_root_file_paths(t, MOUNT, COMMIT_2)).sort()).toEqual([
			`/${MOUNT}/${COMMIT_2}/README.md`,
			`/${MOUNT}/${COMMIT_2}/src/new.ts`,
		]);

		const readerUserId = await make_reader_user(t);
		const readme = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			userId: readerUserId,
			path: `/${MOUNT}/${COMMIT_2}/README.md`,
			mode: { kind: "full", maxBytes: 1_000_000 },
		});
		expect(readme?.content).toBe("v2\n");

		// After the GC delay the sweep collects the orphaned old root; the active root survives.
		await drain_gc_sweep(t);
		expect(await list_root_file_paths(t, MOUNT, COMMIT_1)).toEqual([]);
		expect((await list_root_file_paths(t, MOUNT, COMMIT_2)).sort()).toEqual([
			`/${MOUNT}/${COMMIT_2}/README.md`,
			`/${MOUNT}/${COMMIT_2}/src/new.ts`,
		]);
	});

	test("a crashed run's partial root at the same commit is cleared and re-ingested", async () => {
		const t = test_convex();
		install_fetch({
			commitSha: COMMIT_1,
			treeSha: TREE_1,
			zip: build_repo_zip(COMMIT_1, {
				"README.md": "recovered\n",
				"src/index.ts": "export const x = 1;\n",
			}),
		});

		// Simulate a crashed run: lock held, pending sha staged, partial root already materialized.
		const mountId = await create_running_mount(t, {
			name: MOUNT,
			syncRunId: "crashed-token",
			pendingCommitSha: COMMIT_1,
		});
		await t.action(internal.files_nodes.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: `/${MOUNT}/${COMMIT_1}/README.md`,
			rawText: "partial leftover\n",
		});

		// The stale lock blocks a retry until the reclaim window passes.
		vi.advanceTimersByTime(31 * 60 * 1000);
		await t.action(internal.github_mounts.sync_mount, { mountId });
		const settled = await drain_until_settled(t, mountId);

		expect(settled.status).toBe("idle");
		expect(settled.lastCommitSha).toBe(COMMIT_1);
		expect((await list_mount_file_paths(t, MOUNT)).sort()).toEqual([
			`/${MOUNT}/${COMMIT_1}/README.md`,
			`/${MOUNT}/${COMMIT_1}/src/index.ts`,
		]);

		const readerUserId = await make_reader_user(t);
		const readme = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			userId: readerUserId,
			path: `/${MOUNT}/${COMMIT_1}/README.md`,
			mode: { kind: "full", maxBytes: 1_000_000 },
		});
		expect(readme?.content).toBe("recovered\n");
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

		const inserted = await t.mutation(internal.github_mounts.upsert_mount, {
			name: MOUNT,
			owner: OWNER,
			repo: REPO,
			ref: REF,
		});
		if (inserted._nay) throw new Error(inserted._nay.message);
		const mountId = inserted._yay.mountId;

		await t.action(internal.github_mounts.sync_mount, { mountId });
		const settled = await drain_until_settled(t, mountId);

		expect(settled.status).toBe("idle");
		expect(await list_mount_file_paths(t, MOUNT)).toEqual([`/${MOUNT}/${COMMIT_1}/README.md`]);
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

		const inserted = await t.mutation(internal.github_mounts.upsert_mount, {
			name: MOUNT,
			owner: OWNER,
			repo: REPO,
			ref: REF,
		});
		if (inserted._nay) throw new Error(inserted._nay.message);
		const mountId = inserted._yay.mountId;

		await t.action(internal.github_mounts.sync_mount, { mountId });
		const settled = await drain_until_settled(t, mountId);

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

		const inserted = await t.mutation(internal.github_mounts.upsert_mount, {
			name: MOUNT,
			owner: OWNER,
			repo: REPO,
			ref: REF,
		});
		if (inserted._nay) throw new Error(inserted._nay.message);
		const mountId = inserted._yay.mountId;

		await t.action(internal.github_mounts.sync_mount, { mountId });
		const settled = await drain_until_settled(t, mountId);

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

		const inserted = await t.mutation(internal.github_mounts.upsert_mount, {
			name: MOUNT,
			owner: OWNER,
			repo: REPO,
			ref: REF,
		});
		if (inserted._nay) throw new Error(inserted._nay.message);
		const mountId = inserted._yay.mountId;

		await t.action(internal.github_mounts.sync_mount, { mountId });
		const settled = await drain_until_settled(t, mountId);

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

		// The poison file leaves no node (its asset is cleaned up); the healthy files sit in the
		// never-published pending root until the sweep collects it.
		expect((await list_mount_file_paths(t, MOUNT)).sort()).toEqual([
			`/${MOUNT}/${COMMIT_1}/README.md`,
			`/${MOUNT}/${COMMIT_1}/src/good.ts`,
		]);

		// The failed run's partial root is an orphan (lastCommitSha never advanced) — swept after the delay.
		await drain_gc_sweep(t);
		expect(await list_mount_file_paths(t, MOUNT)).toEqual([]);
	});

	test("a metadata fetch failure marks the mount errored without advancing the commit", async () => {
		const t = test_convex();
		install_fetch({
			commitSha: COMMIT_1,
			treeSha: TREE_1,
			zip: build_repo_zip(COMMIT_1, { "README.md": "x\n" }),
			failBranchMetadata: true,
		});

		const inserted = await t.mutation(internal.github_mounts.upsert_mount, {
			name: MOUNT,
			owner: OWNER,
			repo: REPO,
			ref: REF,
		});
		if (inserted._nay) throw new Error(inserted._nay.message);
		const mountId = inserted._yay.mountId;

		await t.action(internal.github_mounts.sync_mount, { mountId });
		const settled = await drain_until_settled(t, mountId);

		expect(settled.status).toBe("error");
		expect(settled.lastError).toMatch(/repo metadata/i);
		expect(settled.lastCommitSha).toBeNull();
		expect(settled.syncRunId).toBeUndefined();
		expect(settled.pendingCommitSha).toBeUndefined();
		expect(count_codeload_fetches(COMMIT_1)).toBe(0); // never reached the download
	});
});

// #endregion full sync pipeline
