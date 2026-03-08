import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
	pages_yjs_compute_diff_update_from_yjs_doc,
	pages_yjs_doc_clone,
	pages_yjs_doc_get_markdown,
	pages_yjs_doc_update_from_markdown,
	pages_yjs_rebase_branch_with_local_markdown,
	pages_yjs_reconcile_branch_with_local_markdown,
} from "./pages.ts";
import { Doc as YDoc } from "yjs";

describe("pages_yjs_reconcile_branch_with_local_markdown", () => {
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
		const yjsDocFromMarkdown = pages_yjs_doc_update_from_markdown({
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
		const markdown = pages_yjs_doc_get_markdown({ yjsDoc });
		if (markdown._nay) {
			throw new Error("Expected Yjs doc markdown extraction to succeed", {
				cause: markdown._nay,
			});
		}

		return markdown._yay;
	};

	test("adopts the incoming remote branch when local and remote markdown already match", () => {
		const previousRemoteYjsDoc = createYjsDocFromMarkdown("# Base");
		const nextRemoteYjsDoc = pages_yjs_doc_clone({ yjsDoc: previousRemoteYjsDoc });
		const matchingMarkdown = "# Base\n\nAlready synced";

		const nextRemoteProjectionResult = pages_yjs_doc_update_from_markdown({
			mut_yjsDoc: nextRemoteYjsDoc,
			markdown: matchingMarkdown,
		});
		if (nextRemoteProjectionResult._nay) {
			throw new Error("Expected next remote Yjs doc projection to succeed", {
				cause: nextRemoteProjectionResult._nay,
			});
		}

		const reconcileResult = pages_yjs_reconcile_branch_with_local_markdown({
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
			pages_yjs_compute_diff_update_from_yjs_doc({
				yjsDoc: reconcileResult._yay.mergedYjsDoc,
				yjsBeforeDoc: nextRemoteYjsDoc,
			}),
		).toBeNull();
	});

	test("preserves a local unsynced draft while rebasing onto a newer remote branch", () => {
		const previousRemoteYjsDoc = createYjsDocFromMarkdown("# Base");
		const nextRemoteYjsDoc = pages_yjs_doc_clone({ yjsDoc: previousRemoteYjsDoc });
		const localMarkdown = "# Base\n\nLocal draft";
		const remoteMarkdown = "# Base\n\nRemote change";

		const nextRemoteProjectionResult = pages_yjs_doc_update_from_markdown({
			mut_yjsDoc: nextRemoteYjsDoc,
			markdown: remoteMarkdown,
		});
		if (nextRemoteProjectionResult._nay) {
			throw new Error("Expected next remote Yjs doc projection to succeed", {
				cause: nextRemoteProjectionResult._nay,
			});
		}

		const reconcileResult = pages_yjs_reconcile_branch_with_local_markdown({
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

describe("pages_yjs_rebase_branch_with_local_markdown", () => {
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
		const yjsDocFromMarkdown = pages_yjs_doc_update_from_markdown({
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
		const markdown = pages_yjs_doc_get_markdown({ yjsDoc });
		if (markdown._nay) {
			throw new Error("Expected Yjs doc markdown extraction to succeed", {
				cause: markdown._nay,
			});
		}

		return markdown._yay;
	};

	test("rebases an existing branch onto the latest base while preserving local branch edits", () => {
		const previousBaseYjsDoc = createYjsDocFromMarkdown("# Base");
		const previousBranchYjsDoc = pages_yjs_doc_clone({ yjsDoc: previousBaseYjsDoc });
		const previousBranchProjectionResult = pages_yjs_doc_update_from_markdown({
			mut_yjsDoc: previousBranchYjsDoc,
			markdown: "# Base\n\nPending edit",
		});
		if (previousBranchProjectionResult._nay) {
			throw new Error("Expected previous branch Yjs doc projection to succeed", {
				cause: previousBranchProjectionResult._nay,
			});
		}

		const nextBaseYjsDoc = pages_yjs_doc_clone({ yjsDoc: previousBaseYjsDoc });
		const nextBaseProjectionResult = pages_yjs_doc_update_from_markdown({
			mut_yjsDoc: nextBaseYjsDoc,
			markdown: "# Base\n\nRemote drift",
		});
		if (nextBaseProjectionResult._nay) {
			throw new Error("Expected next base Yjs doc projection to succeed", {
				cause: nextBaseProjectionResult._nay,
			});
		}
		const localMarkdown = "# Base\n\nPending edit";

		const rebaseResult = pages_yjs_rebase_branch_with_local_markdown({
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
		expect(rebaseResult._yay.rebasedBranchMarkdown).toContain("Pending edit");
	});

	test("adopts the latest base when the branch has no local edits to preserve", () => {
		const previousBaseYjsDoc = createYjsDocFromMarkdown("# Base");
		const previousBranchYjsDoc = createYjsDocFromMarkdown("# Base");
		const nextBaseYjsDoc = createYjsDocFromMarkdown("# Base\n\nRemote drift");

		const rebaseResult = pages_yjs_rebase_branch_with_local_markdown({
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
		const previousBranchYjsDoc = createYjsDocFromMarkdown("# Base\n\nPending edit");
		const nextBaseYjsDoc = createYjsDocFromMarkdown("# Base\n\nRemote drift");

		const rebaseResult = pages_yjs_rebase_branch_with_local_markdown({
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
			pages_yjs_compute_diff_update_from_yjs_doc({
				yjsDoc: rebaseResult._yay.rebasedBranchYjsDoc,
				yjsBeforeDoc: nextBaseYjsDoc,
			}),
		).toBeNull();
	});
});
