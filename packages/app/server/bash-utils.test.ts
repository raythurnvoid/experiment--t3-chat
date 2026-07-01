import { describe, expect, test, vi } from "vitest";
import type { Id } from "../convex/_generated/dataModel";
import type { ActionCtx } from "../convex/_generated/server";
import { files_MOUNT_ROOT } from "../shared/files.ts";
import { organizations_GLOBAL_GITHUB_WORKSPACE_ID, organizations_GLOBAL_ORGANIZATION_ID } from "../shared/organizations.ts";
import {
	bash_resolve_db_files_shell_path,
	bash_read_only_mount_error,
	bash_DbFilesFs,
	type bash_DbFilesRoots,
} from "./bash-utils.ts";

const currentWorkspacePath = "/home/cloud-usr/w/personal/home";
const MOUNT_NAME = "t3-chat";

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
	};
	const appFs = new bash_DbFilesFs({ ctx, ctxData, currentWorkspacePath, allowDbFilesMkdir: false });
	const externalMountsDbFilesFs = new bash_DbFilesFs({
		ctx,
		ctxData: {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			organizationName: "GLOBAL",
			workspaceName: "GITHUB",
			userId: ctxData.userId,
		},
		currentWorkspacePath: files_MOUNT_ROOT,
		allowDbFilesMkdir: false,
	});
	return {
		app: {
			currentWorkspacePath,
			fs: appFs,
		},
		externalMounts: {
			currentWorkspacePath: files_MOUNT_ROOT,
			fs: externalMountsDbFilesFs,
		},
	};
}

describe("bash_resolve_db_files_shell_path", () => {
	test("classifies the synthetic mounts root", () => {
		const dbFilesRoots = create_db_files_roots();
		for (const path of [files_MOUNT_ROOT, "/.mounts/", "/.mounts/."]) {
			const target = bash_resolve_db_files_shell_path(path, dbFilesRoots);
			expect(target.kind).toBe("external_mounts_root");
			expect(target.dbFilesPath).toBe("/");
			expect(target.basePath).toBe(files_MOUNT_ROOT);
			expect(target.fs).toBe(dbFilesRoots.externalMounts.fs);
		}
	});

	test("classifies an external mount path and strips the /.mounts prefix to the stored /<name>/<rel> path", () => {
		const dbFilesRoots = create_db_files_roots();

		const dir = bash_resolve_db_files_shell_path(`/.mounts/${MOUNT_NAME}`, dbFilesRoots);
		expect(dir.kind).toBe("external_mount");
		expect(dir.dbFilesPath).toBe(`/${MOUNT_NAME}`);
		expect(dir.fs).toBe(dbFilesRoots.externalMounts.fs);

		const file = bash_resolve_db_files_shell_path(`/.mounts/${MOUNT_NAME}/src/index.ts`, dbFilesRoots);
		expect(file.kind).toBe("external_mount");
		expect(file.dbFilesPath).toBe(`/${MOUNT_NAME}/src/index.ts`);
	});

	test("classifies any external-mount-looking path by stripping the /.mounts prefix", () => {
		const dbFilesRoots = create_db_files_roots();
		for (const path of ["/.mounts/nope", "/.mounts/nope/README.md"]) {
			const target = bash_resolve_db_files_shell_path(path, dbFilesRoots);
			expect(target.kind).toBe("external_mount");
			expect(target.dbFilesPath).toBe(path.replace("/.mounts", ""));
			expect(target.fs).toBe(dbFilesRoots.externalMounts.fs);
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
		expect(stillMount.dbFilesPath).toBe(`/${MOUNT_NAME}/README.md`);

		// `/.mounts/../tmp` normalizes to `/tmp`, which is outside db files trees, never app.
		const escaped = bash_resolve_db_files_shell_path("/.mounts/../tmp/x", dbFilesRoots);
		expect(escaped.kind).toBe("outside_db_files");
		expect(escaped.fs).toBe(dbFilesRoots.app.fs);
	});

	test("renderShellPath round-trips a stored path back to the shell path the user sees", () => {
		const dbFilesRoots = create_db_files_roots();

		const mount = bash_resolve_db_files_shell_path(`/.mounts/${MOUNT_NAME}/README.md`, dbFilesRoots);
		expect(mount.renderShellPath(`/${MOUNT_NAME}/README.md`)).toBe(`/.mounts/${MOUNT_NAME}/README.md`);

		const app = bash_resolve_db_files_shell_path(`${currentWorkspacePath}/notes.md`, dbFilesRoots);
		expect(app.renderShellPath("/notes.md")).toBe(`${currentWorkspacePath}/notes.md`);
	});
});

describe("bash_read_only_mount_error", () => {
	test("names the command, the normalized path, and the read-only mount root", () => {
		const message = bash_read_only_mount_error("touch", "/.mounts/t3-chat/../t3-chat/new.txt");
		expect(message).toContain("touch:");
		expect(message).toContain("/.mounts/t3-chat/new.txt");
		expect(message).toContain("read-only mount");
	});
});
