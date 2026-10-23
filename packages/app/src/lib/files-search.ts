import { app_convex_is_id_like } from "@/lib/app-convex-client.ts";
import { path_is_path_like } from "@/lib/paths.ts";
import { url_parse_file_link } from "@/lib/urls.ts";
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

	// The search door confirms an id guess: a string that is no node id finds nothing.
	if (app_convex_is_id_like(query)) {
		return { mode: "node", value: query };
	}

	if (path_is_path_like(query)) {
		return { mode: "path", value: query };
	}

	// Drop a trailing extension of the whole query, so `README.md` searches the word `readme`, not
	// every `md` file. Dots inside earlier words stay, so `v1.2.0 notes` is kept. A leading dot of the
	// last word stays too, so `.env` is kept. The agent's `find -name` (`normalize_name_path_query` in
	// `server/bash-find-command.ts`) cuts at the last dot of the whole text instead, so
	// `v1.2.0 notes` becomes `v1.2` there.
	const name = query.toLowerCase();
	const lastWordIndex = name.search(/\S+$/u);
	const dotIndex = name.lastIndexOf(".");
	return { mode: "name", value: dotIndex > lastWordIndex ? name.slice(0, dotIndex) : name };
}

/**
 * The free text of a parsed query, as the search reads it. Quotes in the free text only group
 * words, so a text of quotes alone is empty.
 */
export function search_free_text(text: string) {
	return text.replace(/"/gu, "").trim();
}

const SNIPPET_RADIUS = 60;

/**
 * The part of a content match's text chunk to show under the row: about 120 characters around the
 * first searched word, on one line.
 */
export function search_content_snippet(textChunk: string, query: string) {
	const flatText = textChunk.replace(/\s+/gu, " ").trim();
	const firstTerm = query.trim().split(/\s+/u)[0] ?? "";
	const hitIndex = firstTerm ? flatText.toLowerCase().indexOf(firstTerm.toLowerCase()) : -1;
	const start = hitIndex < 0 ? 0 : Math.max(0, hitIndex - SNIPPET_RADIUS);
	const end = Math.min(flatText.length, start + SNIPPET_RADIUS * 2);
	return `${start > 0 ? "…" : ""}${flatText.slice(start, end)}${end < flatText.length ? "…" : ""}`;
}

/**
 * The `file.path` chip of a query, or null. `path` is the exact path. `depth` is "exact" for one
 * item (`/a/b.md`), "children" for a folder's direct children (`/a/*`), and "all" for everything
 * under it (`/a/**`).
 */
export function search_path_filter(filters: files_search_query_Filter[]) {
	for (const filter of filters) {
		if (filter.problem !== null || filter.key.namespace !== "file" || filter.key.name !== "path") {
			continue;
		}
		if (filter.match.op === "folder") {
			return { raw: filter.raw, path: filter.match.path, depth: filter.match.depth };
		}
		if (filter.match.op === "eq") {
			return { raw: filter.raw, path: files_search_query_folder_path(filter.match.value), depth: "exact" as const };
		}
	}
	return null;
}
