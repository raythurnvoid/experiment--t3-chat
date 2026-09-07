# Style Review Checklist

Use this before finalizing a broad implementation or PR plan.

## Organization

- Is new code beside the nearest similar helper, command, query, mutation, or test?
- Are regions requested by the user or already used in the file, with plain comments for small groupings?
- Does each region name a concrete scope and keep its supporting code together across function kinds?
- Are the region pairs flat, closed, and free of duplicate or empty labels?
- Are tests owned by the module they primarily exercise, or is fixture reuse a documented reason to keep them elsewhere?

## Reuse And Abstraction

- Did searches for the same fields, formats, and operations include unchanged code in the owning file and direct peers? For R2 metadata, search `ETag` and `Content-Range`, not only the new helper's name.
- Does repeated parsing or normalization share one implementation when its behavior is the same? Keep different validation rules separate. In `r2_client.ts`, `normalize_etag` and `read_size_with_range` own repeated work.
- Does each new or changed helper remove duplication, own real logic, or hide a necessary external-system detail? A helper that only forwards `key` and `options` to `r2.generateUploadUrl` adds none of these. Short code alone does not need a helper.
- Do options and branches still serve real callers after an operation moves? A workspace-only drain no longer needs an uninstall option. Check callers and earlier guards before removing code.
- Would a private regex constant name a repeated or non-obvious parsing rule, such as `CONTENT_RANGE_TOTAL_REGEX`? Keep a simple one-off expression inline when it reads clearly. Export only for a real caller outside the module. For shared regexes, check whether `g` or `y` makes repeated `exec` or `test` calls depend on `lastIndex`.

## Naming

- Do private helper names match the file's local dialect?
- Do exported names carry enough module context for import-site clarity?
- Do index names list indexed fields in order, with abbreviations only where needed?

## Comments And Docs

- Do comments explain non-obvious intent, invariants, or external-system behavior?
- Is JSDoc multi-line by default, with single-line JSDoc used only when a short label is clearer in a tight group?
- Do empty lines separate logical chunks without splitting statements that complete one step?
- Can any abstract term be replaced by concrete code nouns?
- Do Convex comments and guidance use `doc/docs` for table entries?
- Are durable skills updated when product behavior or canonical workflow changed?

## Verification

- Did focused tests cover the behavior touched?
- Did `git diff --check` pass?
- Did the vocabulary audit run for broad changes?
