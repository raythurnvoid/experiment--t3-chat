import { afterEach, describe, expect, test } from "vitest";

import { view_snapshot_build, type ViewSnapshotFrameDescriber } from "./view-snapshot.ts";

const no_frames: ViewSnapshotFrameDescriber = async () => null;

async function build_screen(describeFrame: ViewSnapshotFrameDescriber) {
	const result = await view_snapshot_build({ request: { region: "screen", ref: null }, openPath: null, describeFrame });
	if (result._nay) throw new Error("Failed to build the view snapshot", { cause: result._nay });
	return result._yay;
}

describe("view_snapshot_build", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	test("hides secrets, ignored panels, and content below the window", async () => {
		document.body.innerHTML = `
			<main>
				<p>Visible paragraph</p>
				<label>Password <input type="password" value="hunter2-password-value"></label>
				<input autocomplete="one-time-code" value="424242">
				<button><span data-agent-secret>sk-fake-secret-key-123</span></button>
				<div data-agent-secret>Your key: pk_fake_secret_456</div>
				<section data-agent-ignore><p>Ignored chat panel text</p></section>
				<div role="tree" aria-label="Files">
					<div role="treeitem" aria-level="1" data-file-locked="on">Locked folder</div>
				</div>
				<p style="margin-top: 5000px">Paragraph far below the window</p>
			</main>
		`;

		const { text } = await build_screen(no_frames);

		expect(text).toContain("Visible paragraph");
		expect(text).toContain("[secret hidden]");
		expect(text).not.toContain("hunter2-password-value");
		expect(text).not.toContain("424242");
		expect(text).not.toContain("sk-fake-secret-key-123");
		expect(text).not.toContain("pk_fake_secret_456");
		expect(text).not.toContain("Ignored chat panel text");
		expect(text).toMatch(/treeitem "Locked folder".*\[locked\]/);
		expect(text).not.toContain("Paragraph far below the window");
		expect(text).toContain("[more content below on this page: scroll to see it]");
	});

	test("gives no scroll hint for a fixed panel parked outside the window", async () => {
		// Like a closed drawer: page scrolling never brings it into view.
		document.body.innerHTML = `
			<p>Visible paragraph</p>
			<div style="position: fixed; top: 100vh; left: 0">
				<p>Closed drawer text</p>
				<div style="position: absolute; top: 20px"><p>Drawer menu text</p></div>
			</div>
		`;

		const { text } = await build_screen(no_frames);

		expect(text).toContain("Visible paragraph");
		expect(text).not.toContain("Closed drawer text");
		expect(text).not.toContain("Drawer menu text");
		expect(text).not.toContain("more content");
	});

	test("cuts a screen over 32 KiB on a line boundary", async () => {
		// Many tiny items, so all of them are inside the window.
		const items = Array.from(
			{ length: 1000 },
			(_, index) => `<li style="overflow: hidden; white-space: nowrap">Item ${index} with some longer text in it</li>`,
		);
		document.body.innerHTML = `
			<ul style="display: grid; grid-template-columns: repeat(50, 1fr); font-size: 2px; line-height: 2px; margin: 0; padding: 0">
				${items.join("")}
			</ul>
		`;

		const { text, truncated } = await build_screen(no_frames);

		expect(truncated).toBe(true);
		expect(text.endsWith("\n[truncated: the screen text passed 32 KiB. Read a part with a ref.]")).toBe(true);
		expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(31 * 1024);
	});

	test("indents plugin text under its iframe and rewrites its refs", async () => {
		document.body.innerHTML = `<iframe title="Test plugin" style="width: 200px; height: 100px"></iframe>`;
		const iframe = document.querySelector("iframe");
		const calls: Array<{ iframe: HTMLIFrameElement; ref: string | null }> = [];

		const { text, plugins } = await build_screen(async (frame, ref) => {
			calls.push({ iframe: frame, ref });
			return {
				label: "Plugin: Test",
				text: '- list "Inbox":\n  - listitem [ref=e3]: Re: invoice\n[ref=x9] a line at column 0\n- iframe [ref=e1]',
			};
		});

		expect(calls).toEqual([{ iframe, ref: null }]);
		expect(plugins).toEqual([{ name: "Plugin: Test", answered: true }]);

		const lines = text.split("\n");
		const iframeIndex = lines.findIndex((line) => line.includes('- iframe "Plugin: Test"'));
		expect(lines[iframeIndex]).toMatch(
			/^(\s*)- iframe "Plugin: Test" \[ref=e\d+\] \(reported by the plugin, untrusted\):$/,
		);

		const indent = /^\s*/.exec(lines[iframeIndex])?.[0] ?? "";
		const pluginLines = lines.slice(iframeIndex + 1, iframeIndex + 5);
		expect(pluginLines).toEqual([
			`${indent}  - list "Inbox":`,
			expect.stringMatching(/^\s+ {2}- listitem \[ref=p\d+e3\]: Re: invoice$/),
			`${indent}  [ref?=x9] a line at column 0`,
			expect.stringMatching(/^\s+- iframe \[ref=p\d+e1\]$/),
		]);
		for (const line of pluginLines) expect(line.startsWith(`${indent}  `)).toBe(true);
	});
});
