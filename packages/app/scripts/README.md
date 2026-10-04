# App scripts

## Type check

Run `vp env exec pnpm --dir packages/app run lint:tsc`.

The TypeScript step in regular lint uses `tsconfig.lint.json`. It skips standalone
tests, type tests, benchmarks, and `src/test-stubs`. It still checks app files and
their imports.
Tests inside app files still get checked. Oxlint still checks test files.

Run the full type check when changing tests or types they use:

```powershell
vp env exec pnpm --dir packages/app run lint:tsc:full
```

The full check and the editor use `tsconfig.app.json`, which includes tests.
Test runs stay in `test:once`. Both type checks run on demand and use separate
caches, so running one does not replace the other's saved work.

`typecheck.ts` uses the installed TypeScript 6 compiler. It checks app code and
loads dependency types. It skips direct type checks for paths containing `vendor`
or `node_modules`, while still tracking changes to their types. App errors and
config errors still fail the command. Syntax and global checks still run, with the
same path filters as before.

The suppressed error count covers only collected errors. Skipped vendor type
errors are not collected or counted.

The app config enables incremental checks. TypeScript saves its previous work in
the configured `tsBuildInfoFile` and rechecks files affected by an edit. Deleting
that file forces a fresh check. A fresh check still needs to check all files in
the chosen config.

For a separate config:

```powershell
vp env exec pnpm --dir packages/app exec tsx scripts/typecheck.ts C:/absolute/path/tsconfig.json
```

Test fixtures and benchmark caches must stay in the personal sibling folder,
outside the code repository.

Run the CLI tests:

```powershell
vp env exec pnpm --dir packages/app exec vitest run --project scripts scripts/typecheck.test.ts
```

They check both fresh and cached runs, skipped vendor type errors, visible app
errors, changed dependency types, and config errors. Dependency tests cover types
inferred from function returns, re-exported types, and global types. The app's
normal test command includes this project. They also check both app configs:
test errors fail the full check, app errors fail both, and imported test files
still get checked. Both caches keep working when switching between commands.

The plugin SDK generator has its own compiler program and does not use this cache.
