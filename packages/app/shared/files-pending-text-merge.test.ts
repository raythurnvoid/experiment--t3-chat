import { describe, expect, test, vi } from "vitest";
import { files_pending_text_merge } from "./files-pending-text-merge.ts";

describe("files_pending_text_merge", () => {
	test("refuses an unanchored rewrite without returning guessed text", () => {
		const result = files_pending_text_merge({ baseText: "a\nb\n", proposedText: "a\nB\n", currentText: "xyz" });
		expect(result._nay?.message).toBe("Could not match the proposed lines to the saved text");
		expect(result._yay).toBeUndefined();
	});

	test("refuses when the comparison deadline is reached", () => {
		const clock = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(60_000);
		try {
			const result = files_pending_text_merge({ baseText: "old", proposedText: "proposed", currentText: "current" });
			expect(result._nay?.message).toBe("This change is too large to compare safely");
		} finally {
			clock.mockRestore();
		}
	});

	test("refuses crossed matches inside an insertion region", () => {
		const result = files_pending_text_merge({
			baseText: "head\ntail\n",
			proposedText: "head\nfirst\nsecond\ntail\n",
			currentText: "head\nsecond\nfirst\ntail\n",
		});
		expect(result._nay?.message).toBe("Could not match the proposed lines to the saved text");
		expect(result._yay).toBeUndefined();
	});

	test.each([
		["old", "NEW", "new", "note"],
		["OLD", "NEW", "new", "NOTE"],
		["draft", "APPROVED", "published", "annotation"],
		["before", "PROPOSED", "current", "different note"],
		["123", "456", "789", "a 2nd note"],
		["old value", "NEW value", "new value", "note about old value"],
	])("refuses expanded replacements without a clear line target (%s)", (old, proposed, current, note) => {
		const result = files_pending_text_merge({
			baseText: `head\n${old}\ntail\n`,
			proposedText: `head\n${proposed}\ntail\n`,
			currentText: `head\n${current}\n${note}\ntail\n`,
		});
		expect(result._nay?.message).toBe("Could not match the proposed lines to the saved text");
		expect(result._yay).toBeUndefined();
	});

	test.each([
		["header and prefix", "budget: 100", "budget: 150", "header\nprefix budget: 200"],
		["suffix and footer", "budget: 100", "budget: 150", "budget: 1000\nfooter"],
		[
			"added note beside changed lines",
			"Budget: 100\nOwner: Bob",
			"Budget: 150\nOwner: Bob",
			"New note\nBudget: 120\nOwner: Alice",
		],
	])("refuses ambiguous expanded blocks (%s)", (_name, baseText, proposedText, currentText) => {
		const result = files_pending_text_merge({ baseText, proposedText, currentText });
		expect(result._nay?.message).toBe("Could not match the proposed lines to the saved text");
		expect(result._yay).toBeUndefined();
	});

	test.each([
		["overlapping numbers", "budget: 100", "budget: 150", "budget: 200", "budget: 150"],
		["numeric suffix", "budget: 100", "budget: 150", "budget: 1000", "budget: 150"],
		["same-line prefix", "budget: 100", "budget: 150", "prefix budget: 200", "budget: 150"],
		["footer", "budget: 100", "budget: 150", "budget: 100\nfooter", "budget: 150\nfooter"],
		[
			"unrelated saved lines",
			"Budget: 100\nNew note\nOwner: Bob",
			"Budget: 150\nNew note\nOwner: Bob",
			"Budget: 120\nNew note\nOwner: Alice",
			"Budget: 150\nNew note\nOwner: Alice",
		],
		[
			"joined saved lines",
			"name: Ray\nbudget: 100\nowner: Dana",
			"name: Ray\nbudget: 150\nowner: Dana",
			"name: Roy; budget: 120\nowner: Diane",
			"name: Roy; budget: 150\nowner: Diane",
		],
		[
			"deleted section",
			"head\nfirst\nbudget: 100\nlast\ntail\n",
			"head\nfirst\nbudget: 150\nlast\ntail\n",
			"head\ntail\n",
			"head\nbudget: 150\ntail\n",
		],
		[
			"two deleted ranges",
			"head\none\nkeep\ntwo\ntail\n",
			"head\nONE\nkeep\nTWO\ntail\n",
			"head\ntail\n",
			"head\nONE\nTWO\ntail\n",
		],
		["same-point inserts", "head\ntail\n", "head\nnew\ntail\n", "HEAD\nother\ntail\n", "HEAD\nother\nnew\ntail\n"],
		["identical insertion once", "head\ntail\n", "head\nnew\ntail\n", "HEAD\nnew\ntail\n", "HEAD\nnew\ntail\n"],
		[
			"identical insertion inside saved block",
			"head\ntail\n",
			"head\nnew\ntail\n",
			"head\nother\nnew\nlast\ntail\n",
			"head\nother\nnew\nlast\ntail\n",
		],
		[
			"word suffix is not an inserted line",
			"head\ntail\n",
			"head\nnew\ntail\n",
			"head\nrenew\ntail\n",
			"head\nrenew\nnew\ntail\n",
		],
		[
			"blank insertion after saved line",
			"head\ntail\n",
			"head\n\ntail\n",
			"head\nother\ntail\n",
			"head\nother\n\ntail\n",
		],
		[
			"identical blank insertion once",
			"head\ntail\n",
			"head\n\ntail\n",
			"head\nother\n\ntail\n",
			"head\nother\n\ntail\n",
		],
		[
			"two blank insertions keep their count",
			"head\ntail\n",
			"head\n\n\ntail\n",
			"head\nother\n\ntail\n",
			"head\nother\n\n\ntail\n",
		],
		[
			"partly saved insertion keeps its prefix once",
			"head\ntail\n",
			"head\nfirst\nsecond\ntail\n",
			"head\nfirst\nother\ntail\n",
			"head\nfirst\nother\nsecond\ntail\n",
		],
		[
			"partly saved insertion keeps its suffix once",
			"head\ntail\n",
			"head\nfirst\nsecond\ntail\n",
			"head\nother\nsecond\ntail\n",
			"head\nother\nfirst\nsecond\ntail\n",
		],
		[
			"partly saved insertion keeps repeated line counts",
			"head\ntail\n",
			"head\nnew\nnew\ntail\n",
			"head\nnew\nother\ntail\n",
			"head\nnew\nother\nnew\ntail\n",
		],
		[
			"saved note between adjacent accepted lines",
			"head\nalpha\nbeta\ntail\n",
			"head\nALPHA\nBETA\ntail\n",
			"head\nalpha\nnew note\nbeta\ntail\n",
			"head\nALPHA\nnew note\nBETA\ntail\n",
		],
		[
			"already saved replacement keeps its neighboring note",
			"head\nold\ntail\n",
			"head\nnew\ntail\n",
			"head\nnew\nnote\ntail\n",
			"head\nnew\nnote\ntail\n",
		],
		[
			"already saved insertion beside a replaced next line stays once",
			"head\ntail\n",
			"head\nnew\ntail\n",
			"head\nnew\nTAIL\n",
			"head\nnew\nTAIL\n",
		],
		[
			"an equal next-line replacement does not consume a proposed insertion",
			"head\ntail\n",
			"head\nnew\ntail\n",
			"head\nnew\n",
			"head\nnew\nnew\n",
		],
		[
			"already saved prefix beside a proposed replacement stays once",
			"old",
			"section one\nsection two\nsection three\nNEW",
			"section one\nsection two\nsection three\nold",
			"section one\nsection two\nsection three\nNEW",
		],
		[
			"equal inserted text elsewhere does not replace the target",
			"head\nold\ntail\n",
			"head\nnew\ntail\n",
			"head\nnew\nold\ntail\n",
			"head\nnew\nnew\ntail\n",
		],
		[
			"adjacent accepted lines moved apart",
			"head\nalpha\nbeta\ngamma\ntail\n",
			"head\nALPHA\nBETA\ngamma\ntail\n",
			"head\nbeta\ngamma\nalpha\ntail\n",
			"head\nBETA\ngamma\nALPHA\ntail\n",
		],
		[
			"unique move",
			"A\nkeep1\nB\nkeep2\nC\n",
			"A*\nkeep1\nB*\nkeep2\nC\n",
			"B\nkeep2\nA\nkeep1\nC\n",
			"B*\nkeep2\nA*\nkeep1\nC\n",
		],
		[
			"repeated text stays in its section",
			"First\nstatus: draft\nSecond\nstatus: draft\nEnd",
			"First\nstatus: ready\nSecond\nstatus: draft\nEnd",
			"Second\nstatus: draft\nEnd",
			"status: ready\nSecond\nstatus: draft\nEnd",
		],
		["empty proposal", "old", "", "current", ""],
		["unicode", "value: 🐱\nowner: Ray", "value: 🐶\nowner: Ray", "value: 🐭\nowner: Roy", "value: 🐶\nowner: Roy"],
		["final newline", "old\n", "new\n", "old\nfooter\n", "new\nfooter\n"],
		["saved insertion gains its accepted final newline", "head\n", "head\nnew\n", "HEAD\nnew", "HEAD\nnew\n"],
		["saved insertion loses its accepted final newline", "head\n", "head\nnew", "HEAD\nnew\n", "HEAD\nnew"],
		["EOF insertion keeps the saved line separate", "head\n", "head\nnew", "HEAD\nother", "HEAD\nother\nnew"],
		[
			"partly saved EOF insertion keeps one separator",
			"head\n",
			"head\nfirst\nsecond",
			"HEAD\nfirst",
			"HEAD\nfirst\nsecond",
		],
		["added final newline before saved footer", "one", "ONE\n", "one\nother\n", "ONE\nother\n"],
		["removed final newline before saved footer", "one\n", "ONE", "one\nother\n", "ONE\nother\n"],
		["newline-only change before saved footer", "one", "one\n", "one\nother\n", "one\nother\n"],
		["newline-only removal before saved footer", "one\n", "one", "one\nother\n", "one\nother\n"],
		[
			"restored paragraph keeps its separator",
			"First section.\n\nTarget.\n\nLast.\n",
			"First section.\n\nTarget accepted.\n\nLast.\n",
			"First section.\n\nLast changed.\n",
			"First section.\n\nTarget accepted.\n\nLast changed.\n",
		],
		[
			"restored paragraph reuses an existing separator",
			"First section.\n\nTarget.\n\nLast.\n",
			"First section.\n\nTarget accepted.\n\nLast.\n",
			"First section.\n\n\nLast changed.\n",
			"First section.\n\nTarget accepted.\n\nLast changed.\n",
		],
		[
			"restored paragraphs share their separator",
			"head\none\n\ntwo\n\ntail\n",
			"head\nONE\n\nTWO\n\ntail\n",
			"head\ntail\n",
			"head\nONE\n\nTWO\n\ntail\n",
		],
	])("%s", (_name, baseText, proposedText, currentText, expected) => {
		expect(files_pending_text_merge({ baseText, proposedText, currentText })._yay).toBe(expected);
	});
});
