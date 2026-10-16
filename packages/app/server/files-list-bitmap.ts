export type files_list_bitmap_Container =
	| { kind: "sparse"; offsets: number[] }
	| { kind: "dense"; bytes: ArrayBuffer; count: number };

const BLOCK_SIZE = 8192;
const DENSE_COUNT = 512;
const DENSE_BYTES = BLOCK_SIZE / 8;

function check_offsets(offsets: readonly number[]) {
	if (offsets.length === 0 || offsets.length > BLOCK_SIZE) throw new RangeError("Invalid list bitmap offsets");
	for (let index = 0; index < offsets.length; index++) {
		const offset = offsets[index]!;
		if (
			!Number.isInteger(offset) ||
			offset < 0 ||
			offset >= BLOCK_SIZE ||
			(index > 0 && offset <= offsets[index - 1]!)
		) {
			throw new RangeError("Invalid list bitmap offsets");
		}
	}
}

function count_bits(bytes: Uint8Array) {
	let count = 0;
	for (let byte of bytes) {
		while (byte !== 0) {
			byte &= byte - 1;
			count++;
		}
	}
	return count;
}

/**
 * Empty blocks have no record. Sparse and dense blocks describe the same 8,192-ID range.
 */
export function files_list_bitmap_from_offsets(input: readonly number[]): files_list_bitmap_Container {
	const offsets = [...input].sort((a, b) => a - b);
	check_offsets(offsets);
	if (offsets.length < DENSE_COUNT) return { kind: "sparse", offsets };

	const bytes = new Uint8Array(DENSE_BYTES);
	for (const offset of offsets) bytes[offset >> 3] = bytes[offset >> 3]! | (1 << (offset & 7));
	return { kind: "dense", bytes: bytes.buffer, count: offsets.length };
}

export function files_list_bitmap_offsets(container: files_list_bitmap_Container) {
	if (container.kind === "sparse") return container.offsets.slice();

	const bytes = new Uint8Array(container.bytes);
	const offsets: number[] = [];
	for (let offset = 0; offset < BLOCK_SIZE; offset++) {
		if ((bytes[offset >> 3]! & (1 << (offset & 7))) !== 0) offsets.push(offset);
	}
	return offsets;
}

/**
 * The tag and count take three bytes. Counts and sparse offsets use big-endian uint16.
 */
export function files_list_bitmap_encode(container: files_list_bitmap_Container) {
	if (container.kind === "sparse") {
		check_offsets(container.offsets);
		if (container.offsets.length >= DENSE_COUNT) throw new RangeError("Invalid sparse list bitmap");
		const bytes = new ArrayBuffer(3 + container.offsets.length * 2);
		const view = new DataView(bytes);
		view.setUint8(0, 0);
		view.setUint16(1, container.offsets.length);
		for (let index = 0; index < container.offsets.length; index++) {
			view.setUint16(3 + index * 2, container.offsets[index]!);
		}
		return bytes;
	}

	const source = new Uint8Array(container.bytes);
	if (
		source.byteLength !== DENSE_BYTES ||
		container.count < DENSE_COUNT ||
		container.count > BLOCK_SIZE ||
		count_bits(source) !== container.count
	) {
		throw new RangeError("Invalid dense list bitmap");
	}
	const bytes = new ArrayBuffer(3 + DENSE_BYTES);
	const view = new DataView(bytes);
	view.setUint8(0, 1);
	view.setUint16(1, container.count);
	new Uint8Array(bytes, 3).set(source);
	return bytes;
}

/**
 * Decode one block from a packed page. The page reader checks its remaining records and end.
 */
export function files_list_bitmap_decode(bytes: ArrayBuffer, offset: number) {
	if (!Number.isInteger(offset) || offset < 0 || offset + 3 > bytes.byteLength) {
		throw new RangeError("Invalid list bitmap header");
	}
	const view = new DataView(bytes, offset);
	const tag = view.getUint8(0);
	const count = view.getUint16(1);
	if (count === 0 || count > BLOCK_SIZE || (tag !== 0 && tag !== 1)) {
		throw new RangeError("Invalid list bitmap header");
	}

	const bytesRead = 3 + (tag === 0 ? count * 2 : DENSE_BYTES);
	if (bytesRead > view.byteLength) throw new RangeError("Incomplete list bitmap");
	let container: files_list_bitmap_Container;
	if (tag === 0) {
		if (count >= DENSE_COUNT) throw new RangeError("Invalid sparse list bitmap");
		const offsets = Array.from({ length: count }, (_, index) => view.getUint16(3 + index * 2));
		check_offsets(offsets);
		container = { kind: "sparse", offsets };
	} else {
		if (count < DENSE_COUNT) throw new RangeError("Invalid dense list bitmap");
		// Keep each decoded block separate from the page buffer and other retained versions.
		const block = bytes.slice(offset + 3, offset + bytesRead);
		if (count_bits(new Uint8Array(block)) !== count) throw new RangeError("Invalid dense list bitmap");
		container = { kind: "dense", bytes: block, count };
	}
	return { container, bytesRead };
}
