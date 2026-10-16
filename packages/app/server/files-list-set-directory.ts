// Many small ID sets, stored in packed pages (`files_list_set_pages`). A page never changes after insert.
// An edit saves new pages, so an old root stays readable while a hold or another page has an edge to it.
// `files_list_set_edges` stores those edges. Each new or released page gets a `files_list_set_cleanup_tasks`
// doc. The cleanup step deletes a page only when no edge points to it.

import { compareValues, getDocumentSize } from "convex/values";
import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server.js";
import { should_never_happen } from "../shared/shared-utils.ts";
import {
	files_list_bitmap_decode,
	files_list_bitmap_encode,
	files_list_bitmap_from_offsets,
	files_list_bitmap_offsets,
	type files_list_bitmap_Container,
} from "./files-list-bitmap.ts";
import { files_list_set_block_combine } from "./files-list-set-block.ts";

type Scope = Pick<Doc<"files_list_set_pages">, "namespace" | "family">;
type PageId = Id<"files_list_set_pages">;
type Root = PageId | null;
type Owner = Doc<"files_list_set_edges">["owner"];
// A page holds bitmap blocks of one large set, set records keyed by owner ID, or child page ranges.
type Kind = keyof typeof PAGE_TAGS;
type Item = { key: bigint; value: files_list_bitmap_Container | files_list_set_directory_Set | PageId };
type Page = { kind: Kind; level: number; items: Item[] };

/**
 * `ownerKind` and `memberKind` must match the family. A handle built for the wrong ID space fails before any read.
 */
export type files_list_set_directory_Handle = Scope & {
	ownerKind: "policy" | "audience";
	memberKind: "entry" | "policy";
	root: Root;
};

export type files_list_set_directory_Set =
	| { kind: "inline"; ids: bigint[] }
	| { kind: "bitmap"; root: PageId; count: bigint };

// The first header byte stores the page kind's tag. Saved pages keep these numbers, so never change them.
const PAGE_TAGS = { bitmap: 1, set: 2, branch: 3 } as const;
const PAGE_BYTES = 8192;
const PAGE_HEADER_BYTES = 4;
const MIN_WEIGHT = 3072;
const DOCUMENT_BYTES = 12288;
const MAX_PAGE_REFS = 32;
const BRANCH_MAX = 16;
const BRANCH_MIN = 8;
// A set with more members is stored as its own bitmap tree.
const INLINE_MAX = 64;
// Split member IDs into 8,192-ID bitmap blocks. The block key is `id >> 13n` and the offset is `id & 8191n`.
const BLOCK_SHIFT = 13n;
const BLOCK_MASK = 8191n;
const id_kinds = {
	policy_entries: { owner: "policy", member: "entry" },
	audience_policies: { owner: "audience", member: "policy" },
} as const;

function check_scope(stored: Scope, scope: Scope) {
	if (stored.family !== scope.family || compareValues(stored.namespace, scope.namespace) !== 0) {
		throw should_never_happen("List set namespace or family mismatch", { stored, scope });
	}
}

function check_handle(handle: files_list_set_directory_Handle, scope: Scope) {
	check_scope(handle, scope);
	if (handle.ownerKind !== id_kinds[scope.family].owner || handle.memberKind !== id_kinds[scope.family].member) {
		throw should_never_happen("List set ID kind mismatch", { handle, scope });
	}
}

function check_id(id: bigint) {
	if (id < 0n || id >= 1n << 63n) throw new RangeError("List set ID must be a nonnegative int64");
}

function check_block_key(key: bigint) {
	if (key < 0n || key >= 1n << (63n - BLOCK_SHIFT))
		throw new RangeError("List set block key must come from a nonnegative int64 ID");
}

function set_value(item: Item): files_list_set_directory_Set {
	if (typeof item.value === "string" || (item.value.kind !== "inline" && item.value.kind !== "bitmap")) {
		throw should_never_happen("Expected a list set record", { key: item.key });
	}

	return item.value;
}

function bitmap_value(item: Item): files_list_bitmap_Container {
	if (typeof item.value === "string" || (item.value.kind !== "sparse" && item.value.kind !== "dense")) {
		throw should_never_happen("Expected a list bitmap record", { key: item.key });
	}

	return item.value;
}

function child_value(item: Item): PageId {
	if (typeof item.value !== "string") {
		throw should_never_happen("Expected a list set child page", { key: item.key });
	}

	return item.value;
}

/**
 * Count the stored bytes of one record, key included. `read_page` describes the layout.
 */
function record_bytes(kind: Kind, item: Item) {
	if (kind === "branch") return 9;
	if (kind === "bitmap") {
		const value = bitmap_value(item);
		return value.kind === "dense" ? 1035 : 11 + value.offsets.length * 2;
	}

	const value = set_value(item);
	return value.kind === "inline" ? 10 + value.ids.length * 8 : 18;
}

function record_weight(kind: Kind, item: Item) {
	// A bitmap record also adds one child reference. A weight of 256 keeps a full page at 32 references
	// (8,192 / 256). This weight is not the stored byte count.
	return kind === "set" && set_value(item).kind === "bitmap" ? 256 : record_bytes(kind, item);
}

function page_size(page: Page, measure: typeof record_bytes) {
	return page.items.reduce((total, item) => total + measure(page.kind, item), 0);
}

function fits(page: Page) {
	return (
		PAGE_HEADER_BYTES + page_size(page, record_weight) <= PAGE_BYTES &&
		(page.kind !== "branch" || page.items.length <= BRANCH_MAX)
	);
}

function underfull(page: Page) {
	return page.kind === "branch" ? page.items.length < BRANCH_MIN : page_size(page, record_weight) < MIN_WEIGHT;
}

async function retain(db: MutationCtx["db"], owner: Owner, target: PageId, scope: Scope) {
	// Reading the target makes a concurrent delete conflict with this new reference.
	const page = await db.get("files_list_set_pages", target);
	if (!page) throw should_never_happen("Cannot retain a missing list set page", { target });
	check_scope(page, scope);
	await db.insert("files_list_set_edges", { namespace: scope.namespace, family: scope.family, owner, target });
}

async function release(db: MutationCtx["db"], owner: Owner, scope: Scope) {
	// A hold owns one edge. A page owns at most 32 edges, because `save_page` refuses more. Read one more edge
	// to catch a broken bound. The index range matches namespace and family exactly, so each edge needs no
	// scope check.
	const edges = await db
		.query("files_list_set_edges")
		.withIndex("by_namespace_family_owner", (q) =>
			q.eq("namespace", scope.namespace).eq("family", scope.family).eq("owner", owner),
		)
		.take(owner.kind === "hold" ? 2 : MAX_PAGE_REFS + 1);
	if (edges.length > (owner.kind === "hold" ? 1 : MAX_PAGE_REFS)) {
		throw should_never_happen("Too many list set owning edges", { owner });
	}

	for (const edge of edges) {
		await db.delete("files_list_set_edges", edge._id);
		await db.insert("files_list_set_cleanup_tasks", {
			namespace: scope.namespace,
			family: scope.family,
			target: edge.target,
		});
	}
}

/**
 * A hold belongs to a server-owned head, capture or writer. It is not a public cursor.
 * Replace the hold in the same mutation that publishes a new root. Namespace checks do not authorize access.
 */
export async function files_list_set_directory_db_hold(
	db: MutationCtx["db"],
	args: { scope: Scope; handle: files_list_set_directory_Handle; hold: Extract<Owner, { kind: "hold" }> },
) {
	check_handle(args.handle, args.scope);
	await release(db, args.hold, args.scope);
	if (args.handle.root !== null) await retain(db, args.hold, args.handle.root, args.scope);
}

/**
 * A page body starts with a 4-byte header: the kind's tag, a zero byte, and a uint16 item count.
 * Each item then has a uint64 key and one record. All numbers are big-endian.
 *
 * - bitmap: one block from `files_list_bitmap_encode`.
 * - set: tag 0, a count byte and up to 64 uint64 IDs (inline). Or tag 1, a uint64 count and a child index
 *   byte (a bitmap root).
 * - branch: one child index byte.
 *
 * A child index points into the doc's `children` array. `save_page` adds one edge for each child.
 */
async function read_page(db: QueryCtx["db"], id: PageId, scope: Scope): Promise<Page> {
	const doc = await db.get("files_list_set_pages", id);
	if (!doc) throw should_never_happen("Missing retained list set page", { id });
	check_scope(doc, scope);
	if (doc.body.byteLength < PAGE_HEADER_BYTES || doc.body.byteLength > PAGE_BYTES) {
		throw should_never_happen("Invalid list set page length", { id });
	}

	const view = new DataView(doc.body);
	const kind = (Object.keys(PAGE_TAGS) as Kind[]).find((name) => PAGE_TAGS[name] === view.getUint8(0));
	if (!kind || view.getUint8(1) !== 0) {
		throw should_never_happen("Invalid list set page header", { id });
	}

	const items: Item[] = [];
	let position = PAGE_HEADER_BYTES;
	for (let index = 0; index < view.getUint16(2); index++) {
		const key = view.getBigUint64(position);
		position += 8;
		if (kind === "bitmap") {
			const block = files_list_bitmap_decode(doc.body, position);
			position += block.bytesRead;
			items.push({ key, value: block.container });
		} else if (kind === "branch") {
			const child = doc.children[view.getUint8(position++)];
			if (!child) throw should_never_happen("Missing list set branch reference", { id });
			items.push({ key, value: child });
		} else {
			const tag = view.getUint8(position++);
			if (tag === 0) {
				const count = view.getUint8(position++);
				if (count < 1 || count > INLINE_MAX) throw should_never_happen("Invalid inline list set count", { id });
				const ids: bigint[] = [];
				for (let member = 0; member < count; member++) {
					ids.push(view.getBigUint64(position));
					position += 8;
				}
				items.push({ key, value: { kind: "inline", ids } });
			} else if (tag === 1) {
				const count = view.getBigUint64(position);
				position += 8;
				const root = doc.children[view.getUint8(position++)];
				if (!root || count <= BigInt(INLINE_MAX)) throw should_never_happen("Invalid list bitmap root", { id });
				items.push({ key, value: { kind: "bitmap", root, count } });
			} else {
				throw should_never_happen("Invalid list set record tag", { id });
			}
		}
	}
	if (position !== doc.body.byteLength) throw should_never_happen("Invalid list set page end", { id });
	return { kind, level: doc.level, items };
}

async function save_page(db: MutationCtx["db"], page: Page, scope: Scope) {
	if (!page.items.length || !fits(page)) throw should_never_happen("List set page does not fit", { level: page.level });

	const body = new ArrayBuffer(PAGE_HEADER_BYTES + page_size(page, record_bytes));
	const view = new DataView(body);
	view.setUint8(0, PAGE_TAGS[page.kind]);
	view.setUint16(2, page.items.length);
	const children: PageId[] = [];
	let position = PAGE_HEADER_BYTES;
	for (const item of page.items) {
		view.setBigUint64(position, item.key);
		position += 8;
		if (page.kind === "bitmap") {
			const encoded = files_list_bitmap_encode(bitmap_value(item));
			new Uint8Array(body, position, encoded.byteLength).set(new Uint8Array(encoded));
			position += encoded.byteLength;
		} else if (page.kind === "branch") {
			view.setUint8(position++, children.length);
			children.push(child_value(item));
		} else {
			const value = set_value(item);
			if (value.kind === "inline") {
				view.setUint8(position++, 0);
				view.setUint8(position++, value.ids.length);
				for (const id of value.ids) {
					view.setBigUint64(position, id);
					position += 8;
				}
			} else {
				view.setUint8(position++, 1);
				view.setBigUint64(position, value.count);
				position += 8;
				view.setUint8(position++, children.length);
				children.push(value.root);
			}
		}
	}

	if (children.length > MAX_PAGE_REFS) {
		throw should_never_happen("Too many list set page references", { level: page.level });
	}

	const id = await db.insert("files_list_set_pages", {
		namespace: scope.namespace,
		family: scope.family,
		body,
		level: page.level,
		children,
	});

	// Read the inserted doc back to check its full stored size. The namespace, the children and the system fields
	// add bytes on top of the body.
	const doc = await db.get("files_list_set_pages", id);
	if (!doc || getDocumentSize(doc) > DOCUMENT_BYTES) {
		throw should_never_happen("Stored list set page exceeds its byte bound", { id });
	}

	for (const child of children) await retain(db, { kind: "page", pageId: id }, child, scope);
	await db.insert("files_list_set_cleanup_tasks", { namespace: scope.namespace, family: scope.family, target: id });

	return id;
}

async function save_parts(db: MutationCtx["db"], page: Page, scope: Scope): Promise<Item[]> {
	if (!page.items.length) return [];
	if (fits(page)) return [{ key: page.items[0]!.key, value: await save_page(db, page, scope) }];

	let cut = Math.floor(page.items.length / 2);
	if (page.kind !== "branch") {
		let used = 0;
		cut = 0;
		while (used < MIN_WEIGHT) used += record_weight(page.kind, page.items[cut++]!);
	}
	const left = { ...page, items: page.items.slice(0, cut) };
	const right = { ...page, items: page.items.slice(cut) };
	if (underfull(left) || underfull(right)) {
		throw should_never_happen("List set split is underfull", { kind: page.kind });
	}
	return [
		{ key: left.items[0]!.key, value: await save_page(db, left, scope) },
		{ key: right.items[0]!.key, value: await save_page(db, right, scope) },
	];
}

function child_at(items: Item[], key: bigint) {
	let index = 0;
	while (index + 1 < items.length && items[index + 1]!.key <= key) index++;
	return index;
}

async function edit_page(
	db: MutationCtx["db"],
	id: PageId,
	key: bigint,
	value: files_list_bitmap_Container | files_list_set_directory_Set | null,
	kind: "bitmap" | "set",
	scope: Scope,
): Promise<Item[]> {
	const page = await read_page(db, id, scope);
	if (page.kind !== "branch") {
		if (page.kind !== kind) throw should_never_happen("Wrong list set page kind", { id });
		const index = page.items.findIndex((item) => item.key >= key);
		if (index >= 0 && page.items[index]!.key === key) {
			if (value === null) page.items.splice(index, 1);
			else page.items[index] = { key, value };
		} else if (value !== null) {
			page.items.splice(index < 0 ? page.items.length : index, 0, { key, value });
		} else {
			return [{ key: page.items[0]!.key, value: id }];
		}
		return save_parts(db, page, scope);
	}

	const index = child_at(page.items, key);
	const changed = await edit_page(db, child_value(page.items[index]!), key, value, kind, scope);
	page.items.splice(index, 1, ...changed);

	// A child that became too small merges with a neighbor. If the merged items do not fit, `save_parts` splits
	// them again into two pages that are both big enough.
	if (changed.length === 1 && page.items.length > 1) {
		const child = await read_page(db, child_value(changed[0]!), scope);
		if (underfull(child)) {
			const first = index > 0 ? index - 1 : index;
			const left = first === index ? child : await read_page(db, child_value(page.items[first]!), scope);
			const right = first === index ? await read_page(db, child_value(page.items[first + 1]!), scope) : child;
			page.items.splice(
				first,
				2,
				...(await save_parts(db, { ...left, items: [...left.items, ...right.items] }, scope)),
			);
		}
	}
	return save_parts(db, page, scope);
}

async function edit_root(
	db: MutationCtx["db"],
	root: Root,
	key: bigint,
	value: files_list_bitmap_Container | files_list_set_directory_Set | null,
	kind: "bitmap" | "set",
	scope: Scope,
): Promise<Root> {
	if (root === null) return value === null ? null : save_page(db, { kind, level: 0, items: [{ key, value }] }, scope);
	const parts = await edit_page(db, root, key, value, kind, scope);
	if (!parts.length) return null;
	let next =
		parts.length === 1
			? child_value(parts[0]!)
			: await save_page(
					db,
					{ kind: "branch", level: (await read_page(db, child_value(parts[0]!), scope)).level + 1, items: parts },
					scope,
				);

	// A merge can leave a branch with one child. Use that child as the root, so the tree does not keep empty levels.
	while (true) {
		const page = await read_page(db, next, scope);
		if (page.kind !== "branch" || page.items.length !== 1) return next;
		next = child_value(page.items[0]!);
	}
}

/**
 * Group member IDs into 8,192-ID bitmap block records. Sorted IDs give the blocks in key order.
 */
function id_blocks(ids: bigint[]) {
	const blocks = new Map<bigint, number[]>();
	for (const id of ids) {
		const block = id >> BLOCK_SHIFT;
		const members = blocks.get(block) ?? [];
		members.push(Number(id & BLOCK_MASK));
		blocks.set(block, members);
	}
	return [...blocks].map(([key, members]) => ({ key, value: files_list_bitmap_from_offsets(members) }));
}

async function find_item(
	db: QueryCtx["db"],
	root: Root,
	key: bigint,
	kind: "bitmap" | "set",
	scope: Scope,
): Promise<Item | null> {
	if (root === null) return null;
	const page = await read_page(db, root, scope);
	if (page.kind === "branch") {
		return find_item(db, child_value(page.items[child_at(page.items, key)]!), key, kind, scope);
	}
	if (page.kind !== kind) throw should_never_happen("Wrong list set page kind", { root });
	return page.items.find((item) => item.key === key) ?? null;
}

/**
 * Find the first bitmap block with a key above `after`. Read the cursor path first. If that path has no key above
 * `after`, read the leftmost path of the next child. A tree of height H costs at most 2H - 1 page reads.
 */
async function next_item(db: QueryCtx["db"], root: PageId, after: bigint | null, scope: Scope): Promise<Item | null> {
	const page = await read_page(db, root, scope);
	if (page.kind !== "branch") {
		if (page.kind !== "bitmap") throw should_never_happen("Wrong list set page kind", { root });
		return page.items.find((item) => after === null || item.key > after) ?? null;
	}

	// A branch key is the smallest key of its child, and pages are never empty. So every child after the cursor's
	// child has a key above `after`, and this loop reads at most two children.
	for (let index = after === null ? 0 : child_at(page.items, after); index < page.items.length; index++) {
		const item = await next_item(db, child_value(page.items[index]!), after, scope);
		if (item !== null) return item;
	}
	return null;
}

export async function files_list_set_directory_db_lookup(
	db: QueryCtx["db"],
	args: { scope: Scope; handle: files_list_set_directory_Handle; ownerId: bigint },
): Promise<files_list_set_directory_Set | null> {
	check_handle(args.handle, args.scope);
	check_id(args.ownerId);
	const item = await find_item(db, args.handle.root, args.ownerId, "set", args.scope);
	return item === null ? null : set_value(item);
}

/**
 * Return one 8,192-ID block of a set, or null when the set has no member in it.
 */
export async function files_list_set_directory_db_block_at(
	db: QueryCtx["db"],
	args: { scope: Scope; handle: files_list_set_directory_Handle; ownerId: bigint; key: bigint },
) {
	check_block_key(args.key);
	const value = await files_list_set_directory_db_lookup(db, args);
	if (value === null) return null;
	const item =
		value.kind === "inline"
			? id_blocks(value.ids).find((block) => block.key === args.key)
			: await find_item(db, value.root, args.key, "bitmap", args.scope);
	return item ? bitmap_value(item) : null;
}

export async function files_list_set_directory_db_has(
	db: QueryCtx["db"],
	args: { scope: Scope; handle: files_list_set_directory_Handle; ownerId: bigint; memberId: bigint },
) {
	check_id(args.memberId);
	const block = await files_list_set_directory_db_block_at(db, { ...args, key: args.memberId >> BLOCK_SHIFT });
	return block !== null && files_list_bitmap_offsets(block).includes(Number(args.memberId & BLOCK_MASK));
}

/**
 * Return the first block of a set with a key above `after`, or null when no block is left.
 * One call reads one directory path and, for a bitmap set of height H, at most 2H - 1 set pages.
 * An inline set reads only the directory path.
 */
export async function files_list_set_directory_db_next_block(
	db: QueryCtx["db"],
	args: { scope: Scope; handle: files_list_set_directory_Handle; ownerId: bigint; after: bigint | null },
) {
	if (args.after !== null) check_block_key(args.after);
	const value = await files_list_set_directory_db_lookup(db, args);
	if (value === null) return null;
	const item =
		value.kind === "inline"
			? id_blocks(value.ids).find((block) => args.after === null || block.key > args.after)
			: await next_item(db, value.root, args.after, args.scope);
	return item ? { key: item.key, container: bitmap_value(item) } : null;
}

async function edit_set(
	db: MutationCtx["db"],
	value: files_list_set_directory_Set | null,
	memberId: bigint,
	enabled: boolean,
	scope: Scope,
): Promise<files_list_set_directory_Set | null> {
	if (value === null || value.kind === "inline") {
		const ids = value?.ids ?? [];
		if (ids.includes(memberId) === enabled) return value;
		const next = enabled
			? [...ids, memberId].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
			: ids.filter((id) => id !== memberId);
		if (!next.length) return null;
		if (next.length <= INLINE_MAX) return { kind: "inline", ids: next };

		// Promotion has exactly 65 IDs. Even 65 separate blocks take only 65 * 13 bytes, so save them as one
		// bitmap leaf. `next` is sorted, so the blocks come out in key order.
		const root = await save_page(db, { kind: "bitmap", level: 0, items: id_blocks(next) }, scope);
		return { kind: "bitmap", root, count: BigInt(next.length) };
	}

	const block = memberId >> BLOCK_SHIFT;
	const item = await find_item(db, value.root, block, "bitmap", scope);
	const old = item === null ? null : bitmap_value(item);
	const offset = Number(memberId & BLOCK_MASK);
	if ((old !== null && files_list_bitmap_offsets(old).includes(offset)) === enabled) return value;
	const next = files_list_set_block_combine({
		left: old,
		right: files_list_bitmap_from_offsets([offset]),
		operation: enabled ? "union" : "difference",
	});
	const root = await edit_root(db, value.root, block, next, "bitmap", scope);
	const count = value.count + (enabled ? 1n : -1n);
	if (root === null) throw should_never_happen("Large list set lost its root");
	if (count > BigInt(INLINE_MAX)) return { kind: "bitmap", root, count };

	// At 64 members, all block records take at most 64 * 13 bytes. Only a root leaf can be this small.
	const page = await read_page(db, root, scope);
	if (page.kind !== "bitmap") throw should_never_happen("List set demotion must have one bitmap leaf", { root });
	const ids = page.items.flatMap((item) =>
		files_list_bitmap_offsets(bitmap_value(item)).map((offset) => (item.key << BLOCK_SHIFT) + BigInt(offset)),
	);
	if (BigInt(ids.length) !== count || ids.length > INLINE_MAX) {
		throw should_never_happen("List set demotion count mismatch", { root, count });
	}
	return { kind: "inline", ids };
}

/**
 * Owner and member IDs are stable, never reused, and include zero. The caller owns their allocation.
 * Read a held input root and hold or publish the returned root in this same mutation.
 * Auth, current-root checks and writer reservations belong to that caller.
 */
export async function files_list_set_directory_db_update(
	db: MutationCtx["db"],
	args: { scope: Scope; handle: files_list_set_directory_Handle; ownerId: bigint; memberId: bigint; enabled: boolean },
): Promise<files_list_set_directory_Handle> {
	check_id(args.memberId);
	const value = await files_list_set_directory_db_lookup(db, args);
	const next = await edit_set(db, value, args.memberId, args.enabled, args.scope);
	if (next === value) return args.handle;
	return { ...args.handle, root: await edit_root(db, args.handle.root, args.ownerId, next, "set", args.scope) };
}

/**
 * Add a new logical owner from an existing set plus one member. Older owners keep their exact set.
 * The caller holds or publishes the returned root in this same mutation, as with update.
 */
export async function files_list_set_directory_db_derive(
	db: MutationCtx["db"],
	args: {
		scope: Scope;
		handle: files_list_set_directory_Handle;
		sourceOwnerId: bigint;
		ownerId: bigint;
		memberId: bigint;
	},
): Promise<files_list_set_directory_Handle> {
	check_id(args.memberId);
	check_id(args.ownerId);
	const source = await files_list_set_directory_db_lookup(db, { ...args, ownerId: args.sourceOwnerId });
	if (source === null) throw should_never_happen("Missing source list set", { ownerId: args.sourceOwnerId });
	if ((await files_list_set_directory_db_lookup(db, args)) !== null) {
		throw should_never_happen("Derived list set owner already exists", { ownerId: args.ownerId });
	}
	const next = await edit_set(db, source, args.memberId, true, args.scope);
	return { ...args.handle, root: await edit_root(db, args.handle.root, args.ownerId, next, "set", args.scope) };
}

/**
 * Take one cleanup task. Delete its page only when no edge points to it. Then add cleanup tasks for that
 * page's children. One step deletes at most 32 edges.
 *
 * A held page keeps its children alive. A new reference reads its target page, so adding a reference and
 * deleting that page in parallel conflict.
 */
export async function files_list_set_directory_db_cleanup_step(db: MutationCtx["db"], scope: Scope) {
	// The index range matches namespace and family exactly, so the task needs no scope check.
	const task = await db
		.query("files_list_set_cleanup_tasks")
		.withIndex("by_namespace_family", (q) => q.eq("namespace", scope.namespace).eq("family", scope.family))
		.first();
	if (!task) return { done: true, deleted: false };
	await db.delete("files_list_set_cleanup_tasks", task._id);
	const incoming = await db
		.query("files_list_set_edges")
		.withIndex("by_target", (q) => q.eq("target", task.target))
		.first();
	if (incoming) {
		check_scope(incoming, scope);
		return { done: false, deleted: false };
	}

	const page = await db.get("files_list_set_pages", task.target);
	if (!page) return { done: false, deleted: false };
	check_scope(page, scope);
	await db.delete("files_list_set_pages", page._id);
	await release(db, { kind: "page", pageId: page._id }, scope);
	return { done: false, deleted: true };
}
