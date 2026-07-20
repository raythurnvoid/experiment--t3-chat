import { describe, expect, test, vi } from "vitest";
import type { Id } from "../convex/_generated/dataModel";
import type { ActionCtx } from "../convex/_generated/server";
import {
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	organizations_GLOBAL_ORGANIZATION_ID,
	organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
} from "../shared/organizations.ts";
import {
	bash_EXTERNAL_MOUNTS_ROOT,
	bash_PLUGINS_MOUNT_ROOT,
	bash_external_mounts_fan_out_db_files_path,
	bash_resolve_db_files_shell_path,
	bash_read_only_mount_error,
	bash_DbFilesFs,
	type bash_DbFilesRoots,
} from "./bash-utils.ts";

const currentWorkspacePath = "/home/cloud-usr/w/personal/home";
const MOUNT_NAME = "t3-chat";
const MOUNT_COMMIT_SHA = "a".repeat(40);
const PLUGIN_NAME = "media";
const PLUGIN_VERSION_ID = "plugins_versions_1" as Id<"plugins_versions">;

// The resolver is pure w.r.t. Convex, so these filesystem objects only need to
// exist; their query methods are never invoked here.
function create_db_files_roots(): bash_DbFilesRoots {
	const ctx = {
		runQuery: vi.fn(),
		runMutation: vi.fn(),
		runAction: vi.fn(),
	} as unknown as ActionCtx;
	const ctxData = {
		organizationId: "organization_1" as Id<"organizations">,
		workspaceId: "workspace_1" as Id<"organizations_workspaces">,
		organizationName: "personal",
		workspaceName: "home",
		userId: "user_1" as Id<"users">,
		threadId: "thread_1" as Id<"ai_chat_threads">,
	};
	const appFs = new bash_DbFilesFs({ ctx, ctxData, currentWorkspacePath, allowDbFilesMkdir: false });
	const mountFs = new bash_DbFilesFs({
		ctx,
		ctxData: {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			organizationName: "GLOBAL",
			workspaceName: "GITHUB",
			userId: ctxData.userId,
			threadId: null,
		},
		currentWorkspacePath: `${bash_EXTERNAL_MOUNTS_ROOT}/${MOUNT_NAME}`,
		allowDbFilesMkdir: false,
		dbFilesPathPrefix: `/${MOUNT_NAME}/${MOUNT_COMMIT_SHA}`,
		readOnlySource: "codebase",
	});
	const pluginFs = new bash_DbFilesFs({
		ctx,
		ctxData: {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
			organizationName: "GLOBAL",
			workspaceName: "PLUGINS",
			userId: ctxData.userId,
			threadId: null,
		},
		currentWorkspacePath: `${bash_PLUGINS_MOUNT_ROOT}/${PLUGIN_NAME}`,
		allowDbFilesMkdir: false,
		dbFilesPathPrefix: `/${PLUGIN_VERSION_ID}`,
		readOnlySource: "plugins",
	});
	return {
		app: {
			currentWorkspacePath,
			fs: appFs,
		},
		externalMounts: {
			currentWorkspacePath: bash_EXTERNAL_MOUNTS_ROOT,
			mounts: new Map([[MOUNT_NAME, { name: MOUNT_NAME, commitSha: MOUNT_COMMIT_SHA, fs: mountFs }]]),
		},
		plugins: {
			currentWorkspacePath: bash_PLUGINS_MOUNT_ROOT,
			mounts: new Map([
				[PLUGIN_NAME, { pluginName: PLUGIN_NAME, pluginVersionId: PLUGIN_VERSION_ID, fs: pluginFs }],
			]),
		},
	};
}

describe("bash_resolve_db_files_shell_path", () => {
	test("classifies the synthetic mounts root without a stored tree", () => {
		const dbFilesRoots = create_db_files_roots();
		for (const path of [bash_EXTERNAL_MOUNTS_ROOT, "/.mounts/", "/.mounts/."]) {
			const target = bash_resolve_db_files_shell_path(path, dbFilesRoots);
			expect(target.kind).toBe("external_mounts_root");
			expect(target.dbFilesPath).toBeNull();
			expect(target.basePath).toBe(bash_EXTERNAL_MOUNTS_ROOT);
		}
	});

	test("classifies a synced mount path to its commit-keyed stored tree", () => {
		const dbFilesRoots = create_db_files_roots();
		const mountFs = dbFilesRoots.externalMounts.mounts.get(MOUNT_NAME)?.fs;

		const dir = bash_resolve_db_files_shell_path(`/.mounts/${MOUNT_NAME}`, dbFilesRoots);
		expect(dir.kind).toBe("external_mount");
		expect(dir.dbFilesPath).toBe(`/${MOUNT_NAME}/${MOUNT_COMMIT_SHA}`);
		expect(dir.fs).toBe(mountFs);
		expect(dir.basePath).toBe(`${bash_EXTERNAL_MOUNTS_ROOT}/${MOUNT_NAME}`);

		const file = bash_resolve_db_files_shell_path(`/.mounts/${MOUNT_NAME}/src/index.ts`, dbFilesRoots);
		expect(file.kind).toBe("external_mount");
		expect(file.dbFilesPath).toBe(`/${MOUNT_NAME}/${MOUNT_COMMIT_SHA}/src/index.ts`);
	});

	test("resolves unknown mount names as plain non-db paths (no existence leak)", () => {
		const dbFilesRoots = create_db_files_roots();
		for (const path of ["/.mounts/nope", "/.mounts/nope/README.md"]) {
			const target = bash_resolve_db_files_shell_path(path, dbFilesRoots);
			expect(target.kind).toBe("outside_db_files");
			expect(target.dbFilesPath).toBeNull();
			expect(target.fs).toBe(dbFilesRoots.app.fs);
		}
	});

	test("classifies app paths and resolves the app-db-files path", () => {
		const dbFilesRoots = create_db_files_roots();

		const root = bash_resolve_db_files_shell_path(currentWorkspacePath, dbFilesRoots);
		expect(root.kind).toBe("app");
		expect(root.dbFilesPath).toBe("/");
		expect(root.fs).toBe(dbFilesRoots.app.fs);

		const file = bash_resolve_db_files_shell_path(`${currentWorkspacePath}/notes/todo.md`, dbFilesRoots);
		expect(file.kind).toBe("app");
		expect(file.dbFilesPath).toBe("/notes/todo.md");
		expect(file.basePath).toBe(currentWorkspacePath);
	});

	test("classifies paths outside db files trees", () => {
		const dbFilesRoots = create_db_files_roots();
		for (const path of ["/tmp/scratch", "/dev/null", "/etc/passwd"]) {
			const target = bash_resolve_db_files_shell_path(path, dbFilesRoots);
			expect(target.kind).toBe("outside_db_files");
			expect(target.dbFilesPath).toBeNull();
			expect(target.fs).toBe(dbFilesRoots.app.fs);
		}
	});

	test("normalizes `..` before classifying: in-mount traversal stays external_mount, escaping traversal leaves db files trees", () => {
		const dbFilesRoots = create_db_files_roots();

		const stillMount = bash_resolve_db_files_shell_path(`/.mounts/${MOUNT_NAME}/src/../README.md`, dbFilesRoots);
		expect(stillMount.kind).toBe("external_mount");
		expect(stillMount.dbFilesPath).toBe(`/${MOUNT_NAME}/${MOUNT_COMMIT_SHA}/README.md`);

		// `/.mounts/../tmp` normalizes to `/tmp`, which is outside db files trees, never app.
		const escaped = bash_resolve_db_files_shell_path("/.mounts/../tmp/x", dbFilesRoots);
		expect(escaped.kind).toBe("outside_db_files");
		expect(escaped.fs).toBe(dbFilesRoots.app.fs);
	});

	test("renderShellPath round-trips a stored path back to the shell path the user sees", () => {
		const dbFilesRoots = create_db_files_roots();

		// The commit segment never appears in shell paths.
		const mount = bash_resolve_db_files_shell_path(`/.mounts/${MOUNT_NAME}/README.md`, dbFilesRoots);
		expect(mount.renderShellPath(`/${MOUNT_NAME}/${MOUNT_COMMIT_SHA}/README.md`)).toBe(
			`/.mounts/${MOUNT_NAME}/README.md`,
		);

		const app = bash_resolve_db_files_shell_path(`${currentWorkspacePath}/notes.md`, dbFilesRoots);
		expect(app.renderShellPath("/notes.md")).toBe(`${currentWorkspacePath}/notes.md`);
	});

	test("bash_external_mounts_fan_out_db_files_path strips the commit segment to the fan-out shape", () => {
		const dbFilesRoots = create_db_files_roots();
		const mount = dbFilesRoots.externalMounts.mounts.get(MOUNT_NAME);
		if (!mount) throw new Error("fixture mount missing");

		expect(bash_external_mounts_fan_out_db_files_path(mount, `/${MOUNT_NAME}/${MOUNT_COMMIT_SHA}`)).toBe(
			`/${MOUNT_NAME}`,
		);
		expect(
			bash_external_mounts_fan_out_db_files_path(mount, `/${MOUNT_NAME}/${MOUNT_COMMIT_SHA}/src/index.ts`),
		).toBe(`/${MOUNT_NAME}/src/index.ts`);
	});

	test("classifies the synthetic plugins root without a stored tree", () => {
		const dbFilesRoots = create_db_files_roots();
		for (const path of [bash_PLUGINS_MOUNT_ROOT, "/.plugins/", "/.plugins/."]) {
			const target = bash_resolve_db_files_shell_path(path, dbFilesRoots);
			expect(target.kind).toBe("plugins_root");
			expect(target.dbFilesPath).toBeNull();
			expect(target.basePath).toBe(bash_PLUGINS_MOUNT_ROOT);
		}
	});

	test("classifies an installed plugin path to its version-keyed stored tree", () => {
		const dbFilesRoots = create_db_files_roots();
		const pluginFs = dbFilesRoots.plugins.mounts.get(PLUGIN_NAME)?.fs;

		const dir = bash_resolve_db_files_shell_path(`/.plugins/${PLUGIN_NAME}`, dbFilesRoots);
		expect(dir.kind).toBe("external_mount");
		expect(dir.dbFilesPath).toBe(`/${PLUGIN_VERSION_ID}`);
		expect(dir.fs).toBe(pluginFs);
		expect(dir.basePath).toBe(`${bash_PLUGINS_MOUNT_ROOT}/${PLUGIN_NAME}`);

		const file = bash_resolve_db_files_shell_path(`/.plugins/${PLUGIN_NAME}/dist/index.js`, dbFilesRoots);
		expect(file.kind).toBe("external_mount");
		expect(file.dbFilesPath).toBe(`/${PLUGIN_VERSION_ID}/dist/index.js`);
		expect(file.renderShellPath(`/${PLUGIN_VERSION_ID}/dist/index.js`)).toBe(
			`/.plugins/${PLUGIN_NAME}/dist/index.js`,
		);
	});

	test("resolves not-installed plugin names as plain non-db paths (no existence leak)", () => {
		const dbFilesRoots = create_db_files_roots();
		for (const path of ["/.plugins/nope", "/.plugins/nope/dist/index.js"]) {
			const target = bash_resolve_db_files_shell_path(path, dbFilesRoots);
			expect(target.kind).toBe("outside_db_files");
			expect(target.dbFilesPath).toBeNull();
			expect(target.fs).toBe(dbFilesRoots.app.fs);
		}
	});

	test("normalizes `..` inside a plugin mount before classifying", () => {
		const dbFilesRoots = create_db_files_roots();

		const stillPlugin = bash_resolve_db_files_shell_path(
			`/.plugins/${PLUGIN_NAME}/dist/../README.md`,
			dbFilesRoots,
		);
		expect(stillPlugin.kind).toBe("external_mount");
		expect(stillPlugin.dbFilesPath).toBe(`/${PLUGIN_VERSION_ID}/README.md`);

		// `/.plugins/../tmp` normalizes to `/tmp`, which is outside db files trees.
		const escaped = bash_resolve_db_files_shell_path("/.plugins/../tmp/x", dbFilesRoots);
		expect(escaped.kind).toBe("outside_db_files");
	});
});

describe("bash_read_only_mount_error", () => {
	test("names the command, the normalized path, and the read-only mount root", () => {
		const message = bash_read_only_mount_error("touch", "/.mounts/t3-chat/../t3-chat/new.txt");
		expect(message).toContain("touch:");
		expect(message).toContain("/.mounts/t3-chat/new.txt");
		expect(message).toContain("read-only mount");
	});

	test("names plugin sources for /.plugins paths", () => {
		const message = bash_read_only_mount_error("rm", "/.plugins/media/dist/index.js");
		expect(message).toContain("rm:");
		expect(message).toContain("/.plugins/media/dist/index.js");
		expect(message).toContain("read-only mount of installed plugin sources");
	});
});
