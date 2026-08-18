---
name: file-metadata
description: Spec for the flat key-value metadata stored next to a file — the `metadata.*` half of `files_metadata_docs`, the YAML edit format, the two write doors (`files_metadata.set_entries` for the panel and `update_entries_by_path` for the agent), the key grammar and caps, and how it sits beside Markdown frontmatter in `meta search`. Use when changing `packages/app/shared/files-metadata.ts`, the metadata region of `packages/app/convex/files_metadata.ts`, the Metadata panel in `packages/app/src/components/files/file-editor/file-editor-sidebar/`, the `set_file_metadata` agent tool in `packages/app/server/server-ai-tools.ts`, or `meta search` / `meta get` in `packages/app/server/bash-meta-command.ts`.
---

# Mental Model

Every file can carry a metadata map: a flat set of keys with scalar values. It is stored NEXT TO the
file, not inside it. That is the whole point:

- Frontmatter only exists in Markdown. Metadata works on every file kind, uploads and binaries
  included.
- Frontmatter is part of the file's own text, so an integration that rewrites the content replaces
  it. Metadata survives a content save untouched.

Keys are a convention, not a permission. Anybody who may write the file may set any key. There is no
namespace ownership, no per-plugin rule, and no special case: `created-by` and `slack:message-id` are
ordinary keys that some team agreed on. If a folder has a house convention, it belongs in that
folder's `README.md`, not in code.

The stored form is validated structured data, not a text blob. YAML is only the edit format the
Metadata panel shows and parses. Nothing stores YAML.

# Data Shape

One entry is `{ key: string; value: string | number | boolean }` (`files_metadata_Entry` in
`packages/app/shared/files-metadata.ts`). No nesting, no arrays, no null.

Entries are indexed in the same `files_metadata_docs` table that Markdown frontmatter uses. The
`qualifiedField` prefix is what tells the two sources apart:

| Source | Prefix | Written by |
| --- | --- | --- |
| Markdown YAML frontmatter | `frontmatter.` | content materialization, from the file's own text |
| Metadata next to the file | `metadata.` | a user in the panel, or an agent |

Both prefixes are exported from `shared/files-metadata.ts`. A range over one source bounds at
`frontmatter/` or `metadata/`, because `/` (0x2F) is the next character after `.` (0x2E), so the
range covers exactly that prefix and nothing else.

Per key, `db_write_metadata` writes one `field` doc (existence search) and one `value` doc (value
search). A date-like string value also gets the `maybe_date` companion, exactly like frontmatter, so
range search over dates works. Value docs carry `entryIndex`, the key's position in the map the user
typed — reading the map back in index order would reorder the panel's lines on every save.
Frontmatter docs leave `entryIndex` unset.

`metadata.*` docs are always `sourceKind: "committed"`. There is no pending overlay for them: a
pending content proposal changes the file's text, and metadata is not text.

# Rules

- **The whole map is replaced by a panel save.** `set_entries` takes the whole YAML document, so a
  key missing from it is deleted. The agent door is the opposite: `update_entries_by_path` changes only
  the keys it names.
- **A key already in the map keeps its position.** New keys are appended where the caller first named
  them. `files_metadata_apply_set_and_remove` owns this.
- **Remove wins over set.** A key listed in both is removed, so a confused call cannot leave behind a
  key the caller asked to delete.
- **A key named twice keeps its last value**, whether or not the file already had that key.
- **Metadata uses `content.write`.** There is no separate permission. A read-only file refuses
  metadata writes too, exactly like its content.
- **A metadata write keeps an eager-created node alive.** Agent-mode `cp` and a bash write to a
  missing path create the node right away and stamp `eagerCreated`. When the proposal is discarded,
  `remove_eager_created_node_if_safe` hard-deletes that node again. A metadata write is committed and
  never advances the Yjs sequence, so none of the other safety checks can see it, and the map would
  be deleted with the file. `files_nodes_db_is_eager_node_safe_to_hard_delete` therefore keeps any
  node that already has committed `metadata.` docs. Frontmatter docs do not count: they come from the
  very content the proposal created.
- **Caps** (all in `shared/files-metadata.ts`): 128 keys, 128 characters per key, 1024 characters per
  string value, and 16 KiB for the YAML document. Both doors enforce the document cap — the agent
  writes entries, so its door measures the document those entries would make. Without that the agent
  could store a map the panel renders but refuses to save.
- **Key grammar** is `/^[\p{L}\p{N}_:-]+$/u`: letters (in any language), numbers, `_`, `-` and `:`. A
  colon is part of the key, so `slack:message-id` is one key. The dot is left out, because
  `metadata.a.b` would read like the real nesting `frontmatter.a.b` means.
- `packages/app/server/bash-meta-command.ts` repeats that grammar for `meta search`. **Change both
  together**, or a key a user can write becomes a key nobody can search for.

# YAML Is Only The Edit Format

`files_metadata_parse_entries_yaml` parses with the YAML 1.2 core schema and
`resolveKnownTags: false`. Two traps it handles on purpose:

- **Numbers whose text does not survive a round trip stay text.** YAML 1.2 core reads `1.10` as 1.1,
  `0x10` as 16, `010` as 10. Storing the number would not give the user back what they typed, and a
  version or an id written that way would change meaning. `Scalar.source` decides.
- **Booleans do NOT get that treatment.** `True` resolves to true and only the capital letter is
  lost. Keeping the text would turn a value the user meant as a boolean into a string that
  `meta search --where '{"eq":[...,true]}'` can never find.

Other decisions in the parser:

- Under YAML 1.2 core, `no` / `yes` / `on` and `2026-08-18` are already plain strings. The pre-1.2
  traps do not need extra handling.
- A key YAML types as a number or a boolean (`2026: planned`) is read from its source text, so a
  year or an id works without quoting.
- Anchors, aliases, and explicit tags are refused, not resolved. The document is never converted to
  a JS object, so nothing can expand.
- A deeply nested document is refused, not parsed. The parser recurses into nested collections, so
  2000 nested `{` overflow the stack and throw. That fits in 4 KB, so the byte cap does not stop it.
  `parseDocument` runs inside a `try`, and the throw becomes the plain "Metadata must be valid YAML"
  refusal. `files_metadata_extract_frontmatter` guards the same way but answers differently — see
  below.
- Only the first line of a YAML syntax error is kept. The library appends the offending lines and a
  caret under them, and that frame loses its shape once HTML collapses the whitespace.

`files_metadata_stringify_entries_yaml` renders the stored map back with `Document.set`, never plain
object assignment, so a key such as `__proto__` stays an ordinary key.

## The frontmatter parser answers the same crash differently

`files_metadata_extract_frontmatter` returns `Result`. Both parsers guard the same `parseDocument`
throw, but they answer it differently on purpose:

- The panel parser refuses and shows the user a message. The user is editing that YAML by hand, so
  they need to know why Save did nothing.
- The frontmatter parser returns `_nay` and every caller keeps saving. The user is saving a *file*
  and the frontmatter is only part of it. Refusing would leave them unable to store their own text,
  and they cannot fix depth by writing less.

Depth is the limit, not size, and the depth that breaks depends on the runtime's stack. Measured
2026-08-18: Node (so every test here) throws around 1000 levels, while the real Convex runtime reads
1000 and throws by 5000. Flow style needs no indentation, so even 5000 levels of `a: {b: {b: …` fit
in 25 KB. Never pick a test fixture depth from the Node number alone when the check has to fail
inside a deployed function.

Rules for the six callers (`files_metadata_db_insert_committed`, `files_metadata_db_replace_pending`,
materialization and repair in `files_nodes_content.ts`, the upload publish in `r2.ts`, and the
pending-update preflight in `files_pending_updates.ts`):

- Never fail the save on `_nay`. Index no frontmatter, log a warning, continue.
- Never set the `contentFrontmatterTooLarge*` marker pair for it. Those markers mean over-cap and
  carry counts; an unreadable file has no counts to show.
- Keep `_nay` separate from the `doc.errors` case, which returns empty metadata. Broken YAML really
  has no metadata. An unreadable parse may have hidden good metadata, and that is worth a log.

Catch everything, never `instanceof RangeError`. The thrown type follows the parser options:
`RangeError` with ours, `SyntaxError` from a regex inside the library on another path.

This is a weakness in `yaml` 2.8.2, not a depth nobody should use: `JSON.parse` reads 100,000 levels
of the same shape without complaint. If a later version reports it in `doc.errors` instead, the
`try` becomes redundant but stays correct.

# Write Doors

Both live in the `// #region file metadata` of `packages/app/convex/files_metadata.ts`.

`set_entries` — the panel's door, a public mutation:

1. auth
2. `files_tree_write` rate limit (the bucket other per-node property writes use)
3. membership owned by the caller and active
4. node load, tenancy compare, `kind === "file"` — anything else answers `Not found`
5. ACL on the node (`content.write`, passing the `fileNode` so a restricted folder is resolved)
6. `files_node_require_writable`
7. parse the YAML, then write

`update_entries_by_path` — the agent's door, an internal mutation. It has no membership leg because the
agent already proved workspace-level permission before any tool was built. It follows the established
agent-write contract (compare with `settle_file_pending_update_no_change_in_db` in
`files_pending_updates.ts`): resolve the node scoped by org/workspace, then
`access_control_db_can_act_on_file_node`, then `files_node_require_writable`. It applies changes
directly — there is no pending review, because the pending-update system only models content
branches and move/copy/archive intents.

`get_entries` is a public query and returns `[]` for a non-member or an unreadable node. It throws
only when Convex auth has no usable identity.

# Surfaces

- **Metadata panel**: `packages/app/src/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-metadata.tsx`.
  A Monaco YAML editor in the file sidebar, shown for a file node and hidden for a folder.
- **Agent tool**: `set_file_metadata` in `packages/app/server/server-ai-tools.ts`. It is in
  `ai_chat_WRITE_TOOL_NAMES`, so Ask mode drops it from the tool record, not only from `activeTools`.
- **Agent search**: `meta search --where '{"exists":"metadata.<key>"}'` and `meta get <file>`, both in
  `packages/app/server/bash-meta-command.ts`. `meta get` prints frontmatter and metadata fields
  together; its `source:` line describes the frontmatter lines only, because `metadata.*` is always
  the committed map.

# Panel Reconciliation

The panel is the only place where a stored map and typed text have to be kept in step, and that is
where its complexity is. Read this before editing it.

The server stores a map, not text, so what comes back is the map rendered again. It rarely matches
what was sent character for character: Monaco can use CRLF, a comment is not stored, `4.0` comes back
quoted, and the render always ends with a newline. The panel remembers the exact text it sent
(`sentDraftRef`) so the reconcile effect can tell its own echo apart from an edit by somebody else.

Three rules the tests pin but cannot explain. Read them before you change the effect:

- **Never write a ref inside a `setState` updater here.** The app runs in `StrictMode`, which invokes
  the updater twice, and the second pass would see the cleared ref and fall into the conflict branch.
  This shipped as a false "Metadata changed elsewhere" on every save until live QA found it. The
  panel's tests render under `StrictMode` for exactly this reason.
- **Report the save result through the updater form**, never by writing a whole state object read
  from a ref. The reactive query push and the mutation promise can land in the same tick, and a whole
  object write would undo the adoption.
- **The editor must not mount before the draft holds the stored map.** Monaco is created from
  `value`, so mounting on an empty draft and filling it one render later shows an empty field for a
  frame and puts that fill in the editor's own undo history. The state carries a `loaded` flag: the
  `useState` initializer takes the map when Convex already answers from cache, and the skeleton holds
  until the effect fills it otherwise. Because `loaded` starts false for a file with no metadata too,
  the effect's early return checks `loaded` as well, or that file would never leave the skeleton.

The Save button follows the members and roles pages: when a permission or the read-only lock blocks
the write it uses `aria-disabled` plus `MyButton-state-disabled`, never the native `disabled`, and
points `aria-describedby` at the reason. A natively disabled button leaves the tab order, so a
keyboard user would never hear why they cannot save. It stays natively disabled for the ordinary
"nothing changed to save" case, which needs no explanation.

The editor sets `tabFocusMode: true`. Monaco traps Tab by default, which leaves a keyboard user stuck
inside the field with no way to reach Save, and YAML cannot use tabs for indentation anyway.

# Agent-Facing Wording

Two mistakes a model makes, both found by driving the real agent, both fixed in the tool text:

- It pastes the bash mount path (`/home/cloud-usr/w/<org>/<workspace>/file.md`) straight from
  `meta get` output. The description carries the same strip-the-prefix rule `edit_file` has.
- It passes the search field name (`metadata.status`) where the tool wants the bare key (`status`).
  A `set` key like that is refused by the grammar, but a `remove` key is never stored, so nothing
  else would check it and the call would report success while the key stayed. That is why
  `files_metadata_validate_remove_keys` exists, and why the refusal names the bare key to pass.

# Not Built On Purpose

- No public HTTP API route. `packages/app/convex/public_api.ts` does not expose metadata. Adding it
  is a follow-up, not an oversight.
- No quota or billing accounting. `set_entries` shares the `files_tree_write` bucket and writes up to
  ~384 index docs per call. `set_node_read_only` has no quota leg either, so this is consistent —
  revisit it as a product decision, not as a hole.
- `cp` does not copy metadata to the new file.
- No dedicated chat renderer for the tool call. It falls back to the generic unknown-tool disclosure,
  which shows name, parameters, and result.

# Tests

- `packages/app/shared/files-metadata.test.ts` — parse, stringify, validate, apply-changes, index docs.
- `packages/app/convex/files_nodes.test.ts` — the `metadata` tests: search next to frontmatter,
  surviving a content save, the pending-overlay exemption, refusals, and the agent door on an upload.
- `packages/app/convex/files_pending_updates.test.ts` — a save whose frontmatter the parser cannot
  read still stores the text and writes no metadata docs.
- `packages/app/server/server-ai-tools.test.ts` — the `set_file_metadata` tool.
- `packages/app/server/bash-meta-command.test.ts` — `metadata.*` field parsing.
- `packages/app/src/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-metadata.test.tsx` — the panel.
