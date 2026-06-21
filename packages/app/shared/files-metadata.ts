import { isAlias, isMap, isScalar, isSeq, parseDocument, type Node as YamlNode } from "yaml";
import { Result } from "./errors-as-values-utils.ts";

const FRONTMATTER_START = "---\n";
const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---(?:\n|$)/u;
const FIELD_SEGMENT_REGEX = /^[A-Za-z0-9_-]+$/u;
const SUPPORTED_METADATA_KINDS = new Set(["frontmatter"]);

export type files_metadata_Value =
	| { qualifiedField: string; valueKind: "string"; value: string }
	| { qualifiedField: string; valueKind: "number"; value: number }
	| { qualifiedField: string; valueKind: "boolean"; value: boolean };

type ExtractedMetadata = {
	fields: string[];
	values: files_metadata_Value[];
};

export type files_metadata_SearchPlan =
	| { op: "exists"; qualifiedField: string }
	| { op: "eq"; qualifiedField: string; value: string | number | boolean }
	| { op: "prefix"; qualifiedField: string; value: string }
	| {
			op: "range";
			qualifiedField: string;
			gte?: number;
			gt?: number;
			lte?: number;
			lt?: number;
	  };

// #region frontmatter extraction

function empty_extracted_metadata(): ExtractedMetadata {
	return { fields: [], values: [] };
}

function extract_frontmatter_body(markdown: string) {
	if (!markdown.startsWith(FRONTMATTER_START)) {
		return null;
	}
	return FRONTMATTER_REGEX.exec(markdown)?.[1] ?? null;
}

function normalize_frontmatter_indentation(body: string) {
	return body
		.split("\n")
		.map((line) => {
			// Normalize visual indentation only; NBSPs inside scalar values are user content.
			const indentation = /^[ \u00a0]+(?=(?:-\s|[A-Za-z0-9_-]+:))/u.exec(line)?.[0];
			if (!indentation || !indentation.includes("\u00a0")) {
				return line;
			}
			return `${indentation.replaceAll("\u00a0", " ")}${line.slice(indentation.length)}`;
		})
		.join("\n");
}

function node_or_null(value: unknown): YamlNode | null {
	if (value === null || isAlias(value) || isScalar(value) || isMap(value) || isSeq(value)) {
		return value;
	}
	return null;
}

function node_has_anchor_or_alias(node: YamlNode | null): boolean {
	if (node === null) {
		return false;
	}
	if (isAlias(node)) {
		return true;
	}
	if ("anchor" in node && typeof node.anchor === "string" && node.anchor.length > 0) {
		return true;
	}
	if (isMap(node)) {
		return node.items.some(
			(pair) => node_has_anchor_or_alias(node_or_null(pair.key)) || node_has_anchor_or_alias(node_or_null(pair.value)),
		);
	}
	if (isSeq(node)) {
		return node.items.some((item) => node_has_anchor_or_alias(node_or_null(item)));
	}
	return false;
}

function scalar_key_segment(node: YamlNode | null) {
	if (!isScalar(node) || typeof node.value !== "string" || !FIELD_SEGMENT_REGEX.test(node.value)) {
		return null;
	}
	return node.value;
}

function scalar_metadata_value(qualifiedField: string, node: YamlNode | null): files_metadata_Value | null {
	if (!isScalar(node) || node.tag != null) {
		return null;
	}
	const value = node.value;
	if (typeof value === "string") {
		return { qualifiedField, valueKind: "string", value };
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return { qualifiedField, valueKind: "number", value };
	}
	if (typeof value === "boolean") {
		return { qualifiedField, valueKind: "boolean", value };
	}
	return null;
}

function primitive_value_key(value: files_metadata_Value) {
	return `${value.qualifiedField}\u0000${value.valueKind}\u0000${String(value.value)}`;
}

function collect_metadata_from_node(args: {
	node: YamlNode | null;
	qualifiedField: string;
	mut_fields: Set<string>;
	mut_values: Map<string, files_metadata_Value>;
}) {
	args.mut_fields.add(args.qualifiedField);

	if (args.node === null || isAlias(args.node) || args.node.tag != null) {
		return;
	}

	const scalarValue = scalar_metadata_value(args.qualifiedField, args.node);
	if (scalarValue) {
		args.mut_values.set(primitive_value_key(scalarValue), scalarValue);
		return;
	}

	if (isSeq(args.node)) {
		for (const item of args.node.items) {
			const itemNode = node_or_null(item);
			const itemValue = scalar_metadata_value(args.qualifiedField, itemNode);
			if (itemValue) {
				args.mut_values.set(primitive_value_key(itemValue), itemValue);
			}
		}
		return;
	}

	if (isMap(args.node)) {
		for (const pair of args.node.items) {
			const segment = scalar_key_segment(node_or_null(pair.key));
			if (!segment) {
				continue;
			}
			collect_metadata_from_node({
				node: node_or_null(pair.value),
				qualifiedField: `${args.qualifiedField}.${segment}`,
				mut_fields: args.mut_fields,
				mut_values: args.mut_values,
			});
		}
	}
}

export function files_metadata_extract_frontmatter(markdown: string): ExtractedMetadata {
	const body = extract_frontmatter_body(markdown);
	if (body === null) {
		return empty_extracted_metadata();
	}

	const doc = parseDocument(normalize_frontmatter_indentation(body), {
		version: "1.2",
		schema: "core",
		// Keep explicit YAML tags unresolved so tagged values become presence-only metadata.
		resolveKnownTags: false,
	});
	if (doc.errors.length > 0) {
		return empty_extracted_metadata();
	}

	const root = doc.contents;
	// Aliases can duplicate values outside the written field path, so treat anchored docs like invalid frontmatter.
	if (!isMap(root) || node_has_anchor_or_alias(root)) {
		return empty_extracted_metadata();
	}

	const fields = new Set<string>();
	const values = new Map<string, files_metadata_Value>();
	for (const pair of root.items) {
		const segment = scalar_key_segment(node_or_null(pair.key));
		if (!segment) {
			continue;
		}
		collect_metadata_from_node({
			node: node_or_null(pair.value),
			qualifiedField: `frontmatter.${segment}`,
			mut_fields: fields,
			mut_values: values,
		});
	}

	return {
		fields: [...fields],
		values: [...values.values()],
	};
}

// #endregion frontmatter extraction

// #region search where parsing

function is_record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parse_qualified_field(value: unknown) {
	if (typeof value !== "string") {
		return Result({ _nay: { message: "meta search fields must be strings." } });
	}
	const dotIndex = value.indexOf(".");
	if (dotIndex <= 0 || dotIndex === value.length - 1) {
		return Result({
			_nay: {
				message: "meta search fields must be qualified, for example frontmatter.from or system.createdAt.",
			},
		});
	}
	const kind = value.slice(0, dotIndex);
	if (!SUPPORTED_METADATA_KINDS.has(kind)) {
		return Result({
			_nay: {
				message: `Unsupported metadata kind "${kind}". Supported kinds: frontmatter.`,
			},
		});
	}
	const segments = value.slice(dotIndex + 1).split(".");
	if (segments.some((segment) => !FIELD_SEGMENT_REGEX.test(segment))) {
		return Result({
			_nay: {
				message: "meta search field segments may contain only letters, numbers, underscores, and hyphens.",
			},
		});
	}
	return Result({ _yay: value });
}

function parse_eq_value(value: unknown) {
	if (typeof value === "string" || typeof value === "boolean") {
		return Result({ _yay: value });
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return Result({ _yay: value });
	}
	return Result({
		_nay: { message: "eq supports string, number, and boolean values. Null, arrays, and objects are not searchable values." },
	});
}

function parse_binary_args(value: unknown, operator: string) {
	if (!Array.isArray(value) || value.length !== 2) {
		return Result({ _nay: { message: `${operator} must be an array like ["frontmatter.field", value].` } });
	}
	const qualifiedField = parse_qualified_field(value[0]);
	if (qualifiedField._nay) {
		return qualifiedField;
	}
	return Result({ _yay: { qualifiedField: qualifiedField._yay, value: value[1] } });
}

function parse_range_bound(value: unknown, key: string) {
	if (value === undefined) {
		return Result({ _yay: undefined });
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return Result({ _yay: value });
	}
	return Result({ _nay: { message: `range.${key} supports number values only.` } });
}

export function files_metadata_parse_search_where_json(whereJson: string) {
	let parsed: unknown;
	try {
		parsed = JSON.parse(whereJson);
	} catch {
		return Result({ _nay: { message: "meta search --where must be valid JSON." } });
	}
	if (!is_record(parsed)) {
		return Result({ _nay: { message: "meta search --where must be a JSON object." } });
	}

	if ("and" in parsed || "or" in parsed) {
		return Result({
			_nay: {
				message:
					"meta search supports one indexed field predicate per command. Run multiple meta search commands and combine path output in the shell for AND, OR, or multi-value matching.",
			},
		});
	}
	if ("not" in parsed || "neq" in parsed || "missing" in parsed || "without" in parsed) {
		return Result({
			_nay: { message: "meta search only supports positive predicates: exists, eq, prefix, and range." },
		});
	}

	if ("exists" in parsed) {
		const qualifiedField = parse_qualified_field(parsed.exists);
		if (qualifiedField._nay) {
			return qualifiedField;
		}
		return Result({ _yay: { op: "exists", qualifiedField: qualifiedField._yay } satisfies files_metadata_SearchPlan });
	}

	if ("eq" in parsed) {
		const args = parse_binary_args(parsed.eq, "eq");
		if (args._nay) {
			return args;
		}
		const value = parse_eq_value(args._yay.value);
		if (value._nay) {
			return value;
		}
		return Result({
			_yay: { op: "eq", qualifiedField: args._yay.qualifiedField, value: value._yay } satisfies files_metadata_SearchPlan,
		});
	}

	if ("prefix" in parsed) {
		const args = parse_binary_args(parsed.prefix, "prefix");
		if (args._nay) {
			return args;
		}
		if (typeof args._yay.value !== "string") {
			return Result({ _nay: { message: "prefix supports string values only." } });
		}
		return Result({
			_yay: {
				op: "prefix",
				qualifiedField: args._yay.qualifiedField,
				value: args._yay.value,
			} satisfies files_metadata_SearchPlan,
		});
	}

	if ("range" in parsed) {
		const args = parse_binary_args(parsed.range, "range");
		if (args._nay) {
			return args;
		}
		if (!is_record(args._yay.value)) {
			return Result({ _nay: { message: "range must use a bounds object with gte, gt, lte, or lt." } });
		}
		const gte = parse_range_bound(args._yay.value.gte, "gte");
		const gt = parse_range_bound(args._yay.value.gt, "gt");
		const lte = parse_range_bound(args._yay.value.lte, "lte");
		const lt = parse_range_bound(args._yay.value.lt, "lt");
		for (const bound of [gte, gt, lte, lt]) {
			if (bound._nay) {
				return bound;
			}
		}
		if (gte._yay === undefined && gt._yay === undefined && lte._yay === undefined && lt._yay === undefined) {
			return Result({ _nay: { message: "range requires at least one numeric bound: gte, gt, lte, or lt." } });
		}
		return Result({
			_yay: {
				op: "range",
				qualifiedField: args._yay.qualifiedField,
				...(gte._yay === undefined ? {} : { gte: gte._yay }),
				...(gt._yay === undefined ? {} : { gt: gt._yay }),
				...(lte._yay === undefined ? {} : { lte: lte._yay }),
				...(lt._yay === undefined ? {} : { lt: lt._yay }),
			} satisfies files_metadata_SearchPlan,
		});
	}

	return Result({
		_nay: { message: "meta search only supports positive predicates: exists, eq, prefix, and range." },
	});
}

// #endregion search where parsing
