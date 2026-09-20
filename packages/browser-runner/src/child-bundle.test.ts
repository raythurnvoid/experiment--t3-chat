import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { CHILD_BUNDLE_JS } from "./child-bundle.gen";

describe("CHILD_BUNDLE_JS", () => {
	it("runs screenshot preparation in the page and restores its caret", () => {
		const namedFunction = CHILD_BUNDLE_JS.match(/([\w$]+)\(([\w$]+),\s*"inPagePrepareForScreenshots"\)/);
		expect(namedFunction).not.toBeNull();
		const start = CHILD_BUNDLE_JS.indexOf(`function ${namedFunction![2]}(`);
		expect(start).toBeGreaterThanOrEqual(0);
		const source = CHILD_BUNDLE_JS.slice(start, namedFunction!.index).trim().replace(/;$/, "");
		const setProperty = vi.fn();
		const window: { __pwCleanupScreenshot?: () => void } = {};
		const document = {
			createTreeWalker: (root: unknown) => ({ currentNode: root, nextNode: () => false }),
			querySelectorAll: () => [{
				style: {
					getPropertyValue: () => "blue",
					getPropertyPriority: () => "important",
					setProperty,
				},
			}],
		};

		// Playwright sends this wrapper to the page, where worker helpers do not exist.
		runInNewContext(`((__name => (${source}))(t => t))(undefined, true, false, false)`, {
			document,
			window,
			Element: class Element {},
			NodeFilter: { SHOW_ELEMENT: 1 },
		});
		expect(setProperty).toHaveBeenCalledExactlyOnceWith("caret-color", "transparent", "important");
		expect(window.__pwCleanupScreenshot).toBeTypeOf("function");
		window.__pwCleanupScreenshot!();
		expect(setProperty).toHaveBeenLastCalledWith("caret-color", "blue", "important");
		expect(window.__pwCleanupScreenshot).toBeUndefined();
	});
});
