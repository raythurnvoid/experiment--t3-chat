import { app_convex_is_id_like } from "@/lib/app-convex-client.ts";
import { path_is_path_like } from "@/lib/paths.ts";
import { url_parse_file_link } from "@/lib/urls.ts";
import type { files_TreeItem } from "@/lib/files.ts";
import {
	files_search_query_file_updated_matches,
	files_search_query_folder_path,
	type files_search_query_Filter,
} from "../../shared/files-search-query.ts";

type SearchMode = "name" | "path" | "node";

/**
 * Decide what a search query means from its shape.
 *
 * A user pastes whatever they copied: a file name, a copied path, a node id, or a full app
 * link. Reading the shape means they never have to learn a prefix syntax for each case.
 * A pasted link is unwrapped first into the node id or the path it carries.
 */
export function parse_search_query(rawQuery: string): { mode: SearchMode; value: string } {
	const query = rawQuery.trim();

	const link = url_parse_file_link(query);
	if (link) {
		return "nodeId" in link ? { mode: "node", value: link.nodeId } : { mode: "path", value: link.path.toLowerCase() };
	}

	// The tree lookup in `get_search_matches` confirms an id guess.
	if (app_convex_is_id_like(query)) {
		return { mode: "node", value: query };
	}

	if (path_is_path_like(query)) {
		return { mode: "path", value: query.toLowerCase() };
	}

	return { mode: "name", value: query.toLowerCase() };
}

/**
 * One filter against one tree item. `null` means the answer is not known: a metadata filter whose
 * server query has not answered, or whose query failed. Negation flips a known answer only.
 */
export function search_filter_matches_item(args: {
	filter: files_search_query_Filter;
	item: files_TreeItem;
	metadataNodeIds: ReadonlyMap<string, ReadonlySet<string> | null>;
}): boolean | null {
	const { filter, item } = args;
	const matches = ((/* iife */) => {
		if (filter.key.namespace !== "file") {
			const nodeIds = args.metadataNodeIds.get(filter.raw);
			return nodeIds ? nodeIds.has(item._id) : null;
		}

		const match = filter.match;
		switch (filter.key.name) {
			case "path": {
				if (match.op !== "eq") {
					return false;
				}
				// Paths ignore case like the other file fields and the free text do.
				const folderPath = files_search_query_folder_path(match.value).toLowerCase();
				const path = item.path.toLowerCase();
				return folderPath === "/" || path === folderPath || path.startsWith(`${folderPath}/`);
			}
			case "name": {
				if (match.op === "eq") {
					return item.name.toLowerCase().includes(match.value.toLowerCase());
				}
				return match.op === "prefix" && item.name.toLowerCase().startsWith(match.value.toLowerCase());
			}
			case "ext": {
				// A folder has no extension, even when its name holds a dot.
				if (match.op === "exists" || item.kind !== "file") {
					return false;
				}
				// A whole extension matches the end of the name, so `tar.gz` works although the tree
				// stores `gz`. A prefix matches that stored last part.
				const extension = match.value.replace(/^\./u, "").toLowerCase();
				return match.op === "eq"
					? item.name.toLowerCase().endsWith(`.${extension}`)
					: (item.lowercaseExtension?.startsWith(extension) ?? false);
			}
			case "kind":
				return match.op === "eq" && item.kind === match.value.toLowerCase();
			case "updated":
				return files_search_query_file_updated_matches(match, item.updatedAt);
		}

		return false;
	})();

	if (matches === null) {
		return null;
	}

	return filter.negated ? !matches : matches;
}

/**
 * The `file.path` chip that scopes the server queries to one folder, or null. `raw` is what
 * `handleSearchSubmit` compares between the live and the deferred query. `value` is the typed
 * folder that `searchPathPrefix` turns into the server scope.
 */
export function search_path_filter(filters: files_search_query_Filter[]) {
	for (const filter of filters) {
		if (
			filter.problem === null &&
			!filter.negated &&
			filter.key.namespace === "file" &&
			filter.key.name === "path" &&
			filter.match.op === "eq"
		) {
			return { raw: filter.raw, value: filter.match.value };
		}
	}
	return null;
}
