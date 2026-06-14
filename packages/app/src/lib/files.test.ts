import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
	files_clear_node_path_cached_validation_messages,
	files_get_node_path_cached_validation_message,
	files_get_node_path_validation,
	files_get_node_path_validation_cache_key,
	files_get_node_path_validation_message,
	files_normalize_upload_file_name,
	files_ROOT_ID,
	files_set_node_path_cached_validation_message,
	files_yjs_compute_diff_update_from_yjs_doc,
	files_yjs_doc_clone,
	files_yjs_doc_get_markdown,
	files_yjs_doc_update_from_markdown,
	files_yjs_rebase_branch_with_local_markdown,
	files_yjs_reconcile_branch_with_local_markdown,
	type files_TreeItem,
} from "./files.ts";
import type { Id } from "../../convex/_generated/dataModel";
import { Doc as YDoc } from "yjs";

const createTreeItem = (args: {
	id: string;
	parentId: string;
	kind: files_TreeItem["kind"];
	name: string;
	path?: string;
	archiveOperationId?: string;
}) => {
	const id = args.id as Id<"files_nodes">;
	const path = args.path ?? `/${args.name}`;
	const lowercaseExtension =
		args.kind === "file" && args.name.includes(".") ? args.name.slice(args.name.lastIndexOf(".") + 1).toLowerCase() : null;
	return {
		_id: id,
		_creationTime: 0,
		workspaceId: "workspace",
		projectId: "project",
		parentId: args.parentId === files_ROOT_ID ? files_ROOT_ID : (args.parentId as Id<"files_nodes">),
		path,
		treePath: args.kind === "folder" && path !== "/" ? `${path}/` : path,
		pathDepth: path === "/" ? 0 : path.split("/").filter(Boolean).length,
		name: args.name,
		kind: args.kind,
		lowercaseExtension,
		archiveOperationId: args.archiveOperationId,
		createdBy: "test-user" as Id<"users">,
		updatedAt: 0,
		updatedBy: "test-user" as Id<"users">,
	} satisfies files_TreeItem;
};

describe("files_normalize_upload_file_name", () => {
	test("preserves the uploaded file extension", () => {
		expect(files_normalize_upload_file_name("Annual Report 2026.PDF")).toBe("annual-report-2026.pdf");
	});

	test("uses the last path segment and preserves non-adjacent dots", () => {
		expect(files_normalize_upload_file_name("C:\\Uploads\\Résumé..Final.PDF")).toBe("resume.final.pdf");
	});
});

describe("files_get_node_path_validation_message", () => {
	const treeItemsList = [
		createTreeItem({ id: "folder-docs", parentId: "root", kind: "folder", name: "docs" }),
		createTreeItem({ id: "file-readme", parentId: "folder-docs", kind: "file", name: "README.md" }),
		createTreeItem({ id: "file-guide", parentId: "folder-docs", kind: "file", name: "guide.md" }),
		createTreeItem({
			id: "archived-file",
			parentId: "folder-docs",
			kind: "file",
			name: "archived.md",
			archiveOperationId: "archive-operation",
		}),
	] satisfies files_TreeItem[];

	test("returns a duplicate folder message for an existing leaf folder", () => {
		expect(
			files_get_node_path_validation_message({
				fileNodesList: treeItemsList,
				parentId: files_ROOT_ID,
				kind: "folder",
				nameOrPathValidate: "docs",
			}),
		).toBe("This folder already exists.");
	});

	test("returns a duplicate file message for an existing nested file after normalization", () => {
		expect(
			files_get_node_path_validation_message({
				fileNodesList: treeItemsList,
				parentId: files_ROOT_ID,
				kind: "file",
				nameOrPathValidate: "docs/readme",
			}),
		).toBe("This file already exists.");
	});

	test("ignores the item currently being renamed", () => {
		expect(
			files_get_node_path_validation_message({
				fileNodesList: treeItemsList,
				nodeIdToIgnore: "file-readme" as Id<"files_nodes">,
				parentId: "folder-docs" as Id<"files_nodes">,
				kind: "file",
				nameOrPathValidate: "readme.md",
			}),
		).toBeNull();
	});

	test("still checks sibling conflicts when renaming an existing item", () => {
		expect(
			files_get_node_path_validation_message({
				fileNodesList: treeItemsList,
				nodeIdToIgnore: "file-readme" as Id<"files_nodes">,
				parentId: "folder-docs" as Id<"files_nodes">,
				kind: "file",
				nameOrPathValidate: "guide.md",
			}),
		).toBe("This file already exists.");
	});

	test("allows paths whose missing folders would be created", () => {
		expect(
			files_get_node_path_validation_message({
				fileNodesList: treeItemsList,
				parentId: files_ROOT_ID,
				kind: "file",
				nameOrPathValidate: "new-folder/readme",
			}),
		).toBeNull();
	});

	test("ignores archived nodes when checking for duplicates", () => {
		expect(
			files_get_node_path_validation_message({
				fileNodesList: treeItemsList,
				parentId: "folder-docs" as Id<"files_nodes">,
				kind: "file",
				nameOrPathValidate: "archived.md",
			}),
		).toBeNull();
	});

	test("returns normalized name errors before checking tree conflicts", () => {
		expect(
			files_get_node_path_validation_message({
				fileNodesList: treeItemsList,
				parentId: "folder-docs" as Id<"files_nodes">,
				kind: "file",
				nameOrPathValidate: "bad.m d",
			}),
		).toBe("Invalid file name");
	});
});

describe("files node path validation cache", () => {
	test("returns a normalized cache key", () => {
		expect(
			files_get_node_path_validation_cache_key({
				scopeId: "scope-key",
				parentId: files_ROOT_ID,
				kind: "file",
				nameOrPath: "Docs/readme",
			}),
		).toBe("node_path_validation_cache_key::scope-key::root::file::docs/readme.md");
	});

	test("reuses duplicate failures for the same normalized path", () => {
		const cacheKey = files_get_node_path_validation_cache_key({
			scopeId: "scope-cache-duplicate",
			parentId: files_ROOT_ID,
			kind: "file",
			nameOrPath: "Docs/readme",
		});
		if (!cacheKey) {
			throw new Error("Expected cache key");
		}

		files_set_node_path_cached_validation_message({
			cacheKey,
			message: "This file already exists.",
		});

		expect(
			files_get_node_path_cached_validation_message({
				cacheKey,
			}),
		).toBe("This file already exists.");
	});

	test("returns null when the path cannot be normalized", () => {
		const cacheKey = files_get_node_path_validation_cache_key({
			scopeId: "scope-cache-invalid",
			parentId: files_ROOT_ID,
			kind: "file",
			nameOrPath: "bad.m d",
		});
		expect(cacheKey).toBeNull();
	});

	test("keeps cache entries scoped by parent and tenant scope", () => {
		const cacheKey = files_get_node_path_validation_cache_key({
			scopeId: "scope-cache-a",
			parentId: files_ROOT_ID,
			kind: "folder",
			nameOrPath: "docs",
		});
		if (!cacheKey) {
			throw new Error("Expected cache key");
		}

		files_set_node_path_cached_validation_message({
			cacheKey,
			message: "This folder already exists.",
		});

		const otherScopeCacheKey = files_get_node_path_validation_cache_key({
			scopeId: "scope-cache-b",
			parentId: files_ROOT_ID,
			kind: "folder",
			nameOrPath: "docs",
		});
		const otherParentCacheKey = files_get_node_path_validation_cache_key({
			scopeId: "scope-cache-a",
			parentId: "other-parent" as Id<"files_nodes">,
			kind: "folder",
			nameOrPath: "docs",
		});
		if (!otherScopeCacheKey || !otherParentCacheKey) {
			throw new Error("Expected scoped cache keys");
		}

		expect(
			files_get_node_path_cached_validation_message({
				cacheKey: otherScopeCacheKey,
			}),
		).toBeNull();
		expect(
			files_get_node_path_cached_validation_message({
				cacheKey: otherParentCacheKey,
			}),
		).toBeNull();
	});

	test("caches messages through the combined validation helper", () => {
		const validationArgs = {
			scopeId: "scope-cache-helper",
			fileNodesList: [] satisfies files_TreeItem[],
			parentId: files_ROOT_ID,
			kind: "file" as const,
			nameOrPath: "docs/readme",
		} satisfies Parameters<typeof files_get_node_path_validation>[0];
		const validation = files_get_node_path_validation(validationArgs);

		expect(validation.validationMessage).toBeNull();

		validation.cacheValidationMessage("This file already exists.");

		expect(files_get_node_path_validation(validationArgs).validationMessage).toBe("This file already exists.");
	});

	test("keeps create and rename cache entries separate for the same path", () => {
		const treeItemsList = [
			createTreeItem({ id: "folder-docs", parentId: "root", kind: "folder", name: "docs" }),
			createTreeItem({ id: "file-readme", parentId: "folder-docs", kind: "file", name: "readme.md" }),
		] satisfies files_TreeItem[];

		const createValidation = files_get_node_path_validation({
			scopeId: "scope-cache-create-rename",
			fileNodesList: treeItemsList,
			parentId: "folder-docs" as Id<"files_nodes">,
			kind: "file",
			nameOrPath: "readme.md",
		});
		expect(createValidation.validationMessage).toBe("This file already exists.");

		createValidation.cacheValidationMessage();

		const renameValidation = files_get_node_path_validation({
			scopeId: "scope-cache-create-rename",
			fileNodesList: treeItemsList,
			nodeIdToIgnore: "file-readme" as Id<"files_nodes">,
			parentId: "folder-docs" as Id<"files_nodes">,
			kind: "file",
			nameOrPath: "readme.md",
		});

		expect(renameValidation.validationCacheKey).not.toBe(createValidation.validationCacheKey);
		expect(renameValidation.validationMessage).toBeNull();
	});

	test("clears cached validation messages", () => {
		const cacheKey = files_get_node_path_validation_cache_key({
			scopeId: "scope-cache-clear",
			parentId: files_ROOT_ID,
			kind: "folder",
			nameOrPath: "docs",
		});
		if (!cacheKey) {
			throw new Error("Expected cache key");
		}

		files_set_node_path_cached_validation_message({
			cacheKey,
			message: "This folder already exists.",
		});

		files_clear_node_path_cached_validation_messages();

		expect(files_get_node_path_cached_validation_message({ cacheKey })).toBeNull();
	});
});

describe("files_yjs_reconcile_branch_with_local_markdown", () => {
	beforeEach(() => {
		const domParser = globalThis.window?.DOMParser;
		if (!domParser) {
			vi.stubGlobal("window", undefined);
			return;
		}

		try {
			new domParser();
		} catch {
			vi.stubGlobal("window", undefined);
		}
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const createYjsDocFromMarkdown = (markdown: string) => {
		const yjsDoc = new YDoc();
		const yjsDocFromMarkdown = files_yjs_doc_update_from_markdown({
			mut_yjsDoc: yjsDoc,
			markdown,
		});
		if (yjsDocFromMarkdown._nay) {
			throw new Error("Expected Yjs doc markdown projection to succeed", {
				cause: yjsDocFromMarkdown._nay,
			});
		}

		return yjsDoc;
	};

	const readMarkdown = (yjsDoc: YDoc) => {
		const markdown = files_yjs_doc_get_markdown({ yjsDoc });
		if (markdown._nay) {
			throw new Error("Expected Yjs doc markdown extraction to succeed", {
				cause: markdown._nay,
			});
		}

		return markdown._yay;
	};

	test("adopts the incoming remote branch when local and remote markdown already match", () => {
		const previousRemoteYjsDoc = createYjsDocFromMarkdown("# Base");
		const nextRemoteYjsDoc = files_yjs_doc_clone({ yjsDoc: previousRemoteYjsDoc });
		const matchingMarkdown = "# Base\n\nAlready synced";

		const nextRemoteProjectionResult = files_yjs_doc_update_from_markdown({
			mut_yjsDoc: nextRemoteYjsDoc,
			markdown: matchingMarkdown,
		});
		if (nextRemoteProjectionResult._nay) {
			throw new Error("Expected next remote Yjs doc projection to succeed", {
				cause: nextRemoteProjectionResult._nay,
			});
		}

		const reconcileResult = files_yjs_reconcile_branch_with_local_markdown({
			previousRemoteYjsDoc,
			nextRemoteYjsDoc,
			localMarkdown: matchingMarkdown,
		});
		if (reconcileResult._nay) {
			throw new Error("Expected Yjs branch reconcile to succeed", {
				cause: reconcileResult._nay,
			});
		}

		expect(reconcileResult._yay.mergedMarkdown).toBe(matchingMarkdown);
		expect(
			files_yjs_compute_diff_update_from_yjs_doc({
				yjsDoc: reconcileResult._yay.mergedYjsDoc,
				yjsBeforeDoc: nextRemoteYjsDoc,
			}),
		).toBeNull();
	});

	test("preserves a local unsynced draft while rebasing onto a newer remote branch", () => {
		const previousRemoteYjsDoc = createYjsDocFromMarkdown("# Base");
		const nextRemoteYjsDoc = files_yjs_doc_clone({ yjsDoc: previousRemoteYjsDoc });
		const localMarkdown = "# Base\n\nLocal draft";
		const remoteMarkdown = "# Base\n\nRemote change";

		const nextRemoteProjectionResult = files_yjs_doc_update_from_markdown({
			mut_yjsDoc: nextRemoteYjsDoc,
			markdown: remoteMarkdown,
		});
		if (nextRemoteProjectionResult._nay) {
			throw new Error("Expected next remote Yjs doc projection to succeed", {
				cause: nextRemoteProjectionResult._nay,
			});
		}

		const reconcileResult = files_yjs_reconcile_branch_with_local_markdown({
			previousRemoteYjsDoc,
			nextRemoteYjsDoc,
			localMarkdown,
		});
		if (reconcileResult._nay) {
			throw new Error("Expected Yjs branch reconcile to succeed", {
				cause: reconcileResult._nay,
			});
		}

		const mergedMarkdown = reconcileResult._yay.mergedMarkdown;
		expect(mergedMarkdown).toContain("Local draft");
		expect(mergedMarkdown).toContain("Remote change");
		expect(mergedMarkdown).not.toBe(readMarkdown(nextRemoteYjsDoc));
	});
});

describe("files_yjs_rebase_branch_with_local_markdown", () => {
	beforeEach(() => {
		const domParser = globalThis.window?.DOMParser;
		if (!domParser) {
			vi.stubGlobal("window", undefined);
			return;
		}

		try {
			new domParser();
		} catch {
			vi.stubGlobal("window", undefined);
		}
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const createYjsDocFromMarkdown = (markdown: string) => {
		const yjsDoc = new YDoc();
		const yjsDocFromMarkdown = files_yjs_doc_update_from_markdown({
			mut_yjsDoc: yjsDoc,
			markdown,
		});
		if (yjsDocFromMarkdown._nay) {
			throw new Error("Expected Yjs doc markdown projection to succeed", {
				cause: yjsDocFromMarkdown._nay,
			});
		}

		return yjsDoc;
	};

	const readMarkdown = (yjsDoc: YDoc) => {
		const markdown = files_yjs_doc_get_markdown({ yjsDoc });
		if (markdown._nay) {
			throw new Error("Expected Yjs doc markdown extraction to succeed", {
				cause: markdown._nay,
			});
		}

		return markdown._yay;
	};

	test("rebases an existing branch onto the latest base while preserving local branch edits", () => {
		const previousBaseYjsDoc = createYjsDocFromMarkdown("# Base");
		const previousBranchYjsDoc = files_yjs_doc_clone({ yjsDoc: previousBaseYjsDoc });
		const previousBranchProjectionResult = files_yjs_doc_update_from_markdown({
			mut_yjsDoc: previousBranchYjsDoc,
			markdown: "# Base\n\nPending update",
		});
		if (previousBranchProjectionResult._nay) {
			throw new Error("Expected previous branch Yjs doc projection to succeed", {
				cause: previousBranchProjectionResult._nay,
			});
		}

		const nextBaseYjsDoc = files_yjs_doc_clone({ yjsDoc: previousBaseYjsDoc });
		const nextBaseProjectionResult = files_yjs_doc_update_from_markdown({
			mut_yjsDoc: nextBaseYjsDoc,
			markdown: "# Base\n\nRemote drift",
		});
		if (nextBaseProjectionResult._nay) {
			throw new Error("Expected next base Yjs doc projection to succeed", {
				cause: nextBaseProjectionResult._nay,
			});
		}
		const localMarkdown = "# Base\n\nPending update";

		const rebaseResult = files_yjs_rebase_branch_with_local_markdown({
			previousBaseYjsDoc,
			nextBaseYjsDoc,
			previousBranchYjsDoc,
			localMarkdown,
		});
		if (rebaseResult._nay) {
			throw new Error("Expected Yjs branch rebase to succeed", {
				cause: rebaseResult._nay,
			});
		}

		expect(rebaseResult._yay.rebasedBranchMarkdown).toContain("Remote drift");
		expect(rebaseResult._yay.rebasedBranchMarkdown).toContain("Pending update");
	});

	test("adopts the latest base when the branch has no local edits to preserve", () => {
		const previousBaseYjsDoc = createYjsDocFromMarkdown("# Base");
		const previousBranchYjsDoc = createYjsDocFromMarkdown("# Base");
		const nextBaseYjsDoc = createYjsDocFromMarkdown("# Base\n\nRemote drift");

		const rebaseResult = files_yjs_rebase_branch_with_local_markdown({
			previousBaseYjsDoc,
			nextBaseYjsDoc,
			previousBranchYjsDoc,
			localMarkdown: "# Base",
		});
		if (rebaseResult._nay) {
			throw new Error("Expected Yjs branch rebase to succeed", {
				cause: rebaseResult._nay,
			});
		}

		expect(rebaseResult._yay.rebasedBranchMarkdown).toBe(readMarkdown(nextBaseYjsDoc));
	});

	test("collapses back to the latest base when the rebased branch matches it", () => {
		const previousBaseYjsDoc = createYjsDocFromMarkdown("# Base");
		const previousBranchYjsDoc = createYjsDocFromMarkdown("# Base\n\nPending update");
		const nextBaseYjsDoc = createYjsDocFromMarkdown("# Base\n\nRemote drift");

		const rebaseResult = files_yjs_rebase_branch_with_local_markdown({
			previousBaseYjsDoc,
			nextBaseYjsDoc,
			previousBranchYjsDoc,
			localMarkdown: readMarkdown(nextBaseYjsDoc),
		});
		if (rebaseResult._nay) {
			throw new Error("Expected Yjs branch rebase to succeed", {
				cause: rebaseResult._nay,
			});
		}

		expect(rebaseResult._yay.rebasedBranchMarkdown).toBe(readMarkdown(nextBaseYjsDoc));
		expect(
			files_yjs_compute_diff_update_from_yjs_doc({
				yjsDoc: rebaseResult._yay.rebasedBranchYjsDoc,
				yjsBeforeDoc: nextBaseYjsDoc,
			}),
		).toBeNull();
	});
});
