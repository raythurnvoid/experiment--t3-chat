# Style Review Checklist

Use this before finalizing a broad implementation or PR plan.

## Organization

- Is new code beside the nearest similar helper, command, query, mutation, or test?
- Are regions used only where the surrounding file already uses coarse regions?
- Are tests owned by the module they primarily exercise, or is fixture reuse a documented reason to keep them elsewhere?

## Naming

- Do private helper names match the file's local dialect?
- Do exported names carry enough module context for import-site clarity?
- Do index names list indexed fields in order, with abbreviations only where needed?

## Comments And Docs

- Do comments explain non-obvious intent, invariants, or external-system behavior?
- Can any abstract term be replaced by concrete code nouns?
- Do Convex comments and guidance use `doc/docs` for table entries?
- Are durable skills updated when product behavior or canonical workflow changed?

## Verification

- Did focused tests cover the behavior touched?
- Did `git diff --check` pass?
- Did the vocabulary audit run for broad changes?
