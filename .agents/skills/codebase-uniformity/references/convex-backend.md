# Convex Backend Patterns

Use this reference when touching `packages/app/convex/**`.

## Anchors

- Read `.agents/skills/convex/SKILL.md` and `.agents/skills/convex/references/additional-guidelines.md` before editing Convex code.
- Keep one-off validators inline at the registered function unless there is real production reuse.
- Prefer `ctx.db.get` when an id is already available.
- Prefer indexed queries before filters; filters should have a concrete reason.
- Use structured invariant failures: `const errorMessage`, `const errorData`, `console.error(errorMessage, errorData)`, then `should_never_happen(errorMessage, errorData)` when the surrounding module uses that pattern.
- Use `doc/docs` for Convex table entries in comments and docs, not `row/rows`.

## Schema Comments

Schema comments should name the concrete docs and why the table exists:

- `files_search_chunks` docs support full-text search and pending/committed overlay.
- `files_metadata_fields` docs support field-existence search.
- `files_metadata_values` docs support primitive value search.

Avoid vague terms such as `projection` when `search chunks`, `metadata docs`, or `indexed docs` is clearer.
