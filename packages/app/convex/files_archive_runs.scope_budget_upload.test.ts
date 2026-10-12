// The upload-urls budget test, split from files_archive_runs.scope_budget.test.ts so the files can run at the
// same time. See the comment at the top of that file.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { fixture, read_node } from "./files_archive_runs.setup.test.ts";
import { test_LIMITS_AT_75_PERCENT } from "./setup.test.ts";
import {
	mock_scope_budget_storage,
	deep_path,
	max_files,
	finish_all_jobs,
	expect_side_docs_follow,
} from "./files_archive_runs.scope_budget.setup.test.ts";

// Scheduled functions never run on their own under fake timers. Each test drives them. R2 is faked.
beforeEach(mock_scope_budget_storage);
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("scope change budgets with 3,000-chunk files at the longest path", () => {
	test("upload-urls replaces 20 files", async () => {
		const f = await fixture({ transactionLimits: test_LIMITS_AT_75_PERCENT });
		// FILES_UPLOAD_URLS_MAX_ITEMS in public_api.ts: the most files one call can replace.
		const paths = Array.from({ length: 20 }, (_, index) => deep_path(String.fromCharCode(97 + index)));
		const nodeIds = await max_files(f, paths);
		await f.t.run((ctx) => ctx.db.patch("users", f.db.userId, { clerkUserId: "clerk-scope-budget-owner" }));
		const key = await f.asOwner.mutation(api.public_api.api_credential_create, {
			membershipId: f.db.membershipId,
			serviceAccountId: null,
			name: "Importer",
			scopes: ["files:write"],
		});
		if (key._nay) throw new Error(key._nay.message);

		const created = await f.t.mutation(internal.public_api.create_file_upload_targets, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			principalRef: { kind: "user_api_key", credentialId: key._yay.credentialId },
			items: paths.map((path) => ({ path, contentType: "text/markdown", size: 3 })),
			skipProcessing: false,
			overwrite: "replace",
		});
		expect(created._nay).toBeUndefined();
		await finish_all_jobs(f);

		for (const nodeId of nodeIds) expect((await read_node(f, nodeId)).archiveOperationId).not.toBeNull();
		await expect_side_docs_follow(f, nodeIds);
	}, 300_000);
});
