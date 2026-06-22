# Convex Backend Patterns

Use this reference when touching `packages/app/convex/**`.

## Anchors

- Read `.agents/skills/convex/SKILL.md` and `.agents/skills/convex/references/additional-guidelines.md` before editing Convex code.
- Keep one-off validators inline at the registered function unless there is real production reuse.
- Prefer `ctx.db.get` when an id is already available.
- Prefer indexed queries before filters; filters should have a concrete reason.
- Use structured invariant failures: `const errorMessage`, `const errorData`, `console.error(errorMessage, errorData)`, then `should_never_happen(errorMessage, errorData)` when the surrounding module uses that pattern.
- Use `doc/docs` for Convex table entries in comments and docs, not `row/rows`.
- Keep module-private helpers unprefixed unless the surrounding module already uses a boundary prefix. In `files_nodes.ts`, private helpers that fetch or query Convex docs use `db_`; pure helpers remain unprefixed. File prefixes such as `files_nodes_` are for exported symbols and exported result types.
- Keep a private helper only when it removes real duplication or hides a necessary boundary such as pending-vs-committed indexed lookup, linked-doc validation, or external cursor parsing. Inline one-use predicates and pass-through wrappers.

## Schema Comments

Schema comments should name the concrete docs and why the table exists:

- `files_plain_text_chunks` docs support full-text search and pending/committed overlay; `files_search_chunks` no longer exists.
- `files_markdown_chunks` docs support exact Markdown reads and regex scans for both committed and pending content; the old pending-only chunk table no longer exists.
- `files_metadata_fields` docs support field-existence search.
- `files_metadata_values` docs support primitive value search.

Avoid vague terms such as `projection` when `search chunks`, `metadata docs`, or `indexed docs` is clearer.

## Linked Docs And Search Chunks

When one indexed doc points to another table:

- Name invariant errors from the broken field, for example `plainTextChunk.markdownChunkId points to a missing or mismatched files_markdown_chunks doc`.
- Split missing optional fields into exact messages such as `plainTextChunk.pendingUpdateId is not set`.
- Keep error metadata structured and avoid logging chunk text or document bodies.
- Add a short comment only when ownership is non-obvious, such as plain-text search docs carrying rendered text while linked Markdown chunks own line offsets and snippets.

For chunk/search pagination:

- Do not hide hard caps such as `.take(100)` inside a cursor phase unless the cursor can actually advance past that cap.
- If native pagination is followed by overlay filtering, comment that pages may be short and callers must follow `isDone`.
