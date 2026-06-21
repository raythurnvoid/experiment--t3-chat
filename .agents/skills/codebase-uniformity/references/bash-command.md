# Bash Command Patterns

Use this reference when touching `packages/app/convex/bash.ts`.

## Anchors

- Command regions use `// #region <name> command` and keep parse, format, and create helpers together.
- Command-owned helpers use the command prefix: `search_command_*`, `find_command_*`, `meta_command_*`.
- Command-local Pascal types should include command ownership when useful, such as `MetaCommandSearchFormat`.
- Option parsing should reuse local helpers like `read_option_value`, `parse_limit`, cursor helpers, and path conversion helpers.
- Continuations should print in the same `Next page:` style as listing/search commands.
- Command tests live in the in-source `action_run` group unless a nearby test file already owns the behavior.

## Review

- Verify command helpers stay inside the matching command region.
- Prefer behavior-first test names over implementation names.
- Keep stdout/stderr/exitCode returns direct and shaped like nearby commands.
- Avoid making app Bash read like host-shell code; it is a Convex-backed command surface.
