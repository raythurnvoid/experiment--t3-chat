// The Move view reads at most 20 moved roots here instead of 200, and an input page holds 10 roots instead
// of 100, so 21 roots cross both. The mock puts this file in the isolated "Convex" project. The real size is
// in files_move_scale.test.ts.
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { mock_move_scale_storage, move_selected_files } from "./files_move_scale.setup.test.ts";

vi.mock("../server/files-transfer-status.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../server/files-transfer-status.ts")>()),
	files_transfer_status_MAX_SELECTED_NODES: 20,
}));
vi.mock("../shared/files.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../shared/files.ts")>()),
	files_TRANSFER_SELECTION_PAGE_SIZE: 10,
}));

beforeEach(mock_move_scale_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("public Move scale", () => {
	// 21 roots go past the view's 20 moved roots and use 3 input pages of 10.
	test("moves more selected files than the view shows and keeps every metadata value", async () => {
		await move_selected_files(21);
	}, 600_000);
});
