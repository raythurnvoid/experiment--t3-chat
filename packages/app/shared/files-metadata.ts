import { isAlias, isMap, isScalar, isSeq, parseDocument, type Node as YamlNode } from "yaml";

const FRONTMATTER_START = "---\n";
const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---(?:\n|$)/u;
const FIELD_SEGMENT_REGEX = /^[A-Za-z0-9_-]+$/u;

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
	// Every visited field is searchable by presence; only plain scalars and scalar array items add value indexes.
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
