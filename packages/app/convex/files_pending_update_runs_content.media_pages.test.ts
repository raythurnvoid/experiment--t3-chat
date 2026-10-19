// The real review page of 100 items. files_pending_update_runs_content.media_pages_small.test.ts lowers
// it to 10 with `vi.mock` and crosses it with 11 media. This test runs only with test:files:full-size.
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	mock_review_storage,
	save_copy_media_before_document,
} from "./files_pending_update_runs_content.setup.test.ts";

beforeEach(mock_review_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("review job content", () => {
	// The mock database makes these large cases slow.
	test(
		"saves more than 100 Copy media before its document and keeps one unit per output",
		{ tags: ["full-size"], timeout: 10_800_000 },
		async () => {
			// 101 media and the document need 2 selection pages of 100, 5 media
			// validation pages of 25, and 13 plan pages of 8.
			await save_copy_media_before_document(101);
		},
	);
});
