// A review page holds 10 items here instead of 100, so 11 media cross it. The mock puts this file in the
// isolated "Convex" project. The real size is in files_pending_update_runs_content.media_pages.test.ts.
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	mock_review_storage,
	save_copy_media_before_document,
} from "./files_pending_update_runs_content.setup.test.ts";

vi.mock("../server/files-pending-update-runs.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../server/files-pending-update-runs.ts")>()),
	files_pending_update_runs_SELECTION_PAGE_SIZE: 10,
}));

beforeEach(mock_review_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("review job content", () => {
	test("saves more than one review page of Copy media before its document and keeps one unit per output", async () => {
		// 11 media and the document need 2 selection pages of 10 and 2 plan pages of 8.
		await save_copy_media_before_document(11);
	}, 600_000);
});
