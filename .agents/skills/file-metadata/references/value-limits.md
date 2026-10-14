# Full values, search copies, and previews

Decision agreed with the user on 2026-10-14.

| Use | Limit |
| --- | --- |
| One full metadata string | 32 KiB of valid UTF-8 |
| Whole metadata map | 128 KiB when rendered as canonical YAML |
| Keys in one map | 128 |
| Search input string | 1,024 UTF-16 units |
| Stored search prefix | 1,025 units; 1,026 when needed to keep a surrogate pair whole |
| Table text preview | 256 Unicode code points |

These limits serve different purposes. Do not use the search limit to reject a full value. Do not
use the table preview to decide equality or order. Full Markdown frontmatter stays in the file
source and follows the existing editable-content rules.

## Why search copies stay small

A local test used real app queries and the Convex test database. It read one page of 50 files.
Each file had one long ASCII value. The test compared the normal short copies with full strings
placed in the same queried documents.

| Operation | Short copies | Full 32 KiB copies |
| --- | ---: | ---: |
| Name list | 42 KiB read | 42 KiB read |
| Metadata sort | 128 KiB read | 1,678 KiB read |
| Metadata prefix search | 108 KiB read | 1,658 KiB read |

The search page returned about 4.4 KiB in both cases. Most extra work was data read inside the
database. Short copies reduced that data by about 15 times. This measures local byte accounting.
It does not prove a hosted response-time gain or worst-case native index cost.

The YAML parser already reads the full text before cutting a scalar. Local warm Node tests found
no consistent parsing gain from the cut. For ordinary text shapes, full extraction took about
0.33–0.81 ms at 32 KiB and 0.48–1.34 ms at 64 KiB. Escaped control values took more time.

## Why full values use separate storage

Ordinary name lists do not read the metadata body. Metadata sort and value reads do read their
derived documents. Full maps also used to be inside draft proposals and copy captures. Path
resolution reads parent proposals. Copy cleanup reads item headers several times.

An old local model inserted draft headers directly. Inline 128 KiB maps made its constructed
128-level path exceed the read limit. This did not prove that the normal creator could build that
path. A later local test used the normal creator. Its 64-level setup stopped at depth 46 before
the map comparison. No unchanged browser defect was proved. A separate constructed 50-item Copy
model ran the real cleanup body and helpers. It also exceeded the read limit with inline maps.
The old write doors rejected these larger maps before this change.

Keep each full map in a separate owned document. Headers and derived documents stay small.
Saved nodes, private proposals, and copy captures each own their map. A capture owns an immutable
clone. Its retry must not follow the source file's later metadata changes.

A local test of the registered private Save used exactly 128 KiB of canonical YAML metadata and
900,000-byte plain text at a supported 1,024-unit ASCII path. Peak reads were 5,993,140 bytes.
All seven existing checks kept use below 75% of each limit. These are local transaction counts.
Hosted timing and every selected-folder workload remain unmeasured.

## Why 32 KiB and 128 KiB

32 KiB is about 32,000 English letters. It is a clear starting product limit, far above 1,024
characters. Local full reads and parsing were small at that size. There was no special failure
boundary at 32 KiB. 64 KiB remains an option if users need longer values.

The whole-map limit includes keys and YAML quoting. Four exact 32 KiB strings can exceed 128 KiB
once the keys are included. Control characters can also take more space when written as YAML.
Both the Properties door and the agent door measure the same canonical form. Both refuse an
oversized value or map with a clear message. Neither silently cuts stored metadata.

Convex does not impose a 1,024-character string limit. Its documented limits include 1 MiB per
document, 16 MiB read/write per transaction, and valid Unicode strings. See the
[official limits](https://docs.convex.dev/production/state/limits) and
[string types](https://docs.convex.dev/database/types).

## Full reads and explicit pages

Properties uses the full map. A table cell uses a preview and opens its full field on demand.
The table shows the first plain value. Field inspection can show every full value of an array.

`meta get` must recover full values from their exact source. It must not present a copied search
prefix as the full value. A large result uses explicit output pages. A large string uses identified
fragments, so the caller can reconstruct it exactly. Follow every `Next page` command until none
remains. Only the last JSON page has `isDone: true`. Every page checks current access, target, path, selected
view, and map revision. Reads that include frontmatter also pin the text and proposal versions.
A metadata-only field skips text versions, so an unrelated content edit does not break its cursor.

Size output after JSON escaping. A 32 KiB NUL string becomes about 192 KiB in JSON. That exceeds
the shell's inline limit. Shell redirection and later output storage do not remove the engine's
output budget. Page before the engine handles output.

## Scope of the claims

The current sort key and long Unicode index-key behavior have separate source risks. This storage
change does not prove exact full-value ordering or constant hosted search cost. Do not call a
source mechanism a current product bug without reproducing it through a normal user flow.
Do not add scans, hidden caps, or partial search answers to hide those limits.
