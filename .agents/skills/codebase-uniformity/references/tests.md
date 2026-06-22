# Test Organization Patterns

Use this reference when adding, moving, or reviewing tests.

## Anchors

- Prefer a module-owned test file when a feature has a natural Convex module owner, such as `files_metadata.test.ts` for `convex/files_metadata.ts`.
- Keep tests beside established fixtures when moving would duplicate large setup. Record that as an intentional tradeoff.
- Shared utility tests should use top-level `describe("<public_function>")` groups.
- In-source `bash.ts` command tests should stay under the existing `action_run` group and use behavior-first test names.

## Review

- Test through public or registered entrypoints unless production design already exposes a natural helper.
- Keep test comments precise when domain vocabulary overlaps. For example, use `chunk metadata` when the test is about chunk offsets, not frontmatter metadata.
- Do not add defensive test guards for required schema fields. Load the required value directly and let TypeScript/schema-backed fixtures keep the invariant obvious.
- When a storage refactor removes duplicated fields, prefer behavior tests through the public query/mutation plus the smallest direct fixture seed that exercises the missing edge case.
- Run the narrowest focused test command that covers the touched behavior.
