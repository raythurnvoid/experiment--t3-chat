import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { convexActionMock, convexQueryMock } = vi.hoisted(() => ({
	convexActionMock: vi.fn(),
	convexQueryMock: vi.fn(),
}));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: {
		action: (...args: unknown[]) => convexActionMock(...args),
		query: (...args: unknown[]) => convexQueryMock(...args),
	},
	app_convex_api: {
		files_nodes: {
			get_file_last_yjs_sequence: "get_file_last_yjs_sequence",
			yjs_get_incremental_updates: "yjs_get_incremental_updates",
			yjs_prepare_doc_last_snapshot: "yjs_prepare_doc_last_snapshot",
		},
	},
}));

import {
	files_clear_node_path_cached_validation_messages,
	files_fetch_file_yjs_state_and_text,
	files_get_node_path_cached_validation_message,
	files_get_node_path_validation,
	files_get_node_path_validation_cache_key,
	files_get_node_path_validation_message,
	files_monaco_execute_edits_with_read_only_fallback,
	files_normalize_upload_file_name,
	files_resolve_effective_editor_view,
	files_ROOT_ID,
	files_set_node_path_cached_validation_message,
	files_yjs_rebase_branch_with_local_text,
	files_yjs_reconcile_branch_with_local_text,
	type files_TreeItem,
} from "./files.ts";
import { files_yjs_compute_diff_update_from_yjs_doc, files_yjs_doc_clone } from "../../shared/files-yjs.ts";
import { files_yjs_doc_get_text, files_yjs_doc_update_from_text } from "../../shared/files-tiptap.ts";
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
		args.kind === "file" && args.name.includes(".")
			? args.name.slice(args.name.lastIndexOf(".") + 1).toLowerCase()
			: null;
	return {
		_id: id,
		_creationTime: 0,
		organizationId: "organization" as Id<"organizations">,
		workspaceId: "workspace" as Id<"organizations_workspaces">,
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
		readOnlyState: "writable",
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

describe("files_resolve_effective_editor_view", () => {
	test("redirects only the rich view on a plain-text document", () => {
		expect(
			files_resolve_effective_editor_view({
				requestedView: "diff_editor",
				rootKind: "plain_text",
			}),
		).toBe("diff_editor");
		expect(
			files_resolve_effective_editor_view({
				requestedView: "plain_text_editor",
				rootKind: "plain_text",
			}),
		).toBe("plain_text_editor");
		expect(
			files_resolve_effective_editor_view({
				requestedView: "rich_text_editor",
				rootKind: "plain_text",
			}),
		).toBe("plain_text_editor");
		expect(
			files_resolve_effective_editor_view({
				requestedView: "rich_text_editor",
				rootKind: "rich_text",
			}),
		).toBe("rich_text_editor");
	});
});

describe("files_fetch_file_yjs_state_and_text", () => {
	test("waits 250 ms before retrying a mixed collaboration lineage", async () => {
		vi.useFakeTimers();
		try {
			convexActionMock.mockResolvedValue({ yjsLastSequenceId: "snapshot-lineage" });
			convexQueryMock.mockImplementation((functionName: string) =>
				functionName === "yjs_get_incremental_updates"
					? Promise.resolve({ updates: [], yjsLastSequenceId: "updates-lineage" })
					: Promise.resolve({ lastSequence: 0, yjsLastSequenceId: "sequence-lineage" }),
			);

			const readPromise = files_fetch_file_yjs_state_and_text({
				membershipId: "membership" as Id<"organizations_workspaces_users">,
				nodeId: "node" as Id<"files_nodes">,
			});
			const refusal = readPromise.catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(249);

			expect(convexActionMock).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(convexActionMock).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(500);
			expect(await refusal).toEqual(
				expect.objectContaining({ message: "The file collaboration state kept changing while it loaded" }),
			);
			expect(convexActionMock).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
			convexActionMock.mockReset();
			convexQueryMock.mockReset();
		}
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

describe("files_yjs_reconcile_branch_with_local_text", () => {
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
		const yjsDocFromMarkdown = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: yjsDoc,
			text: markdown,
		});
		if (yjsDocFromMarkdown._nay) {
			throw new Error("Expected Yjs doc markdown projection to succeed", {
				cause: yjsDocFromMarkdown._nay,
			});
		}

		return yjsDoc;
	};

	const readMarkdown = (yjsDoc: YDoc) => {
		const markdown = files_yjs_doc_get_text({ yjsDoc, rootKind: "rich_text" });
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
		const matchingMarkdown = "# Base\n\nAlready synced\n";

		const nextRemoteProjectionResult = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: nextRemoteYjsDoc,
			text: matchingMarkdown,
		});
		if (nextRemoteProjectionResult._nay) {
			throw new Error("Expected next remote Yjs doc projection to succeed", {
				cause: nextRemoteProjectionResult._nay,
			});
		}

		const reconcileResult = files_yjs_reconcile_branch_with_local_text({
			previousRemoteYjsDoc,
			nextRemoteYjsDoc,
			rootKind: "rich_text",
			localText: matchingMarkdown,
		});
		if (reconcileResult._nay) {
			throw new Error("Expected Yjs branch reconcile to succeed", {
				cause: reconcileResult._nay,
			});
		}

		expect(reconcileResult._yay.mergedText).toBe(matchingMarkdown);
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

		const nextRemoteProjectionResult = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: nextRemoteYjsDoc,
			text: remoteMarkdown,
		});
		if (nextRemoteProjectionResult._nay) {
			throw new Error("Expected next remote Yjs doc projection to succeed", {
				cause: nextRemoteProjectionResult._nay,
			});
		}

		const reconcileResult = files_yjs_reconcile_branch_with_local_text({
			previousRemoteYjsDoc,
			nextRemoteYjsDoc,
			localText: localMarkdown,
			rootKind: "rich_text",
		});
		if (reconcileResult._nay) {
			throw new Error("Expected Yjs branch reconcile to succeed", {
				cause: reconcileResult._nay,
			});
		}

		const mergedMarkdown = reconcileResult._yay.mergedText;
		expect(mergedMarkdown).toContain("Local draft");
		expect(mergedMarkdown).toContain("Remote change");
		expect(mergedMarkdown).not.toBe(readMarkdown(nextRemoteYjsDoc));
	});

	test("converges on the next remote branch when a discard replaces it with the staged sibling doc", () => {
		// Build the docs the way the backend builds them: base from the live file, staged as a
		// clone of base, and the previous unstaged branch as a clone of base with the draft
		// markdown projected onto it.
		const baseYjsDoc = createYjsDocFromMarkdown("# Welcome\n\nYou can start editing your document here.\n");
		const stagedYjsDoc = files_yjs_doc_clone({ yjsDoc: baseYjsDoc });
		const previousUnstagedYjsDoc = files_yjs_doc_clone({ yjsDoc: baseYjsDoc });
		const draftProjectionResult = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: previousUnstagedYjsDoc,
			text: [
				"FIXCHECK-ALPHA: first pending marker.",
				"",
				"# Welcome",
				"",
				"FIXCHECK-BETA: second pending marker.",
				"",
				"You can start editing your document here.",
				"",
				"FIXCHECK-OMEGA: third pending marker.",
				"",
			].join("\n"),
		});
		if (draftProjectionResult._nay) {
			throw new Error("Expected draft Yjs doc projection to succeed", {
				cause: draftProjectionResult._nay,
			});
		}

		// `discard_file_pending_content` replaces the unstaged branch with a clone of the staged
		// doc. That doc shares the base items but never received the unstaged branch's history.
		const nextUnstagedYjsDoc = files_yjs_doc_clone({ yjsDoc: stagedYjsDoc });

		// The local Monaco pane holds the previous unstaged branch unchanged, so the reconcile
		// must adopt the next remote branch byte-for-byte instead of leaking phantom edits.
		const reconcileResult = files_yjs_reconcile_branch_with_local_text({
			previousRemoteYjsDoc: previousUnstagedYjsDoc,
			nextRemoteYjsDoc: nextUnstagedYjsDoc,
			rootKind: "rich_text",
			localText: readMarkdown(previousUnstagedYjsDoc),
		});
		if (reconcileResult._nay) {
			throw new Error("Expected Yjs branch reconcile to succeed", {
				cause: reconcileResult._nay,
			});
		}

		expect(reconcileResult._yay.mergedText).toBe(readMarkdown(nextUnstagedYjsDoc));
		expect(readMarkdown(reconcileResult._yay.mergedYjsDoc)).toBe(readMarkdown(stagedYjsDoc));
	});

	test("keeps local typing when a discard swaps in the staged sibling branch", () => {
		const baseYjsDoc = createYjsDocFromMarkdown("# Welcome\n\nYou can start editing your document here.\n");
		const stagedYjsDoc = files_yjs_doc_clone({ yjsDoc: baseYjsDoc });
		const previousUnstagedYjsDoc = files_yjs_doc_clone({ yjsDoc: baseYjsDoc });
		const draftProjectionResult = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: previousUnstagedYjsDoc,
			text: "# Welcome\n\nYou can start editing your document here.\n\nDRAFT-BLOCK: pending draft paragraph.\n",
		});
		if (draftProjectionResult._nay) {
			throw new Error("Expected draft Yjs doc projection to succeed", {
				cause: draftProjectionResult._nay,
			});
		}

		// `discard_file_pending_content` replaces the unstaged branch with a clone of the staged
		// doc, which never had the draft's Yjs structs.
		const nextUnstagedYjsDoc = files_yjs_doc_clone({ yjsDoc: stagedYjsDoc });

		// The local pane holds unsaved typing made after the draft text, so its Yjs edits anchor
		// to structs that only exist in the previous branch and the sibling cannot integrate them.
		const localMarkdown = `${readMarkdown(previousUnstagedYjsDoc)}\nLOCAL-TYPED: unsaved edit.\n`;

		const reconcileResult = files_yjs_reconcile_branch_with_local_text({
			previousRemoteYjsDoc: previousUnstagedYjsDoc,
			nextRemoteYjsDoc: nextUnstagedYjsDoc,
			localText: localMarkdown,
			rootKind: "rich_text",
		});
		if (reconcileResult._nay) {
			throw new Error("Expected Yjs branch reconcile to succeed", {
				cause: reconcileResult._nay,
			});
		}

		expect(reconcileResult._yay.mergedText).toContain("LOCAL-TYPED: unsaved edit.");
		expect(readMarkdown(reconcileResult._yay.mergedYjsDoc)).toBe(reconcileResult._yay.mergedText);
	});

	test("merges a new comment mark onto a newer saved version", () => {
		// The non-collaborative comment save uses this helper when somebody else saved between the
		// member's load and their comment: the comment mark is the only local edit, and it must
		// land on the other person's version without losing their sentence.
		const baseMarkdown = "# Notes\n\nThe launch date is final.\n";
		const previousRemoteYjsDoc = createYjsDocFromMarkdown(baseMarkdown);
		const nextRemoteYjsDoc = files_yjs_doc_clone({ yjsDoc: previousRemoteYjsDoc });

		const nextRemoteProjectionResult = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: nextRemoteYjsDoc,
			text: "# Notes\n\nThe launch date is final.\n\nSomeone else added this sentence.\n",
		});
		if (nextRemoteProjectionResult._nay) {
			throw new Error("Expected next remote Yjs doc projection to succeed", {
				cause: nextRemoteProjectionResult._nay,
			});
		}

		const reconcileResult = files_yjs_reconcile_branch_with_local_text({
			previousRemoteYjsDoc,
			nextRemoteYjsDoc,
			localText: '# Notes\n\nThe <span data-type="comment" data-lb-thread-id="t1">launch</span> date is final.\n',
			rootKind: "rich_text",
		});
		if (reconcileResult._nay) {
			throw new Error("Expected Yjs branch reconcile to succeed", {
				cause: reconcileResult._nay,
			});
		}

		const mergedMarkdown = reconcileResult._yay.mergedText;
		expect(mergedMarkdown).toContain("Someone else added this sentence.");
		expect(mergedMarkdown).toContain('<span data-type="comment" data-lb-thread-id="t1">launch</span>');
	});
});

describe("files_yjs_rebase_branch_with_local_text", () => {
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
		const yjsDocFromMarkdown = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: yjsDoc,
			text: markdown,
		});
		if (yjsDocFromMarkdown._nay) {
			throw new Error("Expected Yjs doc markdown projection to succeed", {
				cause: yjsDocFromMarkdown._nay,
			});
		}

		return yjsDoc;
	};

	const readMarkdown = (yjsDoc: YDoc) => {
		const markdown = files_yjs_doc_get_text({ yjsDoc, rootKind: "rich_text" });
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
		const previousBranchProjectionResult = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: previousBranchYjsDoc,
			text: "# Base\n\nPending update",
		});
		if (previousBranchProjectionResult._nay) {
			throw new Error("Expected previous branch Yjs doc projection to succeed", {
				cause: previousBranchProjectionResult._nay,
			});
		}

		const nextBaseYjsDoc = files_yjs_doc_clone({ yjsDoc: previousBaseYjsDoc });
		const nextBaseProjectionResult = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: nextBaseYjsDoc,
			text: "# Base\n\nRemote drift",
		});
		if (nextBaseProjectionResult._nay) {
			throw new Error("Expected next base Yjs doc projection to succeed", {
				cause: nextBaseProjectionResult._nay,
			});
		}
		const localMarkdown = "# Base\n\nPending update";

		const rebaseResult = files_yjs_rebase_branch_with_local_text({
			previousBaseYjsDoc,
			nextBaseYjsDoc,
			previousBranchYjsDoc,
			localText: localMarkdown,
			rootKind: "rich_text",
		});
		if (rebaseResult._nay) {
			throw new Error("Expected Yjs branch rebase to succeed", {
				cause: rebaseResult._nay,
			});
		}

		expect(rebaseResult._yay.rebasedBranchText).toContain("Remote drift");
		expect(rebaseResult._yay.rebasedBranchText).toContain("Pending update");
	});

	test("adopts the latest base when the branch has no local edits to preserve", () => {
		const previousBaseYjsDoc = createYjsDocFromMarkdown("# Base");
		const previousBranchYjsDoc = createYjsDocFromMarkdown("# Base");
		const nextBaseYjsDoc = createYjsDocFromMarkdown("# Base\n\nRemote drift");

		const rebaseResult = files_yjs_rebase_branch_with_local_text({
			previousBaseYjsDoc,
			nextBaseYjsDoc,
			previousBranchYjsDoc,
			rootKind: "rich_text",
			localText: "# Base",
		});
		if (rebaseResult._nay) {
			throw new Error("Expected Yjs branch rebase to succeed", {
				cause: rebaseResult._nay,
			});
		}

		expect(rebaseResult._yay.rebasedBranchText).toBe(readMarkdown(nextBaseYjsDoc));
	});

	test("collapses back to the latest base when the rebased branch matches it", () => {
		const previousBaseYjsDoc = createYjsDocFromMarkdown("# Base");
		const previousBranchYjsDoc = createYjsDocFromMarkdown("# Base\n\nPending update");
		const nextBaseYjsDoc = createYjsDocFromMarkdown("# Base\n\nRemote drift");

		const rebaseResult = files_yjs_rebase_branch_with_local_text({
			previousBaseYjsDoc,
			nextBaseYjsDoc,
			previousBranchYjsDoc,
			rootKind: "rich_text",
			localText: readMarkdown(nextBaseYjsDoc),
		});
		if (rebaseResult._nay) {
			throw new Error("Expected Yjs branch rebase to succeed", {
				cause: rebaseResult._nay,
			});
		}

		expect(rebaseResult._yay.rebasedBranchText).toBe(readMarkdown(nextBaseYjsDoc));
		expect(
			files_yjs_compute_diff_update_from_yjs_doc({
				yjsDoc: rebaseResult._yay.rebasedBranchYjsDoc,
				yjsBeforeDoc: nextBaseYjsDoc,
			}),
		).toBeNull();
	});
});

describe("files_monaco_execute_edits_with_read_only_fallback", () => {
	const edit = { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }, text: "next" };

	test("keeps the editor-level edit when Monaco accepts it", () => {
		const calls: string[] = [];

		files_monaco_execute_edits_with_read_only_fallback({
			editor: {
				pushUndoStop: () => {
					calls.push("editor.pushUndoStop");
					return true;
				},
				executeEdits: () => {
					calls.push("editor.executeEdits");
					return true;
				},
			},
			model: {
				pushStackElement: () => {
					calls.push("model.pushStackElement");
				},
				applyEdits: () => {
					calls.push("model.applyEdits");
					return [];
				},
			},
			edits: [edit],
		});

		expect(calls).toEqual(["editor.pushUndoStop", "editor.executeEdits", "editor.pushUndoStop"]);
	});

	test("applies the edit at the model level when the read-only editor refuses it", () => {
		const calls: string[] = [];
		const appliedEdits: unknown[] = [];

		files_monaco_execute_edits_with_read_only_fallback({
			// A read-only Monaco editor refuses both `executeEdits` and `pushUndoStop`.
			editor: {
				pushUndoStop: () => false,
				executeEdits: () => {
					calls.push("editor.executeEdits");
					return false;
				},
			},
			model: {
				pushStackElement: () => {
					calls.push("model.pushStackElement");
				},
				applyEdits: (operations: unknown) => {
					calls.push("model.applyEdits");
					appliedEdits.push(operations);
					return [];
				},
			},
			edits: [edit],
		});

		// The content lands through exactly one model edit wrapped in undo stack boundaries, so a
		// caller counting programmatic model changes sees exactly one change event.
		expect(calls).toEqual([
			"editor.executeEdits",
			"model.pushStackElement",
			"model.applyEdits",
			"model.pushStackElement",
		]);
		expect(appliedEdits).toEqual([[edit]]);
	});
});
