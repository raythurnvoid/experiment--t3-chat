# Shared Parser Patterns

Use this reference when touching parser or serializer utilities under `packages/app/shared/**`.

## Anchors

- Keep shared modules runtime-portable: no browser-only or Convex-only assumptions.
- Export only real cross-module API. Keep extracted result types and helpers private unless imported elsewhere.
- Keep parser stages ordered by responsibility: constants/types, extraction/normalization, traversal, public entrypoints, then command/query parsing if present.
- Document narrow deviations from external formats, such as normalizing editor-produced whitespace or treating YAML tags as presence-only metadata.
- Use concrete comments for unsupported cases: aliases, explicit tags, null/object values, or non-searchable arrays.

## Review

- Test public behavior, not private traversal helpers.
- Add edge cases that came from real app flows.
- Keep validation messages user-facing when they are returned through command surfaces.
