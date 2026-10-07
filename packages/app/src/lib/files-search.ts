import { app_convex_is_id_like } from "@/lib/app-convex-client.ts";
import { path_is_path_like } from "@/lib/paths.ts";
import { url_parse_file_link } from "@/lib/urls.ts";
import type { files_TreeItem } from "@/lib/files.ts";
import { files_search_query_folder_path, type files_search_query_Filter } from "../../shared/files-search-query.ts";

type SearchMode = "name" | "path" | "node" | "private";

/**
 * Decide what a search query means from its shape.
 *
 * A user pastes whatever they copied: a file name, a copied path, a node id, or a full app
 * link. Reading the shape means they never have to learn a prefix syntax for each case.
 * A pasted link is unwrapped first into the node id or the path it carries. A path keeps its case,
 * because paths are exact-case. A name is lowercase.
 */
export function detect_search_query_mode(rawQuery: string): { mode: SearchMode; value: string } {
	const query = rawQuery.trim();

	const link = url_parse_file_link(query);
	if (link) {
		if ("pendingNodeId" in link) return { mode: "private", value: link.pendingNodeId };
		return "nodeId" in link ? { mode: "node", value: link.nodeId } : { mode: "path", value: link.path };
	}

	// The tree lookup in `get_search_matches` confirms an id guess.
	if (app_convex_is_id_like(query)) {
		return { mode: "node", value: query };
	}

	if (path_is_path_like(query)) {
		return { mode: "path", value: query };
	}

	// Drop a trailing extension from each word, so `README.md` searches the word `readme`, not every
	// `md` file. A leading dot stays, so `.env` is kept. The agent's `find -name` does the same in
	// `normalize_name_path_query` (`server/bash-find-command.ts`).
	const words = query
		.toLowerCase()
		.split(/\s+/u)
		.map((word) => {
			const dotIndex = word.lastIndexOf(".");
			return dotIndex > 0 ? word.slice(0, dotIndex) : word;
		});
	return { mode: "name", value: words.join(" ") };
}

/**
 * One valid filter against one tree item. `null` means the answer is not known: a metadata or
 * `file.link` filter whose server query has not answered, or whose query failed. The parser refuses
 * a negated filter, so the callers never pass one.
 */
export function search_filter_matches_item(args: {
	filter: files_search_query_Filter;
	item: Pick<files_TreeItem, "path">;
	targetKey: string;
	serverTargetKeys: ReadonlyMap<string, ReadonlySet<string> | null>;
}): boolean | null {
	const { filter, item } = args;

	// The server answers `file.link` too, with the workspace list of public links, under the chip's raw
	// token like a metadata chip.
	if (filter.key.namespace !== "file" || filter.key.name === "link") {
		const targetKeys = args.serverTargetKeys.get(filter.raw);
		return targetKeys ? targetKeys.has(args.targetKey) : null;
	}

	// `file.path` is the only other chip the parser keeps. Paths are exact-case.
	if (filter.match.op !== "eq") {
		return false;
	}
	const folderPath = files_search_query_folder_path(filter.match.value);
	return folderPath === "/" || item.path === folderPath || item.path.startsWith(`${folderPath}/`);
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
