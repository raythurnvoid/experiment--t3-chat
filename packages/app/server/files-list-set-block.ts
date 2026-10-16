import {
	files_list_bitmap_from_offsets,
	files_list_bitmap_offsets,
	type files_list_bitmap_Container,
} from "./files-list-bitmap.ts";

/**
 * Combine one matching 8,192-ID block. Empty blocks have no stored record.
 * The set directory and the set stream check the namespace, ID kind and block key before this step.
 */
export function files_list_set_block_combine(args: {
	left: files_list_bitmap_Container | null;
	right: files_list_bitmap_Container | null;
	operation: "union" | "intersection" | "difference";
}) {
	const left = args.left === null ? [] : files_list_bitmap_offsets(args.left);
	const right = args.right === null ? [] : files_list_bitmap_offsets(args.right);
	const offsets: number[] = [];
	let leftIndex = 0;
	let rightIndex = 0;
	while (leftIndex < left.length || rightIndex < right.length) {
		const a = left[leftIndex];
		const b = right[rightIndex];
		if (a !== undefined && (b === undefined || a < b)) {
			if (args.operation !== "intersection") offsets.push(a);
			leftIndex++;
		} else if (b !== undefined && (a === undefined || b < a)) {
			if (args.operation === "union") offsets.push(b);
			rightIndex++;
		} else {
			if (args.operation !== "difference") offsets.push(a!);
			leftIndex++;
			rightIndex++;
		}
	}
	return offsets.length === 0 ? null : files_list_bitmap_from_offsets(offsets);
}
