---
name: file-metadata
description: Spec for the flat key-value metadata stored next to a file — the `metadata.*` half of `files_metadata_docs`, the YAML edit format, the two write doors (`files_metadata.set_entries` for the Properties modal and `update_entries_by_path` for the agent), the key grammar and caps, how it sits beside Markdown frontmatter in `meta search`, and the sidebar search box language (`packages/app/shared/files-search-query.ts`) with its three doors (`search_nodes`, `list_search_fields`, `list_search_values`). Use when changing `packages/app/shared/files-metadata.ts`, `packages/app/shared/files-search-query.ts`, the metadata or search box regions of `packages/app/convex/files_metadata.ts`, the Properties modal in `packages/app/src/components/files/files-properties-modal.tsx`, the `set_file_metadata` agent tool in `packages/app/server/server-ai-tools.ts`, or `meta search` / `meta get` in `packages/app/server/bash-meta-command.ts`.
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
Properties modal shows and parses. Nothing stores YAML.

# Data Shape

One entry is `{ key: string; value: string | number | boolean }` (`files_metadata_Entry` in
`packages/app/shared/files-metadata.ts`). No nesting, no arrays, no null.

Entries are indexed in the same `files_metadata_docs` table that Markdown frontmatter uses. The
`qualifiedField` prefix is what tells the two sources apart:

| Source | Prefix | Written by |
| --- | --- | --- |
| Markdown YAML frontmatter | `frontmatter.` | content materialization, from the file's own text; for a file with collaboration turned off there is no materialization, so the content replacement door writes it instead |
| Metadata next to the file | `metadata.` | a user in the Properties modal, an agent, or a file-creation flow (see "Metadata Written By The File-Creation Flows") |

Both prefixes are exported from `shared/files-metadata.ts`. A range over one source bounds at
`frontmatter/` or `metadata/`, because `/` (0x2F) is the next character after `.` (0x2E), so the
range covers exactly that prefix and nothing else.

Per key, `files_metadata_db_write_entries` writes one `field` doc (existence search) and one `value` doc (value
search). A date-like string value also gets the `maybe_date` companion, exactly like frontmatter, so
range search over dates works. Value docs carry `entryIndex`, the key's position in the map the user
typed — reading the map back in index order would reorder the dialog's lines on every save.
Frontmatter docs leave `entryIndex` unset.

`metadata.*` docs are always `sourceKind: "committed"`. There is no pending overlay for them: a
pending content proposal changes the file's text, and metadata is not text.

# Rules

- **The whole map is replaced by one save.** `set_entries` takes the whole YAML document, so a
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
  could store a map the dialog renders but refuses to save.
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

- The entries parser refuses and shows the user a message. The user is editing that YAML by hand, so
  they need to know why Save did nothing.
- The frontmatter parser returns `_nay` and every caller keeps saving. The user is saving a *file*
  and the frontmatter is only part of it. Refusing would leave them unable to store their own text,
  and they cannot fix depth by writing less.

Depth is the limit, not size, and the depth that breaks depends on the runtime's stack. Measured
2026-08-18: Node (so every test here) throws around 1000 levels, while the real Convex runtime reads
1000 and throws by 5000. Flow style needs no indentation, so even 5000 levels of `a: {b: {b: …` fit
in 25 KB. Never pick a test fixture depth from the Node number alone when the check has to fail
inside a deployed function.

Rules for the callers (`files_metadata_db_insert_committed`, `files_metadata_db_replace_pending`,
materialization, repair and the non-collaborative content replacement in `files_nodes_content.ts`,
the upload publish in `r2.ts`, and the pending-update preflight in `files_pending_updates.ts`):

- Never fail the save on `_nay`. Index no frontmatter, log a warning, continue.
- Over-cap frontmatter is different, and the non-collaborative content replacement is stricter than
  materialization on purpose. Materialization keeps the file at the last sequence that fit and sets
  the marker pair, because it runs in a retrying workpool with nobody watching. The replacement door
  runs while the user waits, and it has no materialization to defer to, so it refuses the save and
  the user fixes the text. It refuses with `Too many frontmatter fields`, the same words as the
  pending-update preflight: both are doors where a person hands over a whole text and can shorten it
  after reading the message. `Frontmatter exceeds the index caps` stays the materialization `_nay`,
  which nobody reads but the workpool.
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

`set_entries` — the Properties modal's door, a public mutation:

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

# Metadata Written By The File-Creation Flows

The two doors above are the only doors a person or an agent can knock on. The file-creation flows
write the map directly with `files_metadata_db_write_entries`, exported from `files_metadata.ts`.
They write it once, at create time, and nothing writes metadata later.

That writer checks nothing on purpose. A create runs before anybody could have an opinion about
that file, and mount files and plugin source mirrors are created read-only with a SYSTEM author, so
`db_authorize_metadata_write` and `files_node_require_writable` would refuse the very writes that
say where the file came from. Keep both doors as they are for user writes.

`files_nodes_db_create_node_recursively_at_path` takes `metadata` and applies it to the
**leaf only**. The folders it creates on the way get nothing: `set_entries` refuses a node that is
not a file, so a folder carrying a map could never be edited back.

| Flow | Entrypoint | Keys |
| --- | --- | --- |
| Browser file upload | `files_nodes.create_upload_node` | `source: upload`, `original-name` |
| Browser folder import | `files_nodes.create_upload_nodes` | `source: upload`, `original-name`, `import-relative-path` |
| Plugin service-grant upload | `public_api_service_uploads.create_upload_target` | `source: plugin`, `original-name`, `plugin-name` |
| Public API write / touch / upload-urls | `public_api.ts` (three creates) | `source: api` |
| Operator data import | `data_import.create_upload_targets` | `source: import`, `original-name` |
| GitHub mount file | `files_nodes_content.create_file_node_internal`, GITHUB scope | `source: github-mount`, `repo-path` |
| Plugin source mirror | `files_nodes_content.create_file_node_internal`, PLUGINS scope | `source: plugin-source` |

`repo-path` is the path inside the repository. The stored path starts with the mount name and the
commit sha, so that root is cut off before the value is stored.

## Two flows stamp nothing, on purpose

- **The agent's eager-created nodes.** Agent-mode `cp` and a bash write to a missing path create the
  node right away through `create_file_by_path` → `action_create_file_node`. A node with committed
  `metadata.` docs can no longer be hard-deleted (see the eager-create rule above), so stamping at
  creation would make every one of them permanent and leave an empty file behind whenever a proposal
  is discarded. `action_create_file_node` never passes `metadata`; only
  `create_file_node_internal` does. That is the whole separation — keep it.
- **App-created text files** (`create_text_node`, `create_home_file`). They share
  `action_create_file_node` with the eager path, and a user creating a file in the app already knows
  where it came from.

## Size and media type are not metadata

The file's size lives on its `files_r2_assets` doc and its media type on `files_nodes.contentType`.
Both are real columns the app already reads, and the Properties dialog shows them as facts above the
map. So do not copy them into the map. A copy would go stale the moment the upload conversion
replaces the bytes or the classifier picks a different type, and the user could delete or edit it,
because everything in the map is the user's to change.

The map is for what only the creating flow knows: where the file came from, and under what name.

# Surfaces

- **Properties modal**: `packages/app/src/components/files/files-properties-modal.tsx`.
  One dialog per node, opened from the sidebar row menu (`Properties`) or the breadcrumb button. It
  holds the node's facts, the read-only checkbox, and a Monaco YAML editor for the map. The editor
  section renders for a file only, because `set_entries` refuses a non-file. It replaced the sidebar
  `Metadata` tab and the separate `Read-only settings` modal; both are gone.
- **Agent tool**: `set_file_metadata` in `packages/app/server/server-ai-tools.ts`. It is in
  `ai_chat_WRITE_TOOL_NAMES`, so Ask mode drops it from the tool record, not only from `activeTools`.
- **Agent search**: `meta search --where '{"exists":"metadata.<key>"}'` and `meta get <file>`, both in
  `packages/app/server/bash-meta-command.ts`. `meta get` prints frontmatter and metadata fields
  together; its `source:` line describes the frontmatter lines only, because `metadata.*` is always
  the committed map.

# Search Box

The Files sidebar and global search filter by metadata and frontmatter with the same language. The
parser, the serializer, and `files_search_query_to_plans` (one filter → `files_metadata_SearchPlan`
values) live in `packages/app/shared/files-search-query.ts`. Both use `FilesSearchInput` for chips and
suggestions. See the `files-explorer-tree` skill under "Search" and "Global Search" for keyboard
behavior, content matching, and the sidebar `q` round trip.

| Token                                                                                                                                          | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status:open`                                                                                                                                  | equals. An unquoted `3` also asks for the number 3, `true` for the boolean; a quoted value asks for the string only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `status:*`                                                                                                                                     | the key exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `title:Rec*`                                                                                                                                   | string prefix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `priority:>2`, `due:<=2026-09-30`                                                                                                              | range on numbers or dates (the `maybe_date` companion docs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `!status:done`                                                                                                                                 | negation, applied on the client                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `assignee:"Denys Voloshyn"`, `"slack:message-id":*`                                                                                            | quoted value, quoted key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `metadata.status:open`, `frontmatter.status:open`                                                                                              | one metadata kind. A bare key asks both kinds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `file.path:/tasks`, `file.name:x`, `file.ext:tar.gz`, `file.ext:m*`, `file.kind:Folder`, `file.updated:2026-09-04`, `file.updated:>2026-09-01` | file fields, matched on the client from the tree, all ignoring case (`file.path:/Tasks` finds `/tasks`). A whole `file.ext` value matches the end of a file's name, so `tar.gz` works although the tree stores `gz` (a folder never matches `file.ext`, not even `v1.2`); a prefix (`m*`) matches that stored last part; a leading dot is ignored. `file.name:x` finds names that contain `x`, `x*` names that start with it, and a leading `*` (`*.md`, for `file.ext` too) gets a problem. `file.kind` takes no prefix (`file.kind:fol*` gets `file.kind is file or folder`). `file.updated` takes a day (the whole local day, like the dates the tree shows) or a date range, never a bare number; a range time with no zone (`>2026-09-04T10:00`) is local too, a time with a zone is taken as it is. `file.path://` is the root. An empty file value (`file.kind:`) gets `file.kind needs a value`; `*` is the wildcard |
| `title:"Recall the"*`                                                                                                                          | prefix with spaces: the `*` sits after the closing quote. Inside the quotes a `*` is text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `"raw media" notes`                                                                                                                            | free text. Quotes only group words: the text keeps them, so it reads back as typed, and the name search ignores them. A text of quotes alone matches nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Value spellings follow YAML, so a value the frontmatter parser stored as a number or a boolean can
be typed the same way: `.5`, `1e3`, `0x10`, and `True` ask for the number or the boolean too. A
date-only range bound is day-inclusive: `due:<=2026-09-30` means before 2026-10-01, and
`due:>2026-09-30` means from 2026-10-01 (the private `range_bound`, in UTC like the stored dates).
An equal filter on a date with a time (`due:2026-09-04T10:00Z`) also asks for the `maybe_date` at
that instant, so a stored `2026-09-04T10:00:00Z` is found although its spelling differs.
`files_search_query_file_updated_matches` applies the same rule to `file.updated` on the client, but
in the local day, because the tree shows local dates, and it reads a time with no zone
(`>=2026-09-04T10:00`) as local time too (the private `local_time_bound`). `vitest.config.ts` pins
`TZ` to Europe/London, so a local-day rule that reads the date as UTC fails its test on any machine,
a UTC one included. A string value is matched exactly, including its case: `status:Open` does not
find `open`, and the value suggestions show the stored spelling, for the prefix typed in the stored
case. A query holds at most `files_search_query_MAX_FILTERS` (20) filters; the 21st gets a problem
and no plan. A token that starts with `http://` or `https://` is free text, so a pasted link never
becomes a `http:` chip.

A quote left open runs to the end of the query. The parser closes it in the last token's `raw`, so
a chip made from `assignee:"Denys` reads back as `assignee:"Denys"` and the chips after it stay
separate (a trailing backslash is escaped first, so the closing quote stays a quote).
`files_search_query_typing_token` gives the token under the caret with the same quote rule, so
the value suggestions keep working inside `assignee:"Denys V`. A closed quote must end the value:
`status:"open"x` gets `Nothing can follow the closing quote`, while `status:""` asks for a stored
empty string, because the value catalog can list one. Single quotes are not quotes, so a value that
starts with `'` gets `Use double quotes, like status:"in progress"` instead of a silent search for
`'Denys`. In the same way `status:!done` gets `Put ! before the key, like !status:done` and
`priority:=2` gets `Drop the =. A plain value is an exact match, like priority:2`, because both
would run as exact matches on the text `!done` and `=2`. `files_search_query_format_value` quotes
a stored value that starts with `'`, `!`, or `=`, so a value picked from the rows reads back as
itself. A range sign with nothing after it (`priority:> 2` ends the token at the space) gets
`Put the number or the date right after >, like priority:>2`, and a quoted bound
(`due:>"2026-09-04"`) gets `Ranges take the number or the date without quotes, like priority:>2`,
because the generic range hint says to quote the value. Inside quotes only `\"` and `\\` are
escapes, so `path:"C:\Program Files"` keeps its backslash. A key the grammar refuses gets
`Keys use letters, digits, _, - and :. Dots join the parts of a frontmatter key`; the message never
says to quote the key, because quoting does not help. A quoted key may carry its namespace inside
or outside the quotes: `"metadata.slack:message-id":x` and `metadata."slack:message-id":x` are the
same filter, and `search_key_text` in the shared input writes the first form back. Only a metadata key
can hold a colon; under `frontmatter` the same key gets the frontmatter grammar problem.

`file`, `frontmatter`, and `metadata` are reserved first segments, so a system field never collides
with a user key: a frontmatter key literally named `file` is written `frontmatter.file`. A metadata
key must match `files_metadata_METADATA_KEY_REGEX` and a frontmatter path
`files_metadata_FIELD_SEGMENT_REGEX`. Both are exported from `shared/files-metadata.ts` and imported
by the parser and by `meta search`, so a key a user can write stays a key that can be searched for.
`files_search_query_qualified_field_is_valid` is that grammar as one check on a qualified field.
The doors use it through `search_qualified_field_is_valid`, which adds the length cap. A key
literally named like a namespace (`file`, `file.*`, `metadata`, `frontmatter.*`) keeps its namespace
in the sidebar's key catalog (`metadata.file`), because typed bare it would read as that namespace.

The doors sit in the search box region of `convex/files_metadata.ts`. Each answers its empty shape
for a membership that is not the caller's.

- `search_nodes({ membershipId, plans, pathPrefix? })` → `{ nodeIds }`. One filter per call: the box
  sends one call per chip and ANDs the answers itself, because it already holds every readable node.
  `pathPrefix` narrows the scan to one folder subtree; `tree_path_upper_bound` stops at `/tasks/`,
  so `/tasks-archive` is out. The sidebar sends the stored path of the node the typed `file.path:`
  names (the tree filter ignores case), and nothing when that node is a file: a file has nothing
  under it, and the tree filter keeps the file by its own path. A string prefix plan scans up to
  `string_prefix_upper_bound` (the prefix's last code point plus one), because Convex sorts strings
  by UTF-8 bytes and `${prefix}\uffff` would miss `op😀`. The ids pass
  `access_control_db_filter_readable_file_nodes`, and there is no "complete" flag on purpose: a
  flag next to fewer ids than the cap would say outright that restricted files matched. The caps
  can still hint at it (a file missing from `status:open` but found under `file.path:`), but never
  name a file. Each plan's index range is read raw (`search_index_query`,
  `take(SEARCH_NODES_DOCS_PER_PLAN)`), and the folder path and the pending overlay are checked on
  the docs read (`search_doc_is_visible`), so the cap bounds the docs read. The paginated agent
  `search` keeps the same rule as query filters in `search_query`. The candidates are also cut at
  `SEARCH_NODES_MAX_SCOPES` (250) distinct restricted folders before the readable-nodes filter,
  because that filter pays one permission check per folder.
- `list_search_fields({ membershipId })` → `[{ qualifiedField, valueKinds }]`, the key catalog for
  the suggestions, in index order. A stored field the other doors refuse (longer than
  `SEARCH_QUALIFIED_FIELD_MAX_LENGTH`; frontmatter has no cap on a key path) is skipped, so the
  catalog never offers a key that then finds nothing.
- `list_search_values({ membershipId, qualifiedField, prefix })` → the string values of one key that
  start with `prefix`, in exact case: `d` does not list `Denys`. The sidebar filters its rows by
  the same rule.
- The two catalog doors name a key or a value only when one of its first
  `SEARCH_CATALOG_SAMPLE_DOCS` docs sits on a file the caller can read
  (`db_search_sample_is_readable`). A member who was given one folder deep inside a large
  restricted tree can miss a key that way. Typing the key still works. Whether a file is readable
  depends on its restricted scope only, so one walk caches the answer per node and per scope
  (`SearchSampleCache`): a workspace with one restricted folder pays for one permission check. The
  samples are read raw as well, and another user's draft among them is dropped in JS. They carry no
  pending overlay: after a draft replaces a committed value, the old value is still suggested and
  then finds nothing. Accepted and pinned by a test: the catalog is a hint, the search is the truth.
- The caps (`SEARCH_NODES_*`, `SEARCH_FIELDS_*`, `SEARCH_VALUES_*`) bound the reads, not the answer.
  A workspace with more matching docs than one plan reads gets a partial answer, and `file.path:`
  narrows the scan. The catalog budgets (`SEARCH_FIELDS_READ_BUDGET`, `SEARCH_VALUES_READ_BUDGET`)
  count index reads, not docs: Convex allows 4096 `db.get` and `db.query` calls per query, and a
  restricted scope's permission check is counted as `SEARCH_SCOPE_CHECK_READS` of them. The walk
  stops early instead of throwing.
- A member whose role has no workspace-wide `content.read` still finds files in folders shared with
  them: `db_get_search_caller` passes `hasWorkspaceRead` to the readable-nodes filter instead of
  refusing. The other way round holds too: a member whose role reads the workspace sees nothing
  from a restricted folder in any door until it is shared with them.
- Archiving a file removes it from every door: `search_nodes` and both catalogs read
  `archiveOperationId: undefined` docs only, so an archived file's keys and values disappear with
  it, and the sidebar skips archived files once a metadata chip is present, negated or not.

# Dialog Reconciliation

The Properties dialog is the only place where a stored map and typed text have to be kept in step, and that is
where its complexity is. Read this before editing it.

The server stores a map, not text, so what comes back is the map rendered again. It rarely matches
what was sent character for character: Monaco can use CRLF, a comment is not stored, `4.0` comes back
quoted, and the render always ends with a newline. The dialog remembers the exact text it sent
(`sentDraftRef`) so the reconcile effect can tell its own echo apart from an edit by somebody else.

Three rules the tests pin but cannot explain. Read them before you change the effect:

- **Never write a ref inside a `setState` updater here.** The app runs in `StrictMode`, which invokes
  the updater twice, and the second pass would see the cleared ref and fall into the conflict branch.
  This shipped as a false "Metadata changed elsewhere" on every save until live QA found it. The
  dialog's tests render under `StrictMode` for exactly this reason.
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
  The `create-time metadata` describe covers the create-flow stamps: an upload's keys, a
  folder import's relative path with empty folders, the eager-create exclusion, the plugin source
  mirror's own `source` value, and the publish leaving the create-time map alone.
- `packages/app/convex/files_pending_updates.test.ts` — a save whose frontmatter the parser cannot
  read still stores the text and writes no metadata docs.
- `packages/app/server/server-ai-tools.test.ts` — the `set_file_metadata` tool.
- `packages/app/server/bash-meta-command.test.ts` — `metadata.*` field parsing.
- `packages/app/src/components/files/files-properties-modal.test.tsx` — the Properties dialog: the
  read-only checkbox in each of its four states, and the YAML draft reconciliation.
