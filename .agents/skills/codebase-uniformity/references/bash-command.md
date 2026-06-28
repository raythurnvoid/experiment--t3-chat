# Bash Command Patterns

Use this reference when touching `packages/app/server/bash.ts`, `packages/app/server/bash-cat-command.ts`, `packages/app/server/bash-cp-command.ts`, `packages/app/server/bash-find-command.ts`, `packages/app/server/bash-grep-command.ts`, `packages/app/server/bash-head-tail-wc-command.ts`, `packages/app/server/bash-ls-command.ts`, `packages/app/server/bash-meta-command.ts`, `packages/app/server/bash-mv-command.ts`, `packages/app/server/bash-nested-shell-command.ts`, `packages/app/server/bash-rm-command.ts`, `packages/app/server/bash-sed-command.ts`, `packages/app/server/bash-stat-command.ts`, `packages/app/server/bash-tee-command.ts`, `packages/app/server/bash-textgrep-command.ts`, `packages/app/server/bash-touch-command.ts`, `packages/app/server/bash-tree-command.ts`, `packages/app/server/bash-utils.ts`, `packages/app/server/bash-xargs-command.ts`, or `packages/app/server/bash-which-command.ts`.

## Anchors

- In `server/bash.ts`, command regions use `// #region <name> command` and keep parse, format, and create helpers together. Extracted `bash-*-command.ts` modules do not use command-region markers.
- In `server/bash.ts`, command-owned helpers use the command prefix because many command implementations share one file: `search_command_*`, `find_command_*`.
- In extracted command modules such as `server/bash-cat-command.ts`, `server/bash-cp-command.ts`, `server/bash-find-command.ts`, `server/bash-grep-command.ts`, `server/bash-head-tail-wc-command.ts`, `server/bash-ls-command.ts`, `server/bash-meta-command.ts`, `server/bash-mv-command.ts`, `server/bash-nested-shell-command.ts`, `server/bash-rm-command.ts`, `server/bash-sed-command.ts`, `server/bash-stat-command.ts`, `server/bash-tee-command.ts`, `server/bash-textgrep-command.ts`, `server/bash-touch-command.ts`, `server/bash-tree-command.ts`, `server/bash-xargs-command.ts`, and `server/bash-which-command.ts`, private helpers can drop the command prefix; exported entrypoints keep command context and start with `bash_`, such as `bash_cat_command_*`, `bash_cp_command_*`, `bash_find_command_*`, `bash_grep_command_*`, `bash_head_tail_wc_command_*`, `bash_ls_command_*`, `bash_meta_command_*`, `bash_mv_command_*`, `bash_nested_shell_command_*`, `bash_rm_command_*`, `bash_sed_command_*`, `bash_stat_command_*`, `bash_tee_command_*`, `bash_textgrep_command_*`, `bash_touch_command_*`, `bash_tree_command_*`, `bash_xargs_command_*`, or `bash_which_command_*`.
- Dedicated single-command modules extracted from the old monolithic Bash implementation should preserve the original `*_command_create` signatures. Do not introduce dependency object plumbing just because a command moved files.
- Command-local Pascal types should include command ownership when useful, such as `MetaCommandSearchFormat`.
- Option parsing should reuse local helpers like `read_option_value`, `parse_limit`, cursor helpers, and path conversion helpers.
- Continuations should print in the same `Next page:` style as listing/search commands.
- Command tests live in the in-source `action_run` group in `server/bash.ts` unless a nearby test file already owns the behavior.
- `convex/bash.ts` should only register the action and validators. `server/bash.ts` exposes `bash_run_command` for that action boundary. Shared app-path helpers such as `bash_normalize_path`, `bash_resolve_path`, and `bash_is_path_under_current_project_path`, shared bash constants, the `cp`/`mv` operand parser, cursor helpers, `bash_command_build_builtin_delegation_args`, `bash_delegate_native_just_bash_tmp_command`, `bash_WorkspaceFs`, `bash_WorkspaceFsOptions`, and `bash_AppFileContentUnavailableError` live in `server/bash-utils.ts`. Keep `bash_fs_create`, `BashTmpFs`, `ReadOnlyBaseFs`, tmp helpers, command factories, and formatting helpers private.

## Review

- In `server/bash.ts`, verify command helpers stay inside the matching command region.
- Prefer behavior-first test names over implementation names.
- Keep stdout/stderr/exitCode returns direct and shaped like nearby commands.
- Avoid making app Bash read like host-shell code; it is a Convex-backed command surface.
