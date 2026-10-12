// Diff budget pass cases, split from files.test.ts. Each case computes for many seconds, and the
// step counts are the same in every runtime, so vitest.config.ts runs this file only in the convex
// project. files.diff_refusal.test.ts has the refusal case.
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Doc as YDoc } from "yjs";
import {
	files_yjs_doc_create_from_text,
	files_yjs_doc_get_text,
	files_yjs_doc_update_from_text,
} from "./files-tiptap.ts";

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

function set_plain_text(mut_yjsDoc: YDoc, text: string) {
	const result = files_yjs_doc_update_from_text({ text, mut_yjsDoc, rootKind: "plain_text" });
	if (result._nay) {
		throw new Error("Expected plain-text write to succeed", { cause: result._nay });
	}
}

describe("files_yjs_doc_update_from_text plain branch", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	// Diff budget calibration guards. These run the production budgets on purpose: the pass
	// cases prove ordinary bulk edits stay under the step budget. Step counts are deterministic
	// (same input, same count, on every machine), so these outcomes do not depend on machine speed;
	// the explicit test timeouts only give slow machines room to finish the compute.
	// The diff also has a 30 s wall-clock backstop. The full test run can load the CPU enough
	// to reach it, and then a pass case is refused. So the pass cases freeze `Date`, and only
	// the step budget decides.
	test("applies a full sort of 1,000 lines (~25 KB) within the diff budgets", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		// The generated hash-key order is deterministically scrambled, so sorting it is a
		// full permutation of every line. Measured cost: 132M steps (budget 1,000M).
		const lines = Array.from({ length: 1000 }, (_, i) => `key_${((i * 2654435761) >>> 0).toString(16)} = value_${i}`);
		const sortedText = [...lines].sort().join("\n");

		const yjsDoc = plain_doc_from(lines.join("\n"));
		set_plain_text(yjsDoc, sortedText);
		expect(plain_text_of(yjsDoc)).toBe(sortedText);
	}, 60_000);

	test("applies a prettify of a ~40 KB minified JSON within the diff budgets", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		// Measured cost: 313M steps (budget 1,000M) — the heaviest ordinary edit the budgets
		// must admit.
		const obj: Record<string, unknown> = {};
		for (let i = 0; i < 500; i++) {
			obj[`key_${((i * 2654435761) >>> 0).toString(16)}`] = {
				id: i,
				name: `name ${i}`,
				tags: [`a${i}`, `b${i}`],
				active: i % 2 === 0,
			};
		}
		const minifiedText = JSON.stringify(obj);
		const prettyText = JSON.stringify(obj, null, 2);

		const yjsDoc = plain_doc_from(minifiedText);
		set_plain_text(yjsDoc, prettyText);
		expect(plain_text_of(yjsDoc)).toBe(prettyText);
	}, 60_000);

	test("applies a replace-all with 1,000 hits in a ~66 KB file within the diff budgets", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		// Measured cost: 52M steps (budget 1,000M).
		const lines = Array.from({ length: 2000 }, (_, i) =>
			i % 2 === 0 ? `const value_${i} = oldName.compute(${i});` : `plain line ${i} with text`,
		);
		const sourceText = lines.join("\n");
		const targetText = sourceText.replaceAll("oldName", "newLongerName");

		const yjsDoc = plain_doc_from(sourceText);
		set_plain_text(yjsDoc, targetText);
		expect(plain_text_of(yjsDoc)).toBe(targetText);
	}, 60_000);
});
