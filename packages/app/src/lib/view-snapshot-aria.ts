// Adapted from microsoft/playwright v1.63.0 packages/injected/src/ariaSnapshot.ts,
// packages/injected/src/ariaSnapshotDistiller.ts, packages/isomorphic/ariaSnapshot.ts,
// packages/isomorphic/ariaSnapshotRenderer.ts, packages/isomorphic/stringUtils.ts and
// packages/isomorphic/yaml.ts (Apache-2.0, Copyright (c) Microsoft Corporation). Changed for Bonobo Senate:
// screen-only filter, secret and ignore rules, refs in a WeakMap, tabs. Keep it comparable to upstream.

/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
	beginAriaCaches,
	computeBox,
	endAriaCaches,
	getAriaChecked,
	getAriaDisabled,
	getAriaExpanded,
	getAriaInvalid,
	getAriaLevel,
	getAriaPressed,
	getAriaRole,
	getAriaSelected,
	getCSSContent,
	getElementAccessibleName,
	getElementComputedStyle,
	inputValueText,
	isElementHiddenForAria,
	isElementVisible,
	kAriaCheckedRoles,
	kAriaDisabledRoles,
	kAriaExpandedRoles,
	kAriaInvalidRoles,
	kAriaLevelRoles,
	kAriaPressedRoles,
	kAriaSelectedRoles,
	receivesPointerEvents,
	viewSnapshotSecretSelector,
	viewSnapshotSecretText,
} from "./view-snapshot-role-utils.ts";

// From isomorphic/ariaSnapshot.ts.

// https://www.w3.org/TR/wai-aria-1.2/#role_definitions

export type AriaRole =
	| "alert"
	| "alertdialog"
	| "application"
	| "article"
	| "banner"
	| "blockquote"
	| "button"
	| "caption"
	| "cell"
	| "checkbox"
	| "code"
	| "columnheader"
	| "combobox"
	| "complementary"
	| "contentinfo"
	| "definition"
	| "deletion"
	| "dialog"
	| "directory"
	| "document"
	| "emphasis"
	| "feed"
	| "figure"
	| "form"
	| "generic"
	| "grid"
	| "gridcell"
	| "group"
	| "heading"
	| "img"
	| "insertion"
	| "link"
	| "list"
	| "listbox"
	| "listitem"
	| "log"
	| "main"
	| "mark"
	| "marquee"
	| "math"
	| "meter"
	| "menu"
	| "menubar"
	| "menuitem"
	| "menuitemcheckbox"
	| "menuitemradio"
	| "navigation"
	| "none"
	| "note"
	| "option"
	| "paragraph"
	| "presentation"
	| "progressbar"
	| "radio"
	| "radiogroup"
	| "region"
	| "row"
	| "rowgroup"
	| "rowheader"
	| "scrollbar"
	| "search"
	| "searchbox"
	| "separator"
	| "slider"
	| "spinbutton"
	| "status"
	| "strong"
	| "subscript"
	| "superscript"
	| "switch"
	| "tab"
	| "table"
	| "tablist"
	| "tabpanel"
	| "term"
	| "textbox"
	| "time"
	| "timer"
	| "toolbar"
	| "tooltip"
	| "tree"
	| "treegrid"
	| "treeitem";

type AriaProps = {
	checked?: boolean | "mixed";
	disabled?: boolean;
	expanded?: boolean;
	active?: boolean;
	invalid?: boolean | "grammar" | "spelling";
	level?: number;
	pressed?: boolean | "mixed";
	selected?: boolean;
	// Bonobo Senate: a Files row the reader cannot open (`data-file-locked="on"`).
	locked?: boolean;
};

type AriaBox = {
	visible: boolean;
	inline: boolean;
	cursor?: string;
};

// Bonobo Senate: a `note` node is one line the app adds, for example a scroll hint. It is printed as is.
type AriaNode = AriaProps & {
	role: AriaRole | "fragment" | "iframe" | "note";
	name: string;
	ref?: string;
	children: (AriaNode | string)[];
	box: AriaBox;
	receivesPointerEvents: boolean;
	props: Record<string, string>;
};

function hasPointerCursor(ariaNode: AriaNode): boolean {
	return ariaNode.box.cursor === "pointer";
}

type AriaNodeJSON = {
	role: AriaRole | "iframe" | "text" | "note";
	name?: string;
	checked?: true | "mixed";
	disabled?: true;
	expanded?: true;
	active?: true;
	invalid?: true | "grammar" | "spelling";
	level?: number;
	pressed?: true | "mixed";
	selected?: true;
	locked?: true;
	ariaHidden?: true;
	ref?: string;
	cursor?: "pointer";
	url?: string;
	placeholder?: string;
	text?: string;
	children?: (AriaNodeJSON | string)[];
};

type AriaSnapshotJSON = AriaNodeJSON[];

// From isomorphic/stringUtils.ts.

function normalizeWhiteSpace(text: string): string {
	return text
		.replace(/[\u200b\u00ad]/g, "")
		.trim()
		.replace(/\s+/g, " ");
}

function truncateDataUrl(url: string): string {
	// Data URLs can carry megabytes of base64 payload, which is never useful in
	// human/AI-facing output. Keep the media type prefix for context, drop the data.
	if (!url.startsWith("data:")) return url;
	const comma = url.indexOf(",");
	if (comma === -1) return url;
	return url.slice(0, comma + 1) + "\u2026";
}

// From isomorphic/yaml.ts.

function yamlEscapeKeyIfNeeded(str: string): string {
	if (!yamlStringNeedsQuotes(str)) return str;
	return `'` + str.replace(/'/g, `''`) + `'`;
}

function yamlEscapeValueIfNeeded(str: string): string {
	if (!yamlStringNeedsQuotes(str)) return str;
	return (
		'"' +
		// eslint-disable-next-line no-control-regex -- escape control characters on purpose.
		str.replace(/[\\"\x00-\x1f\x7f-\x9f]/g, (c) => {
			switch (c) {
				case "\\":
					return "\\\\";
				case '"':
					return '\\"';
				case "\b":
					return "\\b";
				case "\f":
					return "\\f";
				case "\n":
					return "\\n";
				case "\r":
					return "\\r";
				case "\t":
					return "\\t";
				default:
					const code = c.charCodeAt(0);
					return "\\x" + code.toString(16).padStart(2, "0");
			}
		}) +
		'"'
	);
}

function yamlStringNeedsQuotes(str: string): boolean {
	if (str.length === 0) return true;

	// Strings with leading or trailing whitespace need quotes
	if (/^\s|\s$/.test(str)) return true;

	// Strings containing control characters need quotes
	// eslint-disable-next-line no-control-regex -- find control characters on purpose.
	if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(str)) return true;

	// Strings starting with '-' need quotes
	if (/^-/.test(str)) return true;

	// Strings containing ':' or '\n' followed by a space or at the end need quotes
	if (/[\n:](\s|$)/.test(str)) return true;

	// Strings containing '#' preceded by a space need quotes (comment indicator)
	if (/\s#/.test(str)) return true;

	// Strings that contain line breaks need quotes
	if (/[\n\r]/.test(str)) return true;

	// Strings starting with indicator characters or quotes need quotes
	if (/^[&*\],?!>|@"'#%]/.test(str)) return true;

	// Strings containing special characters that could cause ambiguity
	if (/[{}`]/.test(str)) return true;

	// YAML array starts with [
	if (/^\[/.test(str)) return true;

	// Non-string types recognized by YAML
	if (!isNaN(Number(str)) || ["y", "n", "yes", "no", "true", "false", "on", "off", "null"].includes(str.toLowerCase()))
		return true;

	return false;
}

// From isomorphic/ariaSnapshotRenderer.ts.

function renderAriaSnapshotAsYaml(snapshot: AriaSnapshotJSON): string {
	const lines: string[] = [];
	const includeText = (_node: AriaNodeJSON, _text: string) => true;
	const renderString = (str: string) => str;

	const visitText = (text: string, depth: number) => {
		const escaped = yamlEscapeValueIfNeeded(renderString(text));
		if (escaped) lines.push(indent(depth) + "- text: " + escaped);
	};

	const createKey = (node: AriaNodeJSON): string => {
		let key: string = node.role;
		// Yaml has a limit of 1024 characters per key, and we leave some space for role and attributes.
		if (node.name && node.name.length <= 900) {
			const name = renderString(node.name);
			if (name) {
				const stringifiedName = name.startsWith("/") && name.endsWith("/") ? name : JSON.stringify(name);
				key += " " + stringifiedName;
			}
		}
		if (node.checked === "mixed") key += ` [checked=mixed]`;
		if (node.checked === true) key += ` [checked]`;
		if (node.disabled) key += ` [disabled]`;
		if (node.expanded) key += ` [expanded]`;
		if (node.active) key += ` [active]`;
		if (node.invalid === "grammar" || node.invalid === "spelling") key += ` [invalid=${node.invalid}]`;
		if (node.invalid === true) key += ` [invalid]`;
		if (node.level) key += ` [level=${node.level}]`;
		if (node.pressed === "mixed") key += ` [pressed=mixed]`;
		if (node.pressed === true) key += ` [pressed]`;
		if (node.selected === true) key += ` [selected]`;
		if (node.locked) key += ` [locked]`;
		if (node.ariaHidden) key += ` [aria-hidden]`;
		if (node.ref) {
			key += ` [ref=${node.ref}]`;
			if (node.cursor === "pointer") key += " [cursor=pointer]";
		}
		return key;
	};

	const visit = (node: AriaNodeJSON, depth: number) => {
		if (node.role === "text") {
			visitText(node.text || "", depth);
			return;
		}
		if (node.role === "note") {
			lines.push(indent(depth) + (node.text || ""));
			return;
		}

		const escapedKey = indent(depth) + "- " + yamlEscapeKeyIfNeeded(createKey(node));
		const props: [string, string][] = [];
		if (node.url !== undefined) props.push(["url", node.url]);
		if (node.placeholder !== undefined) props.push(["placeholder", node.placeholder]);

		if (node.text === undefined && !props.length && !node.children?.length) {
			// Leaf node without children.
			lines.push(escapedKey);
		} else if (node.text !== undefined && !props.length) {
			// Leaf node with just some text inside.
			if (includeText(node, node.text))
				lines.push(escapedKey + ": " + yamlEscapeValueIfNeeded(renderString(node.text)));
			else lines.push(escapedKey);
		} else {
			// Node with (optional) props and some children.
			lines.push(escapedKey + ":");
			for (const [name, value] of props)
				lines.push(indent(depth + 1) + "- /" + name + ": " + yamlEscapeValueIfNeeded(value));
			if (node.text !== undefined) {
				visitText(includeText(node, node.text) ? node.text : "", depth + 1);
			} else {
				for (const child of node.children || []) {
					if (typeof child === "string") visitText(includeText(node, child) ? child : "", depth + 1);
					else visit(child, depth + 1);
				}
			}
		}
	};

	for (const node of snapshot) visit(node, 0);
	return lines.join("\n");
}

function indent(depth: number): string {
	return "  ".repeat(depth);
}

// From injected/src/ariaSnapshotDistiller.ts.

// Distillation makes the snapshot less verbose without losing information: after the full tree is
// built, a single traversal applies the chained plugins below, babel-style. Each plugin is a
// visitor: `enter` runs pre-order, `exit` runs post-order after the children were traversed - and
// possibly removed, unwrapped or inlined. Either hook can detach the node by returning 'remove'
// (from `enter`, the subtree is then not traversed and no further hooks run for it), or replace
// the node with its children by returning 'unwrap' (from `enter`, the hoisted children are
// re-visited in the node's place; from `exit`, they were already traversed and are spliced in as
// is). Plugins mutate the tree in place; `snapshot.info` and `snapshot.refs` are left intact, so
// refs of removed nodes still resolve through the aria-ref selector engine.
type DistillerContext = {
	snapshot: AriaSnapshot;
	// Depth of the current node; children of the root fragment are at depth 0.
	depth: number;
	// Render depth limit, plugins should not rely on anything below it being rendered.
	maxDepth: number | undefined;
	// The chain of ancestors of the current node, root first. Maintained by the traversal.
	ancestors: AriaNode[];
	// Content refs of the entered nodes' accessible names that are not yet represented in the
	// output - see `removeRedundantNames`.
	pendingContentRefs: Set<string>;
};

type DistillerPlugin = {
	name: string;
	enter?(node: AriaNode, ctx: DistillerContext): "remove" | "unwrap" | void;
	exit?(node: AriaNode, ctx: DistillerContext): "remove" | "unwrap" | void;
};

function distillAriaSnapshot(snapshot: AriaSnapshot) {
	runPlugins(snapshot, aiPlugins);
}

function runPlugins(snapshot: AriaSnapshot, plugins: DistillerPlugin[]) {
	const ctx: DistillerContext = {
		snapshot,
		depth: -1,
		maxDepth: undefined,
		ancestors: [],
		pendingContentRefs: new Set(),
	};
	const traverse = (node: AriaNode, depth: number) => {
		const children: (AriaNode | string)[] = [];
		const visitChild = (child: AriaNode | string) => {
			if (typeof child === "string") {
				children.push(child);
				return;
			}
			ctx.depth = depth + 1;
			for (const plugin of plugins) {
				const result = plugin.enter?.(child, ctx);
				if (result === "remove") return;
				if (result === "unwrap") {
					child.children.forEach(visitChild);
					return;
				}
			}
			traverse(child, depth + 1);
			ctx.depth = depth + 1;
			for (const plugin of plugins) {
				const result = plugin.exit?.(child, ctx);
				if (result === "remove") return;
				if (result === "unwrap") {
					children.push(...child.children);
					return;
				}
			}
			children.push(child);
		};
		ctx.ancestors.push(node);
		node.children.forEach(visitChild);
		ctx.ancestors.pop();
		node.children = children;
	};
	// Hooks run on the root as well, but the root cannot be removed or unwrapped.
	for (const plugin of plugins) plugin.enter?.(snapshot.root, ctx);
	traverse(snapshot.root, -1);
	ctx.depth = -1;
	for (const plugin of plugins) plugin.exit?.(snapshot.root, ctx);
}

// A generic node whose only content is text - it carries no structure of its own.
function isLeafGeneric(node: AriaNode): boolean {
	return node.role === "generic" && node.children.every((child) => typeof child === "string");
}

// Removing the click target root would hide an actionable element from the snapshot.
function isClickTargetRoot(node: AriaNode, ctx: DistillerContext): boolean {
	return (
		!!node.ref &&
		hasPointerCursor(node) &&
		!ctx.ancestors.some((ancestor) => !!ancestor.ref && hasPointerCursor(ancestor))
	);
}

// The tree builder emits raw text tokens - text nodes, CSS content, block spacing markers - as
// string children. Coalesce the adjacent ones, normalize whitespace and drop the empties, then
// drop a lone text child that merely repeats the node's accessible name. Runs on `exit`, so the
// merge sees the children in their final shape.
const mergeStringChildren: DistillerPlugin = {
	name: "mergeStringChildren",
	exit(node: AriaNode) {
		const children: (AriaNode | string)[] = [];
		const buffer: string[] = [];
		const flush = () => {
			if (!buffer.length) return;
			const text = normalizeWhiteSpace(buffer.join(""));
			if (text) children.push(text);
			buffer.length = 0;
		};
		for (const child of node.children) {
			if (typeof child === "string") {
				buffer.push(child);
			} else {
				flush();
				children.push(child);
			}
		}
		flush();
		node.children = children;
		if (node.children.length === 1 && node.children[0] === node.name) node.children = [];
	},
};

// Only unwrap a generic that encloses at most one element, logical grouping still makes sense,
// even if it is not ref-able. The decision is made on `exit` - whether the node encloses a single
// ref-bearing child is only known after its own descendants were unwrapped - so nested wrappers
// collapse bottom-up. A generic emptied by the other plugins is dropped, unless it is the
// click target root, for example an icon-only button.
const unwrapSingleChildGenerics: DistillerPlugin = {
	name: "unwrapSingleChildGenerics",
	exit(node: AriaNode, ctx: DistillerContext): "unwrap" | void {
		if (
			node.role !== "generic" ||
			node.name ||
			node.children.length > 1 ||
			!node.children.every((child) => typeof child !== "string" && !!child.ref)
		)
			return;
		if (!node.children.length && isClickTargetRoot(node, ctx)) return;
		return "unwrap";
	},
};

// A decorative image - role `img` with no accessible name and no content - carries no
// information. The decision is made on `exit` - whether the node has content is only known after
// `mergeStringChildren` dropped the empty text tokens. A clickable image outside of any clickable
// container is not decorative though - e.g. a bare svg icon acting as a button - and is kept.
const removeNamelessImages: DistillerPlugin = {
	name: "removeNamelessImages",
	exit(node: AriaNode, ctx: DistillerContext): "remove" | void {
		if (node.role === "img" && !node.name && !node.children.length && !isClickTargetRoot(node, ctx)) return "remove";
	},
};

// The node's accessible name is derived from content; when every node that contributed to it is
// represented in the output anyway, the name would just repeat that content and is dropped.
// Single-pass bookkeeping over the shared `pendingContentRefs` set: entering a node clears its
// own ref - it is now represented - except for leaf generics, which only exist to supply text
// and are dropped by `removeNameRepeatingChild` once a kept name shows it. On exit, either every
// contributor was cleared and the name goes, or the kept name now represents its contributors,
// so they are cleared for the benefit of the ancestors. A node removed on enter never clears its
// ref, and an unwrapped one does - matching what remains in the tree.
const removeRedundantNames: DistillerPlugin = {
	name: "removeRedundantNames",
	enter(node: AriaNode, ctx: DistillerContext) {
		if (!node.ref) return;
		for (const ref of ctx.snapshot.info.get(node.ref)?.nameFromContentRefs || []) ctx.pendingContentRefs.add(ref);
		const beyondDepth = !!ctx.maxDepth && ctx.depth > ctx.maxDepth;
		if (!beyondDepth && !isLeafGeneric(node)) ctx.pendingContentRefs.delete(node.ref);
	},
	exit(node: AriaNode, ctx: DistillerContext) {
		if (!node.ref) return;
		const nameFromContentRefs = ctx.snapshot.info.get(node.ref)?.nameFromContentRefs;
		if (!nameFromContentRefs?.length) return;
		if (nameFromContentRefs.every((ref) => !ctx.pendingContentRefs.has(ref))) {
			node.name = "";
		} else {
			for (const ref of nameFromContentRefs) ctx.pendingContentRefs.delete(ref);
		}
	},
};

// A generic whose whole content is a piece of text - a single text child, or just an accessible
// name - that repeats the parent's accessible name adds no information, so it removes itself.
// `inlineTextIntoGeneric` runs first, bubbling text up through nameless wrappers, so by the time
// a wrapper exits its text faces the real parent - no need to look further up the ancestor chain.
// The removed text then only survives through the names derived from it, so the node's ref is
// marked pending again - it may have been cleared on enter, before the node's other children
// (e.g. a decorative image) were distilled away - and `removeRedundantNames` keeps those names.
const removeNameRepeatingChild: DistillerPlugin = {
	name: "removeNameRepeatingChild",
	exit(node: AriaNode, ctx: DistillerContext): "remove" | void {
		const parent = ctx.ancestors[ctx.ancestors.length - 1];
		if (!parent?.name || node.role !== "generic" || node.active || Object.keys(node.props).length) return;
		const singleTextChild =
			node.children.length === 1 && typeof node.children[0] === "string" ? node.children[0] : undefined;
		const text = node.name ? (node.children.length ? undefined : node.name) : singleTextChild;
		if (text && text === parent.name) {
			if (node.ref) ctx.pendingContentRefs.add(node.ref);
			return "remove";
		}
	},
};

// A generic whose only child is a nameless leaf generic inlines that child's text:
// `generic: - generic: "text"` becomes `generic: "text"`. Runs post-order, so chains collapse
// bottom-up, and after the other plugins already removed or unwrapped the children.
const inlineTextIntoGeneric: DistillerPlugin = {
	name: "inlineTextIntoGeneric",
	exit(node: AriaNode) {
		if (node.role !== "generic" || Object.keys(node.props).length || node.children.length !== 1) return;
		const child = node.children[0];
		if (typeof child === "string") return;
		if (child.role !== "generic" || child.name || child.active || Object.keys(child.props).length) return;
		if (child.children.length === 1 && typeof child.children[0] === "string") node.children = [child.children[0]];
	},
};

// The ai preset compresses the snapshot on top of normalization. It runs as one traversal:
// `removeRedundantNames` bookkeeping must observe every node the tree retains, including the
// wrappers that `unwrapSingleChildGenerics` is about to unwrap. On exit, text is first inlined
// into the node, so that `removeNameRepeatingChild` faces the real parent when it compares.
const aiPlugins: DistillerPlugin[] = [
	mergeStringChildren,
	removeNamelessImages,
	removeRedundantNames,
	inlineTextIntoGeneric,
	removeNameRepeatingChild,
	unwrapSingleChildGenerics,
];

// From injected/src/ariaSnapshot.ts.

export type AriaSnapshot = {
	root: AriaNode;
	info: Map<string, { element: Element; nameFromContentRefs: string[] }>;
	refs: Map<Element, string>;
	iframeRefs: string[];
};

type AriaRef = {
	role: string;
	name: string;
	ref: string;
};

let lastRef = 0;

// Bonobo Senate: keep each element's ref in a WeakMap, not in an expando property on the element.
// The second map finds the element again from the ref text. The agent reads one part of the screen
// with a ref from an earlier snapshot, so refs stay findable while their element is on the page.
const elementRefs = new WeakMap<Element, AriaRef>();
const refElements = new Map<string, WeakRef<Element>>();

export function findElementByRef(ref: string): Element | null {
	const element = refElements.get(ref)?.deref();
	return element?.isConnected ? element : null;
}

/**
 * Give an element a ref even when it has no node in the tree, for example a scroll box that a scroll
 * hint names.
 */
export function ensureElementRef(element: Element): string {
	let ariaRef = elementRefs.get(element);
	if (!ariaRef) {
		ariaRef = { role: "", name: "", ref: "e" + ++lastRef };
		elementRefs.set(element, ariaRef);
	}
	if (!refElements.has(ariaRef.ref)) refElements.set(ariaRef.ref, new WeakRef(element));
	return ariaRef.ref;
}

type InternalOptions = {
	visibility: "aria" | "ariaOrVisible" | "ariaAndVisible";
	refs: "all" | "interactable" | "none";
	includeGenericRole?: boolean;
	renderCursorPointer?: boolean;
	renderActive?: boolean;
};

// For AI consumption. Bonobo Senate builds only the `ai` mode.
const options: InternalOptions = {
	visibility: "ariaOrVisible",
	refs: "interactable",
	includeGenericRole: true,
	renderActive: true,
	renderCursorPointer: true,
};

/**
 * Bonobo Senate options for one walk.
 */
export type AriaWalkOptions = {
	// Leave out what is outside the window, and what is scrolled out of a scroll box.
	clipToViewport: boolean;
	// Leave these elements out without a hint. The Files tree collapse uses it.
	skipElements: ReadonlySet<Element>;
	// Lines to print as the last children of an element.
	notes: ReadonlyMap<Element, readonly string[]>;
};

type ClipBox = { top: number; left: number; bottom: number; right: number };

// `scrollBox` is the element that cuts the box, or null for the page itself. `scrolls` is false inside a
// fixed box: scrolling the page never moves it, so skipped content there gets no scroll hint.
type Clip = { box: ClipBox; scrollBox: Element | null; scrolls: boolean };

export function generateAriaTree(rootElement: Element, walk: AriaWalkOptions): AriaSnapshot {
	// Delete refs of elements that left the page, so the lookup map does not grow forever.
	for (const [ref, weakRef] of refElements) {
		if (!weakRef.deref()?.isConnected) refElements.delete(ref);
	}

	const visited = new Set<Node>();
	// For each node, the elements that contributed to its accessible name.
	const nameSourceElements = new Map<AriaNode, Set<Element> | undefined>();
	// Bonobo Senate: where skipped content is, for each scroll box. The `null` key is the page.
	const scrollHints = new Map<Element | null, Set<string>>();
	const pageClip: Clip = {
		box: { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth },
		scrollBox: null,
		scrolls: true,
	};
	const fixedClip: Clip = { ...pageClip, scrolls: false };

	const snapshot: AriaSnapshot = {
		root: {
			role: "fragment",
			name: "",
			children: [],
			props: {},
			box: computeBox(rootElement),
			receivesPointerEvents: true,
		},
		info: new Map<string, { element: Element; nameFromContentRefs: string[] }>(),
		refs: new Map<Element, string>(),
		iframeRefs: [],
	};
	setAriaNodeElement(snapshot.root, rootElement);

	const addScrollHint = (clip: Clip, rect: DOMRect) => {
		if (!clip.scrolls) return;

		const directions = scrollHints.get(clip.scrollBox) ?? new Set<string>();
		if (rect.top >= clip.box.bottom) directions.add("below");
		else if (rect.bottom <= clip.box.top) directions.add("above");
		if (rect.left >= clip.box.right) directions.add("to the right");
		else if (rect.right <= clip.box.left) directions.add("to the left");
		scrollHints.set(clip.scrollBox, directions);
	};

	const visit = (ariaNode: AriaNode, node: Node, parentElementVisible: boolean, clip: Clip | null) => {
		if (visited.has(node)) return;
		visited.add(node);

		if (node.nodeType === Node.TEXT_NODE && node.nodeValue) {
			if (!parentElementVisible) return;

			const text = node.nodeValue;
			// <textarea>AAA</textarea> should not report AAA as a child of the textarea.
			if (ariaNode.role !== "textbox" && text) ariaNode.children.push(node.nodeValue || "");
			return;
		}

		if (node.nodeType !== Node.ELEMENT_NODE) return;

		const element = node as Element;
		// Bonobo Senate: leave out the chat panels and other parts that the agent must not read.
		if (element.hasAttribute("data-agent-ignore") || walk.skipElements.has(element)) return;

		// Bonobo Senate: leave out an element that is fully outside the visible box. A fixed or absolute
		// element can be drawn outside its parents, so it is never skipped, and its children are checked
		// against the window. An element with `display: contents` has no box of its own.
		let childClip = clip;
		if (clip) {
			const style = getElementComputedStyle(element);
			const position = style?.position;
			if (position === "fixed") childClip = fixedClip;
			// An absolute box inside a fixed box moves with that box, not with the page.
			else if (position === "absolute") childClip = clip.scrolls ? pageClip : fixedClip;
			if (style && style.display !== "contents") {
				const rect = element.getBoundingClientRect();
				const outside =
					rect.bottom <= clip.box.top ||
					rect.top >= clip.box.bottom ||
					rect.right <= clip.box.left ||
					rect.left >= clip.box.right;
				if ((position === "static" || position === "relative") && rect.width > 0 && rect.height > 0 && outside) {
					addScrollHint(clip, rect);
					return;
				}

				// A box that does not show its overflow cuts what its children can show.
				if (childClip && (style.overflowX !== "visible" || style.overflowY !== "visible")) {
					childClip = {
						box: {
							top: Math.max(childClip.box.top, rect.top),
							left: Math.max(childClip.box.left, rect.left),
							bottom: Math.min(childClip.box.bottom, rect.bottom),
							right: Math.min(childClip.box.right, rect.right),
						},
						scrollBox: element,
						scrolls: true,
					};
				}
			}
		}

		const isElementVisibleForAria = !isElementHiddenForAria(element);
		let visible = isElementVisibleForAria;
		if (options.visibility === "ariaOrVisible") visible = isElementVisibleForAria || isElementVisible(element);
		if (options.visibility === "ariaAndVisible") visible = isElementVisibleForAria && isElementVisible(element);

		// Optimization: if we only consider aria visibility, we can skip child elements because
		// they will not be visible for aria as well.
		if (options.visibility === "aria" && !visible) return;

		const ariaChildren: Element[] = [];
		const ariaOwns = element.getAttribute("aria-owns");
		if (ariaOwns !== null) {
			const ids = ariaOwns.split(/\s+/);
			for (const id of ids) {
				const ownedElement = rootElement.ownerDocument.getElementById(id);
				if (ownedElement) ariaChildren.push(ownedElement);
			}
		}

		const childAriaNode = visible ? toAriaNode(element, nameSourceElements) : null;
		if (childAriaNode && element.getAttribute("aria-hidden")?.toLowerCase() === "true")
			childAriaNode.props["aria-hidden"] = "true";
		let elementInfo: { element: Element; nameFromContentRefs: string[] } | undefined;
		if (childAriaNode) {
			if (childAriaNode.ref) {
				elementInfo = { element, nameFromContentRefs: [] };
				snapshot.info.set(childAriaNode.ref, elementInfo);
				snapshot.refs.set(element, childAriaNode.ref);
				if (childAriaNode.role === "iframe") snapshot.iframeRefs.push(childAriaNode.ref);
			}
			ariaNode.children.push(childAriaNode);
		}

		// Bonobo Senate: print a marker instead of anything inside a secret block.
		if (element.closest(viewSnapshotSecretSelector))
			(childAriaNode || ariaNode).children.push(" " + viewSnapshotSecretText + " ");
		else processElement(childAriaNode || ariaNode, element, ariaChildren, visible, childClip);

		// Bonobo Senate: print the app notes and the scroll hint of this element as its last lines.
		const lines = [...(walk.notes.get(element) ?? [])];
		const directions = scrollHints.get(element);
		if (directions) lines.push(scrollHintLine(element, directions));
		for (const line of lines) (childAriaNode || ariaNode).children.push(noteNode(line));

		// Now that the subtree is processed, every descendant that contributed to this node's
		// accessible name has its ref assigned, so we can resolve those refs as the name's origins.
		if (elementInfo && childAriaNode) {
			for (const contributor of nameSourceElements.get(childAriaNode) || []) {
				const ref = snapshot.refs.get(contributor);
				if (ref && ref !== childAriaNode.ref) elementInfo.nameFromContentRefs.push(ref);
			}
		}
	};

	function processElement(
		ariaNode: AriaNode,
		element: Element,
		ariaChildren: Element[],
		parentElementVisible: boolean,
		clip: Clip | null,
	) {
		// Surround every element with spaces for the sake of concatenated text nodes.
		const display = getElementComputedStyle(element)?.display || "inline";
		const treatAsBlock = display !== "inline" || element.nodeName === "BR" ? " " : "";
		if (treatAsBlock) ariaNode.children.push(treatAsBlock);

		ariaNode.children.push(getCSSContent(element, "::before") || "");
		const assignedNodes = element instanceof HTMLSlotElement ? element.assignedNodes() : [];
		if (assignedNodes.length) {
			for (const child of assignedNodes) visit(ariaNode, child, parentElementVisible, clip);
		} else {
			for (let child = element.firstChild; child; child = child.nextSibling) {
				if (!(child as Element | Text).assignedSlot) visit(ariaNode, child, parentElementVisible, clip);
			}
			if (element.shadowRoot) {
				for (let child = element.shadowRoot.firstChild; child; child = child.nextSibling)
					visit(ariaNode, child, parentElementVisible, clip);
			}
		}

		for (const child of ariaChildren) visit(ariaNode, child, parentElementVisible, clip);

		ariaNode.children.push(getCSSContent(element, "::after") || "");

		if (treatAsBlock) ariaNode.children.push(treatAsBlock);

		if (ariaNode.children.length === 1 && ariaNode.name === ariaNode.children[0]) ariaNode.children = [];

		const href = element.getAttribute("href");
		if (ariaNode.role === "link" && href !== null) {
			ariaNode.props["url"] = truncateDataUrl(href);
		}

		const placeholder = element.getAttribute("placeholder");
		if (ariaNode.role === "textbox" && placeholder !== null && placeholder !== ariaNode.name) {
			ariaNode.props["placeholder"] = placeholder;
		}
	}

	beginAriaCaches();
	try {
		visit(snapshot.root, rootElement, true, walk.clipToViewport ? pageClip : null);
	} finally {
		endAriaCaches();
	}

	// Bonobo Senate: content skipped against the window gets one hint at the end of the page.
	const pageDirections = scrollHints.get(null);
	if (pageDirections) snapshot.root.children.push(noteNode(scrollHintLine(null, pageDirections)));

	distillAriaSnapshot(snapshot);
	return snapshot;
}

// Bonobo Senate: one line that tells the agent where the skipped content is and how to read it.
function scrollHintLine(scrollBox: Element | null, directions: Set<string>) {
	const where = [...directions].join(" and ");
	if (!scrollBox) return `[more content ${where} on this page: scroll to see it]`;
	return `[more content ${where} in this area: scroll, or read it with ref ${ensureElementRef(scrollBox)}]`;
}

function noteNode(text: string): AriaNode {
	return {
		role: "note",
		name: text,
		children: [],
		props: {},
		box: { visible: true, inline: false },
		receivesPointerEvents: false,
	};
}

function computeAriaRef(ariaNode: AriaNode, force: boolean) {
	if (options.refs === "none") return;
	if (!force && options.refs === "interactable" && (!ariaNode.box.visible || !ariaNode.receivesPointerEvents)) return;

	const element = ariaNodeElement(ariaNode);
	if (!element) return;
	let ariaRef = elementRefs.get(element);
	if (!ariaRef || ariaRef.role !== ariaNode.role || ariaRef.name !== ariaNode.name) {
		ariaRef = { role: ariaNode.role, name: ariaNode.name, ref: "e" + ++lastRef };
		elementRefs.set(element, ariaRef);
	}
	if (!refElements.has(ariaRef.ref)) refElements.set(ariaRef.ref, new WeakRef(element));
	ariaNode.ref = ariaRef.ref;
}

function toAriaNode(element: Element, nameSourceElements: Map<AriaNode, Set<Element> | undefined>): AriaNode | null {
	const active = element.ownerDocument.activeElement === element && element.ownerDocument.hasFocus();
	if (element.nodeName === "IFRAME" || element.nodeName === "FRAME") {
		const ariaNode: AriaNode = {
			role: "iframe",
			name: "",
			children: [],
			props: {},
			box: computeBox(element),
			receivesPointerEvents: true,
			active,
		};
		setAriaNodeElement(ariaNode, element);
		// Bonobo Senate: every frame gets a ref, so the plugin text can be pasted under its line.
		computeAriaRef(ariaNode, true);
		return ariaNode;
	}

	const defaultRole = options.includeGenericRole ? "generic" : null;
	const role = getAriaRole(element) ?? defaultRole;
	if (!role || role === "presentation" || role === "none") return null;

	const name = getElementAccessibleName(element, false);
	const pointerEvents = receivesPointerEvents(element);

	const box = computeBox(element);
	if (
		role === "generic" &&
		box.inline &&
		element.childNodes.length === 1 &&
		element.childNodes[0].nodeType === Node.TEXT_NODE
	)
		return null;

	const result: AriaNode = {
		role,
		name: normalizeWhiteSpace(name.text),
		children: [],
		props: {},
		box,
		receivesPointerEvents: pointerEvents,
		active,
	};
	setAriaNodeElement(result, element);
	nameSourceElements.set(result, name.elements);
	computeAriaRef(result, false);

	if (kAriaCheckedRoles.includes(role)) result.checked = getAriaChecked(element);

	if (kAriaDisabledRoles.includes(role)) result.disabled = getAriaDisabled(element);

	if (kAriaExpandedRoles.includes(role)) result.expanded = getAriaExpanded(element);

	if (kAriaInvalidRoles.includes(role)) {
		const invalid = getAriaInvalid(element);
		result.invalid = invalid === "false" ? false : invalid === "true" ? true : invalid;
	}

	if (kAriaLevelRoles.includes(role)) result.level = getAriaLevel(element);

	if (kAriaPressedRoles.includes(role)) result.pressed = getAriaPressed(element);

	if (kAriaSelectedRoles.includes(role)) result.selected = getAriaSelected(element);

	// Bonobo Senate: a locked Files row shows only its name, type, size and dates.
	if (element.getAttribute("data-file-locked") === "on") result.locked = true;

	if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
		// Bonobo Senate: a password, one-time code or card field prints a marker, not its value.
		if (element.type !== "checkbox" && element.type !== "radio" && element.type !== "file")
			result.children = [inputValueText(element)];
	}

	return result;
}

function renderAriaTreeAsJSON(ariaSnapshot: AriaSnapshot): AriaSnapshotJSON {
	const visit = (ariaNode: AriaNode, depth: number, renderCursorPointer: boolean): AriaNodeJSON => {
		// Bonobo Senate: a note line keeps its text as is.
		if (ariaNode.role === "note") return { role: "note", text: ariaNode.name };

		const node: AriaNodeJSON = { role: ariaNode.role as AriaNodeJSON["role"] };
		if (ariaNode.name) node.name = ariaNode.name;
		if (ariaNode.checked === "mixed" || ariaNode.checked === true) node.checked = ariaNode.checked;
		if (ariaNode.disabled) node.disabled = true;
		if (ariaNode.expanded) node.expanded = true;
		if (ariaNode.active && options.renderActive) node.active = true;
		if (ariaNode.invalid) node.invalid = ariaNode.invalid;
		if (ariaNode.level) node.level = ariaNode.level;
		if (ariaNode.pressed === "mixed" || ariaNode.pressed === true) node.pressed = ariaNode.pressed;
		if (ariaNode.selected === true) node.selected = true;
		if (ariaNode.locked) node.locked = true;
		if (ariaNode.ref) {
			node.ref = ariaNode.ref;
			if (renderCursorPointer && hasPointerCursor(ariaNode)) node.cursor = "pointer";
		}
		if (ariaNode.props.url !== undefined) node.url = ariaNode.props.url;
		if (ariaNode.props.placeholder !== undefined) node.placeholder = ariaNode.props.placeholder;
		if (ariaNode.props["aria-hidden"] !== undefined) node.ariaHidden = true;

		const singleTextChild =
			ariaNode.children.length === 1 && typeof ariaNode.children[0] === "string" ? ariaNode.children[0] : undefined;
		if (singleTextChild !== undefined) {
			node.text = singleTextChild;
		} else if (ariaNode.children.length) {
			const inCursorPointer = !!ariaNode.ref && renderCursorPointer && hasPointerCursor(ariaNode);
			node.children = ariaNode.children.map((child) => {
				if (typeof child === "string") return child;
				return visit(child, depth + 1, renderCursorPointer && !inCursorPointer);
			});
		}
		return node;
	};

	const json: AriaSnapshotJSON = [];
	const nodesToRender = ariaSnapshot.root.role === "fragment" ? ariaSnapshot.root.children : [ariaSnapshot.root];
	for (const nodeToRender of nodesToRender) {
		if (typeof nodeToRender === "string") json.push({ role: "text", text: nodeToRender });
		else json.push(visit(nodeToRender, 0, !!options.renderCursorPointer));
	}
	return json;
}

/**
 * Bonobo Senate: render a snapshot as the `ai` mode YAML text.
 */
export function renderAriaTree(ariaSnapshot: AriaSnapshot): string {
	return renderAriaSnapshotAsYaml(renderAriaTreeAsJSON(ariaSnapshot));
}

// Bonobo Senate: a WeakMap instead of a symbol property, so no `any` is needed.
const ariaNodeElements = new WeakMap<AriaNode, Element>();

function ariaNodeElement(ariaNode: AriaNode): Element | undefined {
	return ariaNodeElements.get(ariaNode);
}

function setAriaNodeElement(ariaNode: AriaNode, element: Element) {
	ariaNodeElements.set(ariaNode, element);
}
