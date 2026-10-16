// Read a set expression over the set directory one 8,192-ID block at a time. One step reads each leaf set at most
// once, so its cost grows with the number of leaves, not with the size of the sets. Between steps the caller keeps
// the expression and passes back only the last cursor.

import { compareValues } from "convex/values";
import type { QueryCtx } from "../convex/_generated/server.js";
import { should_never_happen } from "../shared/shared-utils.ts";
import type { files_list_bitmap_Container } from "./files-list-bitmap.ts";
import { files_list_set_block_combine } from "./files-list-set-block.ts";
import {
	files_list_set_directory_db_block_at,
	files_list_set_directory_db_next_block,
	type files_list_set_directory_Handle,
} from "./files-list-set-directory.ts";

type Namespace = files_list_set_directory_Handle["namespace"];
type MemberKind = files_list_set_directory_Handle["memberKind"];
type Step =
	| { kind: "block"; key: bigint; container: files_list_bitmap_Container }
	| { kind: "advance"; after: bigint }
	| { kind: "end" };

/**
 * A set expression over captured directory handles. A union of no inputs is empty.
 */
export type files_list_set_stream_Expr =
	| { kind: "set"; handle: files_list_set_directory_Handle; ownerId: bigint }
	| { kind: "union" | "intersection"; inputs: files_list_set_stream_Expr[] }
	| { kind: "difference"; left: files_list_set_stream_Expr; right: files_list_set_stream_Expr };

/**
 * Check every leaf before the first page read, so one expression never mixes ID spaces. The same namespace and
 * member kind do not grant access. The caller picks the sets the reader may use.
 *
 * The directory checks each block key before its first read.
 */
function check_domain(expr: files_list_set_stream_Expr, namespace: Namespace, memberKind: MemberKind) {
	if (expr.kind === "set") {
		if (compareValues(expr.handle.namespace, namespace) !== 0 || expr.handle.memberKind !== memberKind) {
			throw should_never_happen("List set stream domain mismatch", { handle: expr.handle, namespace, memberKind });
		}
		if (expr.ownerId < 0n || expr.ownerId >= 1n << 63n) throw new RangeError("List set ID must be a nonnegative int64");
	} else if (expr.kind === "difference") {
		check_domain(expr.left, namespace, memberKind);
		check_domain(expr.right, namespace, memberKind);
	} else {
		if (expr.kind === "intersection" && !expr.inputs.length) {
			throw should_never_happen("List set intersection needs an input");
		}
		for (const input of expr.inputs) check_domain(input, namespace, memberKind);
	}
}

function combine(containers: (files_list_bitmap_Container | null)[], operation: "union" | "intersection") {
	const [first = null, ...rest] = containers;
	return rest.reduce(
		(result, container) => files_list_set_block_combine({ left: result, right: container, operation }),
		first,
	);
}

async function block_at(
	db: QueryCtx["db"],
	expr: files_list_set_stream_Expr,
	key: bigint,
): Promise<files_list_bitmap_Container | null> {
	if (expr.kind === "set") {
		return files_list_set_directory_db_block_at(db, {
			scope: expr.handle,
			handle: expr.handle,
			ownerId: expr.ownerId,
			key,
		});
	}
	if (expr.kind === "difference") {
		const left = await block_at(db, expr.left, key);
		if (left === null) return null;
		return files_list_set_block_combine({ left, right: await block_at(db, expr.right, key), operation: "difference" });
	}

	return combine(await Promise.all(expr.inputs.map((input) => block_at(db, input, key))), expr.kind);
}

/**
 * Take one bounded step. Each leaf reads at most one successor block, or one point block on the right side of a
 * difference. An `advance` step has no block up to its new cursor. Its cursor is always above `after`.
 */
async function next(db: QueryCtx["db"], expr: files_list_set_stream_Expr, after: bigint | null): Promise<Step> {
	if (expr.kind === "set") {
		const block = await files_list_set_directory_db_next_block(db, {
			scope: expr.handle,
			handle: expr.handle,
			ownerId: expr.ownerId,
			after,
		});
		return block === null ? { kind: "end" } : { kind: "block", ...block };
	}

	if (expr.kind === "difference") {
		const left = await next(db, expr.left, after);
		if (left.kind !== "block") return left;
		const container = files_list_set_block_combine({
			left: left.container,
			right: await block_at(db, expr.right, left.key),
			operation: "difference",
		});
		return container === null ? { kind: "advance", after: left.key } : { ...left, container };
	}

	const steps = await Promise.all(expr.inputs.map((input) => next(db, input, after)));
	const blocks = steps.filter((step) => step.kind === "block");
	const advances = steps.filter((step) => step.kind === "advance").map((step) => step.after);

	if (expr.kind === "union") {
		const key = blocks.reduce<bigint | null>((low, block) => (low === null || block.key < low ? block.key : low), null);
		const advance = advances.reduce<bigint | null>((low, value) => (low === null || value < low ? value : low), null);

		// An advanced input has no block up to its cursor, but it may have one right after it. So the smallest block is
		// final only when it is not above any advanced cursor.
		if (key !== null && (advance === null || key <= advance)) {
			const container = combine(
				blocks.filter((block) => block.key === key).map((block) => block.container),
				"union",
			);
			return { kind: "block", key, container: container! };
		}
		return advance === null ? { kind: "end" } : { kind: "advance", after: advance };
	}

	if (steps.some((step) => step.kind === "end")) return { kind: "end" };
	const first = blocks[0];
	if (first && blocks.length === steps.length && blocks.every((block) => block.key === first.key)) {
		const container = combine(
			blocks.map((block) => block.container),
			"intersection",
		);
		// The inputs share this block key but no member in it. Continue after the block.
		return container === null ? { kind: "advance", after: first.key } : { ...first, container };
	}

	// Each input has no block below its own next possible key. So the intersection has none below the largest of them.
	const high = [...blocks.map((block) => block.key), ...advances.map((value) => value + 1n)].reduce((largest, value) =>
		value > largest ? value : largest,
	);
	return { kind: "advance", after: high - 1n };
}

/**
 * Read the next non-empty block of `expr` with a key above `after`. A `block` or `advance` step gives the next
 * cursor. Only `end` means no block is left. An `advance` step is not the end.
 */
export async function files_list_set_stream_db_next(
	db: QueryCtx["db"],
	args: { namespace: Namespace; memberKind: MemberKind; expr: files_list_set_stream_Expr; after: bigint | null },
) {
	check_domain(args.expr, args.namespace, args.memberKind);
	return next(db, args.expr, args.after);
}

/**
 * Read one block of `expr`, or null when the expression has no member in it.
 */
export async function files_list_set_stream_db_block_at(
	db: QueryCtx["db"],
	args: { namespace: Namespace; memberKind: MemberKind; expr: files_list_set_stream_Expr; key: bigint },
) {
	check_domain(args.expr, args.namespace, args.memberKind);
	return block_at(db, args.expr, args.key);
}
