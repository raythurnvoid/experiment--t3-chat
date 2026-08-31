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
- Keep fixed scalar or configuration constants UPPER_SNAKE, such as `REVIEW_MODEL_ID` and `MAX_DOCUMENT_SLOTS`, unless the file has a stronger established prefix such as `files_READ_RANGE_SCAN_MAX_BYTES`. Validators, schemas, Workpool instances, clients, and other module objects may use lower snake case. Do not export symbols with no consumer outside the module.
- Never cast a `ctx.runQuery`/`ctx.runMutation`/`ctx.runAction` result to an inline `{ _yay?: ...; _nay?: ... }` shape; use a derived `<fn>_Result` type next to the callee (see the Convex additional guidelines).
- Derive whole-doc mutation `args` from the schema by listing each field as `doc(app_convex_schema, "<table>").fields.<field>` (never `omit(...)`/`pick(...)` on validator fields) and spread `{ ...args }` into the write; name patch-or-insert mutations `upsert_*`.
- Keep a private helper only when it removes real duplication or hides a necessary boundary such as pending-vs-committed indexed lookup, linked-doc validation, or external cursor parsing. Inline one-use predicates and pass-through wrappers.

## Schema Comments

Schema comments should name the concrete docs and why the table exists:

- `files_plain_text_chunks` docs support full-text search and pending/committed overlay; `files_search_chunks` no longer exists.
- `files_text_chunks` docs support exact text reads and regex scans for both committed and pending content; the old pending-only chunk table no longer exists.
- `files_metadata_docs` field docs support field-existence search.
- `files_metadata_docs` value docs support primitive value search.

Avoid vague terms such as `projection` when `search chunks`, `metadata docs`, or `indexed docs` is clearer.

## Large Values: Page/Seal And One-Large-Value-Per-Call

Convex rejects values close to 1 MiB, so large binary state never travels or stores as one value. The pending-state family in `files_pending_updates.ts` is the reference implementation:

- Page/seal: stage bytes in bounded pages (each at most `files_MAX_YJS_WIRE_BYTES`, non-empty, contiguous by index), then one seal mutation reloads the pages, verifies completeness against recorded totals plus a digest, runs every content check on the reassembled value, and marks the state valid. Only the seal validates; the final commit re-checks ids and digests and never reloads pages.
- One large value per call: every registered function carries at most ONE page or ONE bounded text, plus ids and scalars. A flow that needs two large inputs stages one first (a text-input doc or a trusted-update stage) and passes its id to the next call.
- Give every staged/temporary doc an owner and an expiry so an abandoned flow is swept, and retire superseded families into durable cleanup tasks drained by a bounded scheduled continuation instead of deleting children inline.

## Search Chunks

- Full-text search pages read denormalized display fields and offsets directly from `files_plain_text_chunks`; do not add a `textChunkId` dereference to hydrate each hit.
- Exact text scans query `files_text_chunks` directly.
- `files_plain_text_chunks.textChunkId` remains an integrity/provenance link between paired chunk docs. Validate it only in code that actually follows the link.
- Keep invariant error metadata structured and never log chunk text or document bodies.
- Keep query filters before pagination for the current full-text overlay. Do not add a JavaScript re-filter or a separate page probe that changes the established page semantics.
- Do not hide hard caps such as `.take(100)` inside a cursor phase unless the cursor can advance past that cap.
- If native pagination is followed by overlay filtering elsewhere, comment that pages may be short and callers must follow `isDone`.
