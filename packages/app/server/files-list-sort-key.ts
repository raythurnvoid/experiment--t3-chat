import type { files_sort_RowKey, files_sort_Sort } from "../shared/files-sort.ts";

function write_text(bytes: number[], value: string) {
	// Zero ends a string. Escape a stored zero so prefixes keep their order.
	for (const byte of new TextEncoder().encode(value)) {
		if (byte === 0) bytes.push(0, 255);
		else bytes.push(byte);
	}
	bytes.push(0, 0);
}

function write_number(bytes: number[], value: number) {
	if (Number.isNaN(value)) throw new RangeError("Invalid list sort number");
	const encoded = new Uint8Array(8);
	new DataView(encoded.buffer).setFloat64(0, value);
	// The sign bit and negative bytes need flipping to keep numeric order.
	const negative = (encoded[0]! & 128) !== 0;
	if (!negative) encoded[0] = encoded[0]! ^ 128;
	for (const byte of encoded) bytes.push(negative ? 255 - byte : byte);
}

function write_tuple(bytes: number[], values: ReadonlyArray<string | number | null>) {
	for (const value of values) {
		if (value === null) bytes.push(16);
		else if (typeof value === "number") {
			bytes.push(48);
			write_number(bytes, value);
		} else {
			bytes.push(80);
			write_text(bytes, value);
		}
	}
	bytes.push(0);
}

/**
 * Keep the table comparator and original creation-time/node-ID ties in byte order.
 * Missing values stay last and use name ascending. The caller keeps kind groups separate.
 */
export function files_list_sort_key_encode(args: {
	key: files_sort_RowKey;
	sort: files_sort_Sort;
	createdAt: number;
	nodeId: string;
}) {
	const part = args.key.parts[0]!;
	const missing = part === null;
	const bytes = [missing ? 1 : 0];
	write_tuple(bytes, missing ? args.key.nameKey : part);
	write_tuple(bytes, [args.createdAt, args.nodeId]);
	if (!missing && args.sort[0]!.direction === "desc") {
		for (let index = 1; index < bytes.length; index++) bytes[index] = 255 - bytes[index]!;
	}
	return Uint8Array.from(bytes).buffer;
}
