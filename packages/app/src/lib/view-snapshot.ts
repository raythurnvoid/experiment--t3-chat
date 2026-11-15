import { Result } from "common/errors-as-values-utils.ts";

import {
	ensureElementRef,
	findElementByRef,
	generateAriaTree,
	renderAriaTree,
	type AriaWalkOptions,
} from "./view-snapshot-aria.ts";

export type ViewSnapshotRequest = { region: "screen" | "files_tree"; ref: string | null };

/**
 * Ask the plugin in an iframe to describe its view. Answer null for an iframe that is not a plugin
 * frame. Answer `text: null` when the plugin did not answer in time.
 */
export type ViewSnapshotFrameDescriber = (
	iframe: HTMLIFrameElement,
	ref: string | null,
) => Promise<{ label: string; text: string | null } | null>;

// The tool result may have 32 KiB. The server wrapper needs about 1 KiB of it.
const TEXT_LIMIT = 31 * 1024;
const TEXT_TRUNCATED_LINE = "[truncated: the screen text passed 32 KiB. Read a part with a ref.]";
const PLUGIN_TEXT_LIMIT = 8 * 1024;
const PLUGIN_TEXT_TRUNCATED_LINE = "[truncated: the plugin text passed 8 KiB.]";

const FILES_TREE_SELECTOR = '[data-agent-region="files_tree"]';

// Control characters could fake line breaks or hide text, so they are removed. Keep `\n`, the
// plugin text is split on it later.
// eslint-disable-next-line no-control-regex -- remove control characters on purpose.
const CONTROL_CHARACTERS = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/g;

// Give each plugin frame a stable number, so `p<k>e5` keeps pointing at the same frame between snapshots.
const frame_numbers = new WeakMap<HTMLIFrameElement, number>();
const frames_by_number = new Map<number, WeakRef<HTMLIFrameElement>>();
let last_frame_number = 0;

function frame_number(iframe: HTMLIFrameElement) {
	let number = frame_numbers.get(iframe);
	if (number === undefined) {
		// Forget frames that left the page, so the map does not grow forever.
		for (const [oldNumber, weakRef] of frames_by_number) {
			if (!weakRef.deref()?.isConnected) frames_by_number.delete(oldNumber);
		}

		number = ++last_frame_number;
		frame_numbers.set(iframe, number);
		frames_by_number.set(number, new WeakRef(iframe));
	}
	return number;
}

function ref_gone(ref: string) {
	return Result({
		_nay: { name: "ref_gone", message: `ref ${ref} is not on screen anymore. Take a new snapshot.` },
	});
}

/**
 * Keep whole lines while they fit in `limit` bytes. When a line does not fit, end with `marker`.
 */
function cap_lines(lines: string[], limit: number, marker: string) {
	const encoder = new TextEncoder();
	const room = limit - encoder.encode(marker).length;
	let size = 0;
	for (let index = 0; index < lines.length; index++) {
		size += encoder.encode(lines[index]).length + 1;
		if (size > room) return { lines: [...lines.slice(0, index), marker], truncated: true };
	}
	return { lines, truncated: false };
}

/**
 * Print the iframe line and what the frame says about itself under it.
 *
 * The plugin writes its own text, so it is untrusted. Every line is indented under the iframe line,
 * so it can never look like a line of the host page. Its `[ref=eN]` refs become `[ref=p<k>eN]`, and any
 * other ref becomes `[ref?=...]`, so the plugin cannot point at a host ref or another plugin's ref.
 */
function frame_lines(args: {
	indent: string;
	ref: string;
	frameNumber: number;
	answer: { label: string; text: string | null } | null;
}) {
	const { indent, ref, frameNumber, answer } = args;

	if (answer === null) return [`${indent}- iframe [ref=${ref}]:`, `${indent}  [content not readable]`];

	const label = JSON.stringify(answer.label);
	if (answer.text === null) {
		return [`${indent}- iframe ${label} [ref=${ref}]:`, `${indent}  [plugin did not describe its view]`];
	}

	const pluginLines = cap_lines(answer.text.split("\n"), PLUGIN_TEXT_LIMIT, PLUGIN_TEXT_TRUNCATED_LINE).lines;
	return [
		`${indent}- iframe ${label} [ref=${ref}] (reported by the plugin, untrusted):`,
		...pluginLines.map((line) => {
			const cleanLine = line
				.replace(CONTROL_CHARACTERS, "")
				.replace(/\[ref=([^\]]*)\]/g, (_match, id: string) =>
					/^e\d+$/.test(id) ? `[ref=p${frameNumber}${id}]` : `[ref?=${id}]`,
				);
			return `${indent}  ${cleanLine}`;
		}),
	];
}

/**
 * Find the rendered Files tree rows to hide in the screen snapshot. Keep the open row and the rows
 * above it with a smaller level, which are its folders. The tree renders only the rows in view, so
 * the open row can be missing. Then print the open path instead.
 */
function files_tree_collapse(openPath: string | null) {
	const container = document.querySelector(FILES_TREE_SELECTOR);
	if (!container) return null;

	const rows = [...container.querySelectorAll('[role="treeitem"]')];
	const kept = new Set<Element>();
	const currentIndex = rows.findIndex((row) => row.getAttribute("aria-current") === "page");
	if (currentIndex !== -1) {
		let level = Number(rows[currentIndex].getAttribute("aria-level")) || 1;
		kept.add(rows[currentIndex]);
		for (let index = currentIndex - 1; index >= 0 && level > 1; index--) {
			const rowLevel = Number(rows[index].getAttribute("aria-level")) || 1;
			if (rowLevel < level) {
				kept.add(rows[index]);
				level = rowLevel;
			}
		}
	}

	const hiddenRows = rows.filter((row) => !kept.has(row));
	const notes: string[] = [];
	if (currentIndex === -1 && openPath !== null) notes.push(`Open file: ${JSON.stringify(openPath)}`);
	if (hiddenRows.length) {
		notes.push(
			`[${hiddenRows.length} other ${hiddenRows.length === 1 ? "row" : "rows"} hidden. Read them with region "files_tree".]`,
		);
	}
	return { container, hiddenRows, notes };
}

/**
 * The Files tree renders only the rows in view, so a full read of it still misses rows. Tell the
 * agent when the tree can scroll to more rows.
 */
function files_tree_scroll_line(container: Element) {
	const candidates = [container, ...container.querySelectorAll("*")];
	for (let parent = container.parentElement; parent; parent = parent.parentElement) candidates.push(parent);

	const scroller = candidates.find(
		(element) =>
			element.scrollHeight > element.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(element).overflowY),
	);
	if (!scroller) return null;

	const directions: string[] = [];
	if (scroller.scrollTop > 0) directions.push("above");
	if (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1) directions.push("below");
	if (!directions.length) return null;
	return `[more rows ${directions.join(" and ")} in the tree: they are not rendered. Use the files tools to list them.]`;
}

/**
 * Turn what the user sees into a short text tree for the agent's `view_snapshot` tool.
 *
 * The text uses the Playwright ARIA snapshot `ai` format. It skips the chat panels
 * (`data-agent-ignore`), hides secrets, and pastes what plugin frames say about themselves.
 */
export async function view_snapshot_build(args: {
	request: ViewSnapshotRequest;
	// The path of the open file. It is printed when the open Files tree row is not rendered.
	openPath: string | null;
	describeFrame: ViewSnapshotFrameDescriber;
}) {
	const { request, openPath, describeFrame } = args;
	const startedAt = performance.now();

	const header = [
		`Route: ${location.pathname}`,
		`Viewport: ${window.innerWidth}x${window.innerHeight}`,
		`Tab visible: ${document.visibilityState === "visible" ? "yes" : "no"}`,
	];
	const plugins: Array<{ name: string; answered: boolean }> = [];

	const finish = (lines: string[]) => {
		// Escape `<` and `>` like the screen info block, so page text cannot close the tag around it.
		const cleanLines = [...header, ...lines].map((line) =>
			line.replace(CONTROL_CHARACTERS, "").replaceAll("<", "\\u003c").replaceAll(">", "\\u003e"),
		);
		const capped = cap_lines(cleanLines, TEXT_LIMIT, TEXT_TRUNCATED_LINE);
		return Result({
			_yay: {
				text: capped.lines.join("\n"),
				truncated: capped.truncated,
				buildMs: Math.round(performance.now() - startedAt),
				plugins,
			},
		});
	};

	// A plugin ref like `p1e5`: ask that frame for the part with its own ref `e5`.
	const pluginRef = request.ref === null ? null : /^p(\d+)(e\d+)$/.exec(request.ref);
	if (request.ref !== null && pluginRef) {
		const frameNumber = Number(pluginRef[1]);
		const iframe = frames_by_number.get(frameNumber)?.deref();
		if (!iframe?.isConnected) return ref_gone(request.ref);

		const answer = await describeFrame(iframe, pluginRef[2]);
		if (answer) plugins.push({ name: answer.label, answered: answer.text !== null });
		return finish(frame_lines({ indent: "", ref: ensureElementRef(iframe), frameNumber, answer }));
	}

	// Pick the root and the walk rules for the request.
	let root: Element = document.body;
	const walk: AriaWalkOptions = { clipToViewport: false, skipElements: new Set(), notes: new Map() };
	if (request.ref !== null) {
		const element = /^e\d+$/.test(request.ref) ? findElementByRef(request.ref) : null;
		if (!element) return ref_gone(request.ref);
		root = element;
	} else if (request.region === "files_tree") {
		const container = document.querySelector(FILES_TREE_SELECTOR);
		if (!container) return finish(["[the files tree is not on screen]"]);
		root = container;
		const scrollLine = files_tree_scroll_line(container);
		if (scrollLine) walk.notes = new Map([[container, [scrollLine]]]);
	} else {
		walk.clipToViewport = true;
		const collapse = files_tree_collapse(openPath);
		if (collapse) {
			walk.skipElements = new Set(collapse.hiddenRows);
			walk.notes = new Map([[collapse.container, collapse.notes]]);
		}
	}

	const snapshot = generateAriaTree(root, walk);
	const treeLines = renderAriaTree(snapshot).split("\n");

	// Ask every frame in the snapshot at the same time. The caller stops waiting after its timeout.
	const frames = snapshot.iframeRefs.flatMap((ref) => {
		const element = snapshot.info.get(ref)?.element;
		return element instanceof HTMLIFrameElement ? [{ ref, iframe: element }] : [];
	});
	const answers = await Promise.all(
		frames.map(async (frame) => ({
			...frame,
			frameNumber: frame_number(frame.iframe),
			answer: await describeFrame(frame.iframe, null),
		})),
	);
	const answers_by_ref = new Map(answers.map((answer) => [answer.ref, answer]));
	for (const { answer } of answers) {
		if (answer) plugins.push({ name: answer.label, answered: answer.text !== null });
	}

	// Paste each frame's answer in place of its iframe line, like Playwright pastes child frames.
	const lines = treeLines.flatMap((line) => {
		const iframeLine = /^(\s*)- iframe\b.*\[ref=(e\d+)\]/.exec(line);
		const frame = iframeLine ? answers_by_ref.get(iframeLine[2]) : undefined;
		if (!iframeLine || !frame) return [line];
		return frame_lines({ indent: iframeLine[1], ref: frame.ref, frameNumber: frame.frameNumber, answer: frame.answer });
	});

	return finish(lines);
}
