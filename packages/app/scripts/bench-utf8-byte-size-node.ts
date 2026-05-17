import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import stringByteLength from "string-byte-length";

const KIB = 1024;
const MIB = 1024 * KIB;
const SAMPLE_COUNT = 3;
const SAMPLE_DURATION_MS = 80;
const WARMUP_DURATION_MS = 20;

type ByteSizeImplementation = {
	name: string;
	getByteSize: (content: string) => number;
};

const textEncoder = new TextEncoder();

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
			"# Project Notes",
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
			"# Résumé – Q2",
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

const implementations = [
	{ name: "custom loop", getByteSize: get_utf8_byte_size_custom },
	{ name: "string-byte-length", getByteSize: stringByteLength },
	{ name: "Buffer.byteLength", getByteSize: (content) => Buffer.byteLength(content, "utf8") },
	{ name: "TextEncoder.encode", getByteSize: (content) => textEncoder.encode(content).byteLength },
	{ name: "TextEncoder.encodeInto", getByteSize: create_text_encoder_encode_into_byte_size() },
] satisfies ByteSizeImplementation[];

function run_for_duration(implementation: ByteSizeImplementation, content: string, durationMs: number) {
	let iterations = 0;
	let checksum = 0;
	const startedAt = performance.now();
	let elapsedMs = 0;

	do {
		checksum += implementation.getByteSize(content);
		iterations++;
		elapsedMs = performance.now() - startedAt;
	} while (elapsedMs < durationMs);

	return { checksum, elapsedMs, iterations };
}

function median(values: number[]) {
	const sortedValues = [...values].sort((a, b) => a - b);
	return sortedValues[Math.floor(sortedValues.length / 2)] ?? 0;
}

function benchmark_implementation(implementation: ByteSizeImplementation, content: string, expectedBytes: number) {
	const actualBytes = implementation.getByteSize(content);
	if (actualBytes !== expectedBytes) {
		throw new Error(`${implementation.name} returned ${actualBytes} bytes, expected ${expectedBytes}`);
	}

	run_for_duration(implementation, content, WARMUP_DURATION_MS);

	const mbPerSecondSamples = [];
	for (let sampleIndex = 0; sampleIndex < SAMPLE_COUNT; sampleIndex++) {
		const result = run_for_duration(implementation, content, SAMPLE_DURATION_MS);
		if (result.checksum === 0 && expectedBytes !== 0) {
			throw new Error(`${implementation.name} produced an impossible checksum`);
		}

		const seconds = result.elapsedMs / 1000;
		mbPerSecondSamples.push((expectedBytes * result.iterations) / seconds / MIB);
	}

	return median(mbPerSecondSamples);
}

for (const corpusSeed of corpusSeeds) {
	for (const targetSize of targetSizes) {
		const content = repeat_to_code_units(corpusSeed.seed, targetSize.codeUnits);
		const expectedBytes = Buffer.byteLength(content, "utf8");
		const results = implementations.map((implementation) => ({
			implementation: implementation.name,
			mbPerSecond: benchmark_implementation(implementation, content, expectedBytes),
		}));
		const customMbPerSecond = results.find((result) => result.implementation === "custom loop")?.mbPerSecond ?? 0;

		console.log(
			`\n${corpusSeed.name} / ${targetSize.name} (${content.length.toLocaleString()} code units, ${expectedBytes.toLocaleString()} UTF-8 bytes)`,
		);
		console.table(
			results.map((result) => ({
				implementation: result.implementation,
				"MiB/s": result.mbPerSecond.toFixed(1),
				"vs custom": customMbPerSecond === 0 ? "n/a" : `${(result.mbPerSecond / customMbPerSecond).toFixed(2)}x`,
			})),
		);
	}
}
