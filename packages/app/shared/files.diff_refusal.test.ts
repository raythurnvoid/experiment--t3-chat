// Diff budget refusal case, split from files.test.ts. It computes until a budget runs out, and the
// step counts are the same in every runtime, so vitest.config.ts runs this file only in the convex
// project. files.diff_budgets.test.ts has the pass cases.
import { describe, expect, test } from "vitest";
import type { Doc as YDoc } from "yjs";
import {
	files_yjs_doc_create_from_text,
	files_yjs_doc_get_text,
	files_yjs_doc_update_from_text,
} from "./files-tiptap.ts";
import { files_text_diff_TOO_LARGE_MESSAGE } from "./files-text-diff.ts";

function plain_doc_from(text: string) {
	const yjsDoc = files_yjs_doc_create_from_text({ text, rootKind: "plain_text" });
	if ("_nay" in yjsDoc) {
		throw new Error("Expected plain-text doc creation to succeed", { cause: yjsDoc._nay });
	}
	return yjsDoc;
}

function plain_text_of(yjsDoc: YDoc) {
	const result = files_yjs_doc_get_text({ yjsDoc, rootKind: "plain_text" });
	if (result._nay) {
		throw new Error("Expected plain-text read to succeed", { cause: result._nay });
	}
	return result._yay;
}

describe("files_yjs_doc_update_from_text plain branch", () => {
	// Diff budget calibration guard. It runs the production budgets on purpose and proves a
	// genuinely pathological near-cap change still refuses. It keeps the real clock, so a slow run
	// ends at the 30 s wall-clock backstop instead of running to the step budget.
	test("refuses a near-cap high-line-count rewrite instead of degrading", () => {
		// Two unrelated ~890 KB texts: measured cost is over 2,000M steps, so the 1,000M step
		// budget trips (after ~19 s of compute on the measuring machine) and the Myers bisect
		// must refuse, never fall back to a coarse whole-document replacement.
		const sourceText = Array.from({ length: 68500 }, (_, i) => `src ${((i * 2654435761) >>> 0).toString(16)}`).join(
			"\n",
		);
		const targetText = Array.from({ length: 68500 }, (_, i) => `dst ${((i * 40503) >>> 0).toString(16)}`).join("\n");

		const yjsDoc = plain_doc_from(sourceText);
		const result = files_yjs_doc_update_from_text({
			text: targetText,
			mut_yjsDoc: yjsDoc,
			rootKind: "plain_text",
		});
		expect(result._nay?.message).toBe(files_text_diff_TOO_LARGE_MESSAGE);

		// The refusal must leave the document untouched.
		expect(plain_text_of(yjsDoc)).toBe(sourceText);
	}, 120_000);
});
