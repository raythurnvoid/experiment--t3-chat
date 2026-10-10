---
name: file-metadata
description: Spec for the flat key-value metadata stored next to a file or folder — the `metadata.*` half of `files_metadata_docs`, the YAML edit format, the two write doors (`files_metadata.set_entries` for the Properties modal and `update_entries_by_path` for the agent), the key grammar and caps, how it sits beside Markdown frontmatter in `meta search`, and the sidebar search box language (`packages/app/shared/files-search-query.ts`) with its doors (the saved-only `files_nodes.search_saved`, `list_search_fields`, `list_search_values`). Use when changing `packages/app/shared/files-metadata.ts`, `packages/app/shared/files-search-query.ts`, the metadata or search box regions of `packages/app/convex/files_metadata.ts`, the Properties modal in `packages/app/src/components/files/files-properties-modal.tsx`, the `set_file_metadata` agent tool in `packages/app/server/server-ai-tools.ts`, or `meta search` / `meta get` in `packages/app/server/bash-meta-command.ts`.
---

# Mental Model

Every file and folder can carry a metadata map: a flat set of keys with scalar values. It is stored
next to the node, outside its content:

- Frontmatter only exists in Markdown. Metadata works on folders and every file kind, including uploads and binaries.
- Frontmatter is part of the file's own text, so an integration that rewrites the content replaces
  it. Metadata survives a content save untouched.

Anybody who may write the node may set any key. There is no
namespace ownership, no per-plugin rule, and no special case: `created-by` and `slack-message-id` are
ordinary keys that some team agreed on. If a folder has a house convention, it belongs in that
folder's `README.md`, not in code.

`plugin-name` is an editable opt-in for plugin file doors. Only an exact string match selects the
node. `source: plugin` describes its origin and does not select it. Neither key grants capabilities,
membership, permissions, or a lock bypass. Changing a label never detaches a reader binding.

The stored form is validated structured data, not a text blob. YAML is only the edit format the
Properties modal shows and parses. Nothing stores YAML.

# Data Shape

One entry is `{ key: string; value: string | number | boolean }` (`files_metadata_Entry` in
`packages/app/shared/files-metadata.ts`). No nesting, no arrays, no null.

Entries are indexed in the same `files_metadata_docs` table that Markdown frontmatter uses. The
`fieldPath` prefix is what tells the two sources apart:

| Source | Prefix | Written by |
| --- | --- | --- |
| Markdown YAML frontmatter | `frontmatter.` | content materialization, from the file's own text; for a file with collaboration turned off there is no materialization, so the content replacement door writes it instead |
| Metadata next to the file or folder | `metadata.` | a user in the Properties modal, an agent, or a file-creation flow (see "Metadata Written By The File-Creation Flows") |

Both prefixes are exported from `shared/files-metadata.ts`. A range over one source bounds at
`frontmatter/` or `metadata/`, because `/` (0x2F) is the next character after `.` (0x2E), so the
range covers exactly that prefix and nothing else.

Per key, `files_metadata_db_write_entries` writes one `field` doc (existence search) and one `value` doc (value
search). A date-like string value also gets the `maybe_date` companion, exactly like frontmatter, so
range search over dates works. Value docs carry `entryIndex`, the key's position in the map the user
typed — reading the map back in index order would reorder the dialog's lines on every save.
Frontmatter docs leave `entryIndex` unset.

Committed `field` docs, of both sources, also carry the folder table's sort fields: `parentId`,
`nodeKind`, `isRestrictedScopeRoot`, `name`, `sortName`, `sortValue`, and `sortDisplayValue` (built
by `committed_field_sort_fields` in `files_metadata.ts`). Value docs and pending docs never carry
them. `sortValue` is the value as text, through `files_sort_value_of` in `shared/files-sort.ts`: a
number as `String(value)`, a boolean as `true`/`false`, a list by its first item, `maybe_date`
skipped. A key with no plain value (a frontmatter map parent) has no `sortValue`, so the file sorts
with the missing rows. `sortDisplayValue` is the typed value the table shows. Every writer that
changes a node's name, parent, or restriction also patches these fields on its committed field docs.
A restrict or unrestrict patches archived docs too, because a restore does not rewrite the flag. See the `files-explorer-tree` skill, "Folder Contents".

Sort is text only, so dates sort in time order only when they share one format and time zone. A
later date sort mode would reuse the `maybe_date` companion that search already writes, so search
and sort keep one date parser.

Saved files keep `metadata.*` docs as `sourceKind: "committed"`, even during a pending content edit.
Private files and folders keep their map in `createIntent.metadata` and index it as `sourceKind: "pending"`.
Save publishes that map with the new saved node. Discard removes the private map with its proposal.

The table has strict committed and pending variants. Committed docs use a real `fileNodeId`.
Pending frontmatter and private metadata docs use a saved/private `target`, owner, proposal ID, and proposal revision.
Pending docs always belong to a real organization and workspace. Committed Mount files use their
volume id as the storage scope and keep the real owning organization. Saved move and cleanup paths query both
the committed file index and the pending target index. Marking content for rebase hides its old
frontmatter until preparation rebuilds it.

# Rules

- **The whole map is replaced by one save.** `set_entries` takes the whole YAML document, so a
  key missing from it is deleted. The agent door is the opposite: `update_entries_by_path` changes only
  the keys it names.
- **A key already in the map keeps its position.** New keys are appended where the caller first named
  them. `files_metadata_apply_set_and_remove` owns this.
- **Remove wins over set.** A key listed in both is removed, so a confused call cannot leave behind a
  key the caller asked to delete.
- **A key named twice keeps its last value**, whether or not the file already had that key.
- **Metadata uses `content.write`.** There is no separate permission. A read-only node refuses
  metadata writes too, exactly like its content.
- **Private metadata stays private.** The agent write door resolves the owner's current path and
  checks the current saved parent permission and write policy. Preparing drafts refuse writes.
  A ready draft's metadata write advances its proposal revision and expiry, keeps its text and
  frontmatter indexes current, and replaces only its `metadata.*` docs. It creates no saved node.
- **Caps** (all in `shared/files-metadata.ts`): 128 keys, 128 characters per key, 1024 characters per
  string value, and 16 KiB for the YAML document. Both doors enforce the document cap — the agent
  writes entries, so its door measures the document those entries would make. Without that the agent
  could store a map the dialog renders but refuses to save.
- **Key grammar** is `/^[\p{L}\p{N}_-]+$/u`: letters (in any language), numbers, `_` and `-`. A colon
  is never part of a key, so a key never needs quotes and `a:b:c` splits at the first colon. The dot is
  left out, because `metadata.a.b` would read like the real nesting `frontmatter.a.b` means.
- **Design direction.** The search and filter grammar is tuned so a whole query is a plain string
  that is easy to put in a URL (like `?q=` or the folder table's `filter=`). Prefer characters that
  need no escaping. `:` separates the parts of a token, so no key may hold it. A "not" operator is
  not planned for the folder table. Check this note before changing the key grammar or adding syntax.
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

### TODO: report unreadable frontmatter to the user

Today, unreadable frontmatter is only logged on the server. The file still saves.
Plan a general `problems` table with generic pointers to files, workspaces, plugins, or other resources.
Show a UI list that says what the app could not do and why, in plain words.
The first problem kind is unreadable frontmatter: the file's frontmatter is not indexed.
See the warnings in [r2.ts](../../../packages/app/convex/r2.ts#L857) and [files_metadata.ts](../../../packages/app/convex/files_metadata.ts#L155) ([pending content](../../../packages/app/convex/files_metadata.ts#L229)).
The nearest pattern is the [too-large marker pair](../../../packages/app/convex/schema.ts#L746)
and its [file banner](../../../packages/app/src/components/files/file-node-view/file-node-view.tsx#L561).

# Write Doors

Both live in the `// #region file metadata` of `packages/app/convex/files_metadata.ts`.

`set_entries` — the Properties modal's door, a public mutation:

1. auth
2. `files_tree_write` rate limit (the bucket other per-node property writes use)
3. membership owned by the caller and active
4. node load and tenancy compare; files and folders are accepted
5. ACL on the node (`content.write`, passing the `fileNode` so a restricted folder is resolved)
6. `files_node_require_writable`
7. parse the YAML, then write

`update_entries_by_path` — the agent's door, an internal mutation. It resolves the owner's current
saved or private path with the bounded visible reader. It checks active membership, read and write
access, and the saved node or private draft parent's write policy in the same transaction.
Agent calls carry `agentSource`. The mutation also checks the original chat creator and captured
membership lifetime, and allows only the current workspace or the caller's own personal/home.
Leaving and rejoining the source team does not revive an old metadata write. Agent metadata reads
and searches carry the same source check; normal Properties reads keep their own membership rules.
Saved metadata changes immediately. Private metadata stays in the create proposal until Save.

`get_by_path` reads the same owner tree. It returns a tagged `target`, the current path, and current
metadata/frontmatter fields. Preparing private drafts return null. Service accounts and read-only
mounts use saved content only. Bash `meta get --format json` and `meta search --format json` return
tagged targets too.

`get_entries` is a public query and returns `[]` for a non-member or an unreadable node. It throws
only when Convex auth has no usable identity.

# Metadata Written By The File-Creation Flows

The two doors above are the only doors a person or an agent can knock on. The file-creation flows
write the map directly with `files_metadata_db_write_entries`, exported from `files_metadata.ts`.
They write initial metadata once. Later content writes and repeated ensure calls leave it unchanged.

That writer checks nothing on purpose. A create runs before anybody could have an opinion about
that file, and mount files and plugin source mirrors are created read-only with a SYSTEM author, so
`db_authorize_metadata_write` and `files_node_require_writable` would refuse the very writes that
say where the file came from. Keep both doors as they are for user writes.

`files_nodes_db_create_node_recursively_at_path` applies `metadata` to the leaf file or folder only.
Its internal `createdNodesMetadata` argument supplies initial keys on every new node. Leaf keys take
precedence. Reused nodes keep their maps. Plugins use it for `source` and `plugin-name`; upload names
stay on the leaf.

| Flow | Entrypoint | Keys |
| --- | --- | --- |
| Browser file upload | `files_nodes.create_upload_node` | `source: upload`, `original-name` |
| Browser folder import | `files_nodes.create_upload_nodes` | `source: upload`, `original-name`, `import-relative-path` |
| Plugin service-grant upload | `public_api_service_uploads.create_upload_target` | `source: plugin`, `original-name`, `plugin-name` |
| User API write / touch / upload-urls | `public_api.ts` | `source: api` |
| Plugin invoke or upload-run write / touch, service write, folder ensure | `public_api.ts`, `public_api_plugin_files.ts` | `source: plugin`, `plugin-name` on every new node |
| Operator data import | `data_import.create_upload_targets` | `source: import`, `original-name` |
| GitHub mount file | `files_nodes_content.create_file_node_internal`, GITHUB scope | `source: github-mount`, `repo-path` |
| Plugin Mount file | `public_api_volumes.finalize_write`, volume scope | `source: plugin-volume`, `volume-path` inside that volume |
| Plugin source mirror | `files_nodes_content.create_file_node_internal`, PLUGINS scope | `source: plugin-source` |

`repo-path` is the path inside the repository. The stored path starts with the mount name and the
commit sha, so that root is cut off before the value is stored.

## Copies and new text files

- A new copy keeps ordinary source metadata in its captured create intent. Accept writes that map
  with the saved node. A replacement keeps the destination's metadata and policy.
- Agent text writes and `mkdir` reserve private nodes. Their create intents start without source
  stamps. The owner can edit the private map through `update_entries_by_path`; Accept saves it.
- App-created text files (`create_text_node`, `create_home_file`) also start without source stamps.
  A user creating a file in the app already knows where it came from.

## Size and content type are not metadata

The file's size lives on its `files_r2_assets` doc and its content type on `files_nodes.contentType`.
Both are real columns the app already reads, and the Properties dialog shows them as facts above the
map. So do not copy them into the map. A copy would go stale the moment the upload conversion
replaces the bytes or a `cp` gives the file another type, and the user could delete or edit it,
because everything in the map is the user's to change.

The node keeps its own copy of the byte size in `files_nodes.contentByteSize`, for the table's file.size
sort. The writers that change `assetId` keep it current. It is not part of the map either.

The map holds member-defined labels and details recorded by creation flows.

# Surfaces

- **Properties modal**: `packages/app/src/components/files/files-properties-modal.tsx`.
  One dialog per node, opened from the sidebar row menu (`Properties`) or the breadcrumb button. It
  holds the node's facts, the local write-policy control, and a Monaco YAML editor for the map. The editor
  section renders for files and folders. Its editor name is `Metadata YAML`. Collaboration controls stay file-only.
  The section keeps one short description. A help button (`How metadata works`) next to the heading
  opens a second dialog that explains the format with short examples for non-technical users. The
  examples are colored by `monaco.editor.colorize`, so they match the editor. It also lists a few search box filters. Keep all of it in step with the key
  grammar, the `maybe_date` format, and the search box language below. While the draft is empty and the item is editable,
  example lines are drawn over the editor as a placeholder, because Monaco has no placeholder
  option. It replaced the sidebar
  `Metadata` tab and the separate `Read-only settings` modal; both are gone.
  The facts at the top (type, size, location, dates, authors) are `label: value` lines in a read-only Monaco
  editor with the dim read-only focus ring.
  The dialog has one footer with `Close` and `Save`. Each section reports its unsaved state
  (`onSaveStateChange`), and `Save` writes every changed section. It is enabled only when a section
  has edits and none is invalid. The subtitle shows the node path from the root, with a leading `/`.
- **Agent tool**: `set_file_metadata` in `packages/app/server/server-ai-tools.ts`. It is in
  `ai_chat_WRITE_TOOL_NAMES`, so Ask mode drops it from the tool record, not only from `activeTools`.
  It requires `workspace: "current" | "personal"` beside its root-relative path. The backend resolves
  the selected workspace; a path or a model-supplied ID cannot add another workspace.
- **Agent search**: `meta search --where '{"exists":"metadata.<key>"}'` and `meta get <path>`, both in
  `packages/app/server/bash-meta-command.ts`. `meta get` prints frontmatter and metadata fields
  together; its `source:` line describes the frontmatter lines only, because `metadata.*` is always
  the committed map.

Folder metadata participates in sidebar and global search. Rename, move, archive, and restore update
its indexed scope with the folder's own path, including nested and archived descendants. Folder
pending moves keep the committed map and the existing per-user search overlay. True deletion removes
both field and value docs. File copy does not copy metadata; folder copy is unsupported.

# Folder Table Fields

The table's key list reads the catalog's `parent` family: the saved keys on the direct children of
the open folder (see "Catalog" and "Suggestions"). It never pages the file rows or scans another
folder.

The three public queries live in the `folder table fields` region of `convex/files_metadata.ts`.
Like the folder table, they are saved-only: they read committed docs and never pending docs (see
the `files-explorer-tree` skill, "Saved-only lists").

- `list_folder_fields({ membershipId, savedStream?, parentId, prefix, paginationOpts })` returns a
  page of field paths (at most 50) on the folder's children that start with `prefix`, ignoring case. It is
  one range of the `parent` family in one stream (see "Suggestions" for streams). The folder must be
  a readable, active folder of the membership's workspace; `"root"` needs workspace-wide
  `content.read`. Every refusal gives the same empty, done page. Keys of restricted children count
  for every member too (the accepted leak in "Suggestions").
- `list_node_fields({ membershipId, target, cursor })` returns
  `{ fields, continueCursor, isDone }`. It seeks distinct committed field paths of one saved node,
  so a 400-item list costs one key candidate. The cursor belongs to the membership and target.
- `get_field_values({ membershipId, target, fields, afterField })` returns
  `{ values, afterField, isDone }`. Request one to seven distinct qualified fields in ascending
  text order. `afterField` is null or one of those fields.

`list_node_fields` and `get_field_values` check the node on every call; a prior table row or field
catalog is not proof of current access. They load the saved node with
`files_metadata_db_get_table_node`: it checks the organization, workspace and active state, then
calls `access_control_db_authorize_membership` with `content.read` and the node. A private target,
a missing node, or a refusal returns null. Each field value comes from
`files_metadata_db_get_table_field`, which throws when the committed field doc does not belong to
the node.

Rows use committed metadata and frontmatter, also while their owner edits pending text.
The stored field doc's `sortDisplayValue` is the cell value. It preserves `false`, `0`, and `""`.
A list displays its first plain primitive in extraction order. Date companion docs do not change
that value. Empty lists, map parents, and absent keys return an explicit `null` cell value. Every
read doc must be a committed doc of the same tenant and node; a mismatch throws.

`list_node_fields` reads at most 50 distinct candidates, including invalid keys and an end probe.
Only search-valid qualified keys are returned. `list_node_fields` and `get_field_values` use
whole-query transaction metrics and a local doc byte count. They keep a 4 MiB read budget and a 1,000-call budget, with
1 MiB and 16 calls reserved before the next read. Cell pages advance only after a whole field is
finished. A budget stop returns the completed prefix; no first progress throws a clear query error.

Missing membership or target access returns null. Missing current-user auth throws `Unauthenticated`.
A grant-only member gets an empty, done ordinary catalog at the root. A readable archived folder
gets an empty, done catalog too.

# Folder Table Filter

The table applies one structured filter through `files_nodes.list_tree_children_sorted`: one
filter, or `name starts with` plus one "is" filter. The shared type and predicate live in
`shared/files-table.ts`; the reused Convex validator lives in `convex/schema.ts`. This filter is
separate from the search language below. The `files-explorer-tree` skill lists the operations and
the order each filter sets.

A metadata filter reads only committed field docs, through the same index as a metadata sort,
`by_org_ws_source_archive_docKind_field_parent_restricted_sort`:

- `is` reads one `sortValue` (`files_sort_text_key` of the value), in name order. A
  `name starts with` next to it is one more range on `sortName`.
- `starts with` reads a `sortValue` range up to `string_prefix_upper_bound`, in value order. The
  value cannot end in a digit, because the key writes a number with its length first.
- `present` reads every doc with a value (`sortValue >= ""`), in value order.

There is no metadata `missing` filter: finding the rows without a key would need a scan. Pending
edits never change a filter result.

A member's shared restricted children come from share rows, which copy no metadata. So a metadata
filter or sort does not show them; the table says so (see the `files-explorer-tree` skill).

# Folder Table Sort Keys

A sort has one clause (`files_sort_MAX_CLAUSES` is 1). A metadata clause uses the committed field
doc's encoded `sortValue`. Pending edits on saved nodes do not replace it. A metadata sort shows
only the rows that have the key: its stream reads the field docs with a value.

The row key is `{ parts, nameKey }` from `shared/files-sort.ts`, with one part: the index suffix
(`[sortValue, sortName, name]` for a metadata key). A null part sorts last in either direction,
by name A to Z.

# Search Box

The Files sidebar and global search filter by metadata and frontmatter with the same language. The
parser, the serializer, and `files_search_query_to_plans` (one filter → `files_metadata_SearchPlan`
values) live in `packages/app/shared/files-search-query.ts`. Both use `FilesSearchInput` for chips and
suggestions. See the `files-explorer-tree` skill under "Search" and "Global Search" for keyboard
behavior, content matching, and the sidebar `q` round trip.

| Token                                                                                                                                          | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `metadata.status:open`                                                                                                                                  | equals. An unquoted `3` also asks for the number 3, `true` for the boolean; a quoted value asks for the string only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `metadata.status:*`                                                                                                                                     | the key exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `metadata.title:Rec*`                                                                                                                                   | string prefix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `metadata.priority:>2`, `metadata.due:<=2026-09-30`                                                                                                              | range on numbers or dates (the `maybe_date` companion docs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `!metadata.status:done`                                                                                                                                 | negation is not supported. It gets the one-clause problem `Search for words or one filter, not both. You can add a folder.`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `metadata.assignee:"Denys Voloshyn"`, `metadata.status:"in progress"`                                                                                            | quoted value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `metadata.status:open`, `frontmatter.status:open`                                                                                              | a key of one kind. A key with no `metadata.`, `frontmatter.` or `file.` is free text, not a filter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `file.path:/tasks`                                                                                                                             | the folder to search in, next to the free text or one filter. Alone it asks for that exact path, with its case. `file.path://` is the root, which scopes nothing. `*` (`file.path takes a folder path, without *`), a range, or an empty value gets a problem. `file.path` and `file.link` are the only file fields (`files_search_query_FILE_FIELDS`). `file.name:x` gets `Type the name as plain text.`, and `file.extension`, `file.kind` and `file.updated` get `file.<field> is not supported in search. Use the folder table filters.` |
| `file.link:public`                                                                                                                             | the saved files that have a public link. `public` is the only value, in any case. The server answers it (see below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `metadata.title:"Recall the"*`                                                                                                                          | prefix with spaces: the `*` sits after the closing quote. Inside the quotes a `*` is text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `"raw media" notes`                                                                                                                            | free text. Quotes only group words: the text keeps them, so it reads back as typed, and the name search ignores them. A text of quotes alone matches nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

`file.link:public` is the one file field that the server answers. It finds the saved files of the
workspace that have a public link ("Anyone with the link can view"). `file_field_problem` accepts only
the value `public`, in any case, so `file.link:Public` works. A prefix (`file.link:pub*`) or another
value gets `file.link takes public, like file.link:public`. `file.link:*` and an empty value get
`file.link needs a value`, and a range gets `file.link does not support ranges`.

`useFilesSearchSaved` sends a `file.link:public` chip to `files_nodes.search_saved` as the `link`
clause. It pages the workspace's `files_share_links` (at most 500 per workspace) and returns only
saved, active files the caller may read, never the token. A `file.path` chip scopes it to that
folder. A member with no workspace-wide `content.read` still gets the linked files shared with them.
Negation (`!file.link:public`) is not supported: the search box takes one clause, and a NOT gets
"Search for words or one filter, not both. You can add a folder." `FilesSearchInput` names the chip
"Link" and suggests `public` after `file.link:`. The Files tree reads
`files_share_links.list_workspace_links` for its public link mark (see the `files-explorer-tree`
skill).

Value spellings follow YAML, so a value the frontmatter parser stored as a number or a boolean can
be typed the same way: `.5`, `1e3`, `0x10`, and `True` ask for the number or the boolean too. A
date-only range bound is day-inclusive: `metadata.due:<=2026-09-30` means before 2026-10-01, and
`metadata.due:>2026-09-30` means from 2026-10-01 (the private `range_bound`, in UTC like the stored dates).
An equal filter on a date with a time (`metadata.due:2026-09-04T10:00Z`) also asks for the `maybe_date` at
that instant, so a stored `2026-09-04T10:00:00Z` is found although its spelling differs.
The search box has no `file.updated` any more. The folder table bar reads a `file.updated` day as
the local day (`files_folder_table_query_to_filter` takes the browser's `getDayBounds`).
`vitest.config.ts` pins `TZ` to Europe/London, so a local-day rule that reads the date as UTC fails
its test on any machine, a UTC one included. A string value is matched exactly, including its case: `metadata.status:Open` does not
find `open`, and the value suggestions show the stored spelling, for the prefix typed in the stored
case. A query runs one clause (the free text or one filter) and one `file.path` folder. Every other
chip gets `Search for words or one filter, not both. You can add a folder.` and no plan. A token
that starts with `http://` or `https://` is free text, so a pasted link never becomes a `http:` chip.

A quote left open runs to the end of the query. The parser closes it in the last token's `raw`, so
a chip made from `metadata.assignee:"Denys` reads back as `metadata.assignee:"Denys"` and the chips after it stay
separate (a trailing backslash is escaped first, so the closing quote stays a quote).
`files_search_query_typing_token` gives the token under the caret with the same quote rule, so
the value suggestions keep working inside `metadata.assignee:"Denys V`. A closed quote must end the value:
`metadata.status:"open"x` gets `Nothing can follow the closing quote`, while `metadata.status:""` asks for a stored
empty string, because the value catalog can list one. Single quotes are not quotes, so a value that
starts with `'` gets `Use double quotes, like metadata.status:"in progress"` instead of a silent search for
`'Denys`. In the same way `metadata.status:!done` gets `Put ! before the key, like !metadata.status:done` and
`metadata.priority:=2` gets `Drop the =. A plain value is an exact match, like metadata.priority:2`, because both
would run as exact matches on the text `!done` and `=2`. `files_search_query_format_value` quotes
a stored value that starts with `'`, `!`, or `=`, so a value picked from the rows reads back as
itself. A range sign with nothing after it (`metadata.priority:> 2` ends the token at the space) gets
`Put the number or the date right after >, like metadata.priority:>2`, and a quoted bound
(`metadata.due:>"2026-09-04"`) gets `Ranges take the number or the date without quotes, like metadata.priority:>2`,
because the generic range hint says to quote the value. Inside quotes only `\"` and `\\` are
escapes, so `metadata.path:"C:\Program Files"` keeps its backslash. A key the grammar refuses gets
`Metadata keys use letters, digits, _ and -` or
`Frontmatter keys use letters, digits, _ and -, joined by dots`. Keys are never quoted.

`file`, `frontmatter`, and `metadata` are the required first segment of a key, so a system field never collides
with a user key: a frontmatter key literally named `file` is written `frontmatter.file`. A metadata
key must match `files_metadata_METADATA_KEY_REGEX` and a frontmatter path
`files_metadata_FIELD_SEGMENT_REGEX`. Both are exported from `shared/files-metadata.ts` and imported
by the parser and by `meta search`, so a key a user can write stays a key that can be searched for.
`files_search_query_field_path_is_valid` is that grammar as one check on a qualified field, with the
`files_search_query_FIELD_PATH_MAX_LENGTH` (160) cap. A key must start
with its namespace (`file.`, `frontmatter.` or `metadata.`). A token like `status:open` has no
namespace, so it is free text and never a filter. The sidebar's key catalog lists qualified keys only.

The folder table has its own bar and its own token string (`filter=` in the URL). It reuses the
field names and the tokenizer from `files-search-query.ts` and adds `sort_by:`. The grammar and the
URL cleaner live in `shared/files-folder-table-query.ts`; the `files-explorer-tree` skill describes
the bar under "Table filter and sort bar".

The doors sit in the search box region of `convex/files_metadata.ts`, except `search_saved`. Each
answers its empty shape for a membership that is not the caller's.

- `files_nodes.search_saved({ membershipId, clause, folderPath?, paginationOpts })` is the
  saved-only door (`convex/files_nodes.ts`). The box shows no drafts, not even the caller's own.
  A `metadata` clause carries one plan of `files_search_query_to_plans`, so a chip with two plans
  is two paginated calls. It reads `files_metadata_db_query_saved_plan`: the committed-only indexes
  `by_org_ws_source_archive_docKind_field_*` with `sourceKind = "committed"`. With a folder only
  `eq` and `exists` run, as a `treePath` range of the folder's stored `treePath`; `prefix` and
  `range` with a folder get an empty page. Each row reads its node with one `get`, then one batch
  read check. The split guard is 400 (comment at `SEARCH_SAVED_SPLIT_GUARD`). String prefix plans
  use `string_prefix_upper_bound`, which includes non-BMP text such as `op😀`.
- `files_search_db_create_reader` serves the agent's `search`. It shares owner, ancestor, and permission reads across indexed results. It checks
  active membership, private ownership, current proposal id and revision, readiness, and read
  access. Ready private drafts use captured metadata and pending frontmatter. Saved metadata stays
  current beside pending text; ready pending frontmatter replaces committed frontmatter. Other
  owners, old proposal revisions, preparing drafts, and hidden destinations never produce a result.
- `list_search_fields`, `get_search_field` and `list_search_values` are the suggestion doors. They
  read the catalog, not the source docs. See "Suggestions".
- A member whose role has no workspace-wide `content.read` still finds files in folders shared with
  them: `search_saved` passes the tree reader's `hasWorkspaceRead` to the readable-nodes filter
  instead of refusing. The other way round holds too: a member whose role reads the workspace never gets a
  file of a restricted folder from `search_saved` until it is shared with them. The suggestion
  doors do not follow this rule (the accepted leak in "Suggestions").
- Archiving a file removes it from every door: `search_saved` reads `archiveOperationId: undefined`
  docs only, and the catalog counts active docs only, so an archived file's keys and values
  disappear with it (after the catalog lag). `search_saved` reads saved, active rows only, so the
  search box never lists an archived file.

# Catalog

`files_metadata_catalog` counts the saved metadata keys and short string values of each workspace, so a
suggestion read can be one index range at any size. Convex has no "distinct values" or prefix search. The
leaf module `server/files-metadata-catalog.ts` holds the rules; its header is the full description.

- **Families.** `key`: one row per field path, with `count` (field docs) and `kindCounts` (value docs per
  kind). `value`: one row per field path and string value. `parent`: one row per folder (or `"root"`) and
  field path of its children's field docs, for the folder Columns menu. Each row also keeps
  `fieldPathLower`, so a key prefix matches without case.
- **What counts.** Saved (`committed`), active (no `archiveOperationId`) docs of real workspaces, whose path
  passes `files_search_query_field_path_is_valid` (the grammar and at most 160 characters). Only string
  values whose encoded payload is at most 1,024 bytes get a value row (UTF-8 bytes plus one byte per
  U+0000, `files_metadata_catalog_value_is_short`): longer index keys share a buffered prefix group in
  Convex, so a page of them is not a real read bound. A long value still counts in its key's string kind.
  Drafts, global and plugin volume workspaces never count. Restriction is not part of any row, so a
  restrict writes nothing here, and Columns shows keys of restricted children to every member too.
- **Move views.** A doc tagged with a Move cohort's `moveView` counts in the rows of that view, like share
  rows. Readers merge the normal rows with the visible view's rows, so a key never disappears or doubles
  while a Move stages, publishes, cleans up or aborts. Publication writes nothing here.
- **Writes.** The overlay wrapper adds every committed metadata insert, patch and delete to a change map,
  tagged Move and materializing writes too; a patch of none of `files_metadata_catalog_SOURCE_FIELDS` needs
  no old doc. Every flush call inserts one delta per changed row (`files_metadata_catalog_deltas`) and
  clears the map, so a walk that flushes before each child counts each change once. A save that keeps
  every contribution writes nothing. Savers only insert deltas and read the workspace marker
  (`files_metadata_catalog_compactors`); the first saver inserts the marker and schedules the compactor.
  No saver patches a shared doc, so parallel saves of the same key do not conflict.
- **Compactor** (`compact_metadata_catalog` in `convex/files_pending_overlay.ts`). Each run gets its marker
  by id (a missing marker ends the chain), applies up to 500 deltas older than 5 seconds to their rows,
  deletes them, and schedules itself again while any delta is left; otherwise it deletes the marker. Drift
  (a count below 0) never throws: it clamps to 0 and logs one `files_metadata_catalog drift` line per run,
  with no value. Runs apply deltas in creation order and a doc is added before it is removed, so only a
  count below 0 is drift. A key row lives until its `count` and all its `kindCounts` are 0. A paged writer
  (Move staging and cleanup, 8 docs per transaction) can write a key's field doc and its value docs in two
  transactions, so between two runs a key row can have `count` 0 and value kinds. That is not drift: the
  doors show the key for those few seconds, and the next run settles the row. Every saved value doc has a
  field doc, so a settled catalog has no such row, and the check reports a stuck one as an extra row. A
  new key shows after about 5 to 15 seconds. The `recover metadata catalog compactors` cron (every 15
  minutes) starts a run for a marker whose oldest delta waited more than 10 minutes.
- **Rebuild and check** (`rebuild_metadata_catalog`, `check_metadata_catalog` in
  `convex/files_pending_overlay.ts`). Run them only in a quiet window: every source writer stopped, also
  scheduled jobs, until the check ends. Both refuse while a Move cohort holds the workspace. A rebuild puts
  a new `clearing` marker in place of the old one (older rebuild jobs and compactor runs then stop), deletes
  100 docs per job, sets the marker to `seeding`, and pages the saved docs on
  `by_organization_workspace_source_fileNode` (100 docs or 1 MiB per page). A file's key deltas wait for
  its last doc, so no key row shows kinds without its field count between two pages. The compactor runs between pages and
  keeps a `seeding` marker; the last page sets it to `draining`. Mode `catalog` replaces every row and
  fixes drift. Mode `check` counts into the shadow families `check_key`, `check_value` and
  `check_parent`; then page `check_metadata_catalog` to the end (it compares each row with its shadow
  and each shadow with its row, and names ids, paths and counts, never a value), and run mode
  `clear_check` to delete the shadows. Suggestion reads never read the `check_*` families.
- **Cost.** About one delta insert per changed row, then one row write per distinct row per compactor
  batch. At the largest node (896 docs, 160-character keys, 1,024-byte values) a full replacement in one
  transaction measured 4,097 writes and 3.7 MB written, and a compactor run 2,002 docs read and 1,000
  writes (`files_pending_overlay_limits.test.ts`, "metadata catalog").
- **Accepted leak.** Every member reads every row. See "Suggestions".

# Suggestions

The search box, the global search palette, the folder filter bar and the Columns menu suggest keys
and values from the catalog. Each read is one index range, so it costs the same at any workspace size.

- **Doors** (search box region of `convex/files_metadata.ts`, plus `list_folder_fields` above):
  - `list_search_fields({ membershipId, savedStream?, prefix, paginationOpts })` → a page of
    `{ fieldPath, valueKinds }` from the `key` family.
  - `get_search_field({ membershipId, fieldPath })` → `{ valueKinds }` or null. It reads the exact key
    row in the normal stream and the visible Move view. The search box uses it to offer `true` and `false`.
  - `list_search_values({ membershipId, savedStream?, fieldPath, prefix, paginationOpts })` → a page of
    string values from the `value` family.
  - `list_folder_fields` (see "Folder Table Fields") → a page of keys from the `parent` family.
  - Pages hold at most 50 rows (`SEARCH_PAGE_MAX_ITEMS`). A prefix longer than 160 characters (keys) or
    200 (values) matches nothing and gets an empty, done page. So does a membership that is not the caller's.
- **Matching.** A key matches by its start, ignoring case (`fieldPathLower`,
  `files_metadata_catalog_lower`). A value matches by its start in exact case: `d` does not list
  `Denys`. Rows come in index order; `files_metadata_catalog_key_order` gives the same order in the
  browser. There is no "contains" match.
- **What is suggested.** Saved, active keys whose path passes `files_search_query_field_path_is_valid`
  (at most 160 characters), and string values of at most 1,024 encoded bytes. A longer value saves and
  can be searched for, but is never suggested. A key or value that exists only in a draft is not
  suggested, and a saved value stays suggested while its owner has a draft that changes it.
- **Lag.** A new or removed key or value shows after the compactor runs, about 5 to 15 seconds. The
  browser also waits 150 ms after typing before it asks.
- **Streams.** Each door reads one stream: the normal rows, or the rows of one Move view
  (`savedStream`). `useFilesMetadataCatalogPages` (`src/hooks/files-metadata-catalog-hooks.ts`) reads the
  normal stream and the visible view's stream and merges them with `files_merge_sorted_streams`, so a
  key shows once while a Move runs. Value kinds are joined across the streams.
- **Namespace prefixes** (`files_metadata_catalog_key_prefixes`). A typed `metadata.st` sends one
  prefix. A bare `st` sends `frontmatter.st` and `metadata.st`. A start of a namespace name (`meta`,
  `front`) sends that whole namespace (`metadata.`). The hook pages each prefix and joins the pages.
- **Held rows.** While a new prefix waits for its debounce or its first page, the list keeps the last
  rows, disabled, with "Updating suggestions…". They clear when the membership, the folder or (for
  values) the key changes.
- **Show more.** "Show more keys", "Show more values" and "Show more fields" load 50 more rows of every
  stream that has more. There is no row cut in the browser. While a page loads the row has
  `aria-busy` and ignores clicks.
- **No match.** After the first page ends empty: "No keys start with …" (or "No saved keys yet"), "No
  saved values start with …", and in Columns "No fields start with …". The search box keeps plain
  words: when the typed word starts no key, it lists every key, and a picked key is added after the
  words as a new filter (`onUnmatched`).
- **Errors.** Each list sits in its own TanStack `CatchBoundary` above the component that calls
  `usePaginatedQuery`, because the hook throws query errors. The error view says "Could not load
  suggestions." (Columns: "Fields could not be loaded") with a Retry that resets the boundary. The
  boundary also resets when the request changes. The typed text stays.
- **Accepted leak until a search engine arrives (user, 2026-10-08).** Any member, guests included,
  sees every catalog row of the workspace: keys and values of files they cannot open, and keys of
  restricted children in Columns. Search results, opening a file and the folder gate stay
  access-checked. This replaces the old rule that a restricted file's keys and values stay hidden. A
  search engine must fix this: it counts keys and values over only the files the caller can read
  (owner: all; member: open files plus shared restricted files; guest: files in shared folders).
  Then delete the catalog tables, the leaf module, the overlay hook, the compactor, its cron, the
  rebuild and check tools and the data deletion pass. "Starts with" can become "contains" again.

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
  ~384 index docs per call. `set_node_write_policy` has no quota leg either, so this is consistent —
  revisit it as a product decision, not as a hole.
- No dedicated chat renderer for the tool call. It falls back to the generic unknown-tool disclosure,
  which shows name, parameters, and result.

# Tests

- `packages/app/shared/files-metadata.test.ts` — parse, stringify, validate, apply-changes, index docs.
- `packages/app/convex/files_nodes.test.ts` — the `metadata` tests: search next to frontmatter,
  surviving a content save, the pending-overlay exemption, refusals, and the agent door on an upload.
  The `create-time metadata` describe covers the create-flow stamps: an upload's keys, a
  folder import's relative path with empty folders, the plugin source
  mirror's own `source` value, and the publish leaving the create-time map alone.
- `packages/app/convex/files_pending_updates.test.ts` — a save whose frontmatter the parser cannot
  read still stores the text and writes no metadata docs.
- `packages/app/server/server-ai-tools.test.ts` — the `set_file_metadata` tool.
- `packages/app/server/bash-meta-command.test.ts` — `metadata.*` field parsing.
- `packages/app/src/components/files/files-properties-modal.test.tsx` — the Properties dialog: the
  write-policy control in each of its four states, and the YAML draft reconciliation.
