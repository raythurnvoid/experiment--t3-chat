import { bench, describe, vi } from "vitest";

const KIB = 1024;
const MIB = 1024 * KIB;
const textEncoder = new TextEncoder();
const benchOptions = {
	time: 100,
	warmupTime: 20,
} as const;

type ByteSizeImplementation = {
	name: string;
	getByteSize: (content: string) => number;
};

type StringByteLengthGlobal = typeof globalThis & {
	Buffer?: {
		byteLength?: (string: string, encoding?: string) => number;
	};
};

async function import_byte_size_helpers_without_buffer() {
	const typedGlobal = globalThis as StringByteLengthGlobal;
	const buffer = typedGlobal.Buffer;
	const bufferByteLengthDescriptor = buffer ? Object.getOwnPropertyDescriptor(buffer, "byteLength") : undefined;

	try {
		vi.resetModules();
		if (buffer) {
			Reflect.deleteProperty(buffer, "byteLength");
		}

		const [filesModule, stringByteLengthModule] = await Promise.all([import("./files.ts"), import("string-byte-length")]);
		return {
			files_get_utf8_byte_size: filesModule.files_get_utf8_byte_size,
			stringByteLength: stringByteLengthModule.default,
		};
	} finally {
		if (buffer && bufferByteLengthDescriptor) {
			Object.defineProperty(buffer, "byteLength", bufferByteLengthDescriptor);
		} else if (buffer) {
			Reflect.deleteProperty(buffer, "byteLength");
		}
	}
}

function get_utf8_byte_size_custom(content: string) {
	let size = 0;

	for (let index = 0; index < content.length; index++) {
		const codeUnit = content.charCodeAt(index);

		if (codeUnit <= 0x7f) {
			size += 1;
		} else if (codeUnit <= 0x7ff) {
			size += 2;
		} else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const nextCodeUnit = content.charCodeAt(index + 1);
			if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
				size += 4;
				index++;
			} else {
				size += 3;
			}
		} else {
			size += 3;
		}
	}

	return size;
}

function create_text_encoder_encode_into_byte_size() {
	let buffer = new Uint8Array(0);

	return function get_text_encoder_encode_into_byte_size(content: string) {
		const requiredBytes = content.length * 3;
		if (buffer.byteLength < requiredBytes) {
			buffer = new Uint8Array(requiredBytes);
		}

		return textEncoder.encodeInto(content, buffer).written;
	};
}

function repeat_to_code_units(seed: string, targetCodeUnits: number) {
	return seed.repeat(Math.ceil(targetCodeUnits / seed.length)).slice(0, targetCodeUnits);
}

const corpusSeeds = [
	{
		name: "ascii markdown",
		seed: [
			"# Workspace Notes",
			"",
			"- Save the current draft",
			"- Compare byte counters",
			"",
			"```ts",
			"const value = 42;",
			"```",
			"",
		].join("\n"),
	},
	{
		name: "mixed markdown",
		seed: [
			"# Résumé - Q2",
			"",
			"Smart quotes, café notes, emoji 😀, and markdown links.",
			"",
			"> Measure bytes, not UTF-16 code units.",
			"",
		].join("\n"),
	},
	{
		name: "cjk heavy",
		seed: "项目记录\n这是一些中文内容，用来测试 UTF-8 字节长度。\n",
	},
	{
		name: "emoji heavy",
		seed: "😀🚀✨📄🧪 ".repeat(8),
	},
	{
		name: "invalid surrogate edge cases",
		seed: "valid\ud800 lone-high \udc00 lone-low \udc00\ud800 reversed\n",
	},
] satisfies Array<{ name: string; seed: string }>;

const targetSizes = [
	{ name: "small", codeUnits: KIB },
	{ name: "64 KiB", codeUnits: 64 * KIB },
	{ name: "512 KiB", codeUnits: 512 * KIB },
	{ name: "1 MiB", codeUnits: MIB },
] satisfies Array<{ name: string; codeUnits: number }>;

const noBufferHelpers = await import_byte_size_helpers_without_buffer();

const implementations = [
	{ name: "custom loop", getByteSize: get_utf8_byte_size_custom },
	{ name: "public helper no Buffer", getByteSize: noBufferHelpers.files_get_utf8_byte_size },
	{ name: "string-byte-length no Buffer", getByteSize: noBufferHelpers.stringByteLength },
	{ name: "TextEncoder.encode", getByteSize: (content) => textEncoder.encode(content).byteLength },
	{ name: "TextEncoder.encodeInto", getByteSize: create_text_encoder_encode_into_byte_size() },
] satisfies ByteSizeImplementation[];

describe("utf8 byte size edge runtime", () => {
	for (const corpusSeed of corpusSeeds) {
		for (const targetSize of targetSizes) {
			const content = repeat_to_code_units(corpusSeed.seed, targetSize.codeUnits);
			const expectedBytes = textEncoder.encode(content).byteLength;

			describe(`${corpusSeed.name} / ${targetSize.name}`, () => {
				for (const implementation of implementations) {
					bench(
						implementation.name,
						() => {
							const byteSize = implementation.getByteSize(content);
							if (byteSize !== expectedBytes) {
								throw new Error(
									`${implementation.name} returned ${byteSize} bytes, expected ${expectedBytes}`,
								);
							}
						},
						benchOptions,
					);
				}
			});
		}
	}
});
