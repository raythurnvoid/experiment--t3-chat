# App scripts

## Type check

Run `vp env exec pnpm --dir packages/app run lint:tsc`.

`typecheck.ts` uses the installed TypeScript 6 compiler. It checks the whole app and
keeps the existing error filters for paths containing `vendor` or `node_modules`.
App errors and config errors still fail the command.

The app config enables incremental checks. TypeScript saves its previous work in
the configured `tsBuildInfoFile` and rechecks files affected by an edit. Deleting
that file forces a fresh check. A fresh check still needs to check the whole app.

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

They check both fresh and cached runs, hidden vendor errors, visible app errors,
changed dependencies, and config errors. The app's normal test command includes
this project.

The plugin SDK generator has its own compiler program and does not use this cache.
