---
name: vendor-repository
description: Vendored repository workflow for this monorepo. Use this when adding or updating a third-party repository under `packages/app/vendor/`, wiring it into `pnpm-workspace.yaml`, exposing package entrypoints from source files, switching app dependencies to `workspace:*`, or updating Vite so the vendored package is treated as editable source instead of prebundled output.
---

# Keep Vendored Source Directly Editable

Vendor repositories in a way that keeps them directly editable inside the app workspace.

Prefer importing vendored TypeScript source files instead of compiled JavaScript when the package is meant to be patched locally. This keeps edits visible in the app immediately and makes debugging simpler.

# Local Reference Implementations

Use these existing vendors as the local pattern:

- `../../../packages/app/vendor/polar` — closest reference for the fork-based remote layout (`origin` = `raythurnvoid/polar` fork, `upstream` = `get-convex/polar`, branch `rt0-updates`)
- `../../../packages/app/vendor/novel`
- `../../../packages/app/vendor/liveblocks`
- `../../../packages/app/vendor/headless-tree`
- `../../../.gitmodules`
- `../../../pnpm-workspace.yaml`
- `../../../packages/app/package.json`
- `../../../packages/app/vite.config.ts`

If the repo should be reference-only and not part of the runtime workspace, put it under `../../../references-submodules/` instead of `../../../packages/app/vendor/`.

# Workflow

## 1. Fork the upstream repository on GitHub first

Always fork the upstream repository **before** adding it as a submodule. The submodule MUST point at the fork as `origin`, not at the original upstream. We routinely commit local patches on a `rt0-updates` branch and need push access.

Use the `gh` CLI to create the fork without cloning (the clone happens via `git submodule add` in the next step).

Before forking:

- Confirm the user authorized creating or changing the fork and pushing its patch branch. A request to use this repo's fork workflow normally grants that authority; a read-only review does not.
- Run `gh auth status` and confirm the active account is the one that should own the fork (often `raythurnvoid` for this repo). Existing vendor metadata is not fully uniform, so do not infer the owner from one entry.
- If the active `gh` account is wrong, stop and ask the user to switch accounts (`gh auth switch`) before continuing. Do not silently fork into the wrong account.

Example:

```bash
gh repo fork get-convex/rate-limiter --clone=false --remote=false
```

This produces a fork at `https://github.com/<your-account>/<repo>`. Use that URL as `origin` in the next step.

If a fork already exists, verify its owner and URL, then continue with that fork. Do not assume `gh repo fork` will safely reuse every existing fork state.

## 2. Add the fork as a submodule

Add the new repository under `packages/app/vendor/<name>`, using the **fork URL** (not the upstream URL) so `origin` resolves to the fork.

Example:

```bash
git submodule add https://github.com/raythurnvoid/rate-limiter.git packages/app/vendor/rate-limiter
```

## 3. Add the upstream remote and a local patch branch

Inside the vendored repo, add the canonical upstream remote and select the local patch branch.

The convention in this repo:

- `origin` → the fork (already set by `git submodule add`)
- `upstream` → the original third-party repository
- working branch → `rt0-updates`

Example:

```bash
cd packages/app/vendor/rate-limiter
git remote add upstream https://github.com/get-convex/rate-limiter.git
git fetch upstream
git checkout -b rt0-updates
git push -u origin rt0-updates
```

Use `git checkout -b rt0-updates` only when the branch does not exist. For a reused fork, fetch `origin` and switch to its existing branch instead:

```bash
git fetch origin rt0-updates
git switch --track origin/rt0-updates
```

If a local `rt0-updates` branch already exists, use `git switch rt0-updates`. Inspect its upstream and commits before merging or pushing.

Verify with `git remote -v`; the result should look like the existing `polar` vendor:

```
origin    https://github.com/raythurnvoid/<repo> (fetch/push)
upstream  https://github.com/<original-owner>/<repo>.git (fetch/push)
```

## 4. Register vendored packages in `pnpm-workspace.yaml`

Add package globs for the vendored repo so pnpm treats it as part of the monorepo workspace.

Match the existing style already used for other vendors.

Example:

```yaml
packages:
  - "packages/app/vendor/<name>/packages/*"
```

Read the vendored repository's package layout and add only the globs it needs. Do not turn the examples below into a manually maintained workspace inventory.

## 5. Normalize the vendored repo’s root workspace config

If the vendored repository has its own workspace manager config that conflicts with the root pnpm workspace, remove or adapt it.

Common case:

- Remove a root `workspaces` field from the vendored repo’s `package.json`.
- Keep package-manager-specific settings that are still needed.

## 6. Point vendored packages at source files

For packages you want to edit locally, expose their source entrypoints directly from `package.json`.

Prefer `src` entrypoints for:

- `main`
- `module`
- `types`
- `exports`

Example:

```json
{
	"name": "@remix-run/interaction",
	"type": "module",
	"main": "./src/index.ts",
	"module": "./src/index.ts",
	"types": "./src/index.ts",
	"exports": {
		".": "./src/index.ts",
		"./form": "./src/lib/interactions/form.ts",
		"./keys": "./src/lib/interactions/keys.ts",
		"./popover": "./src/lib/interactions/popover.ts",
		"./press": "./src/lib/interactions/press.ts"
	}
}
```

Only do this for packages that the app should consume as source. If a vendored package still needs a build artifact boundary, preserve that boundary.

## 7. Switch the app dependency to the workspace package

Update `../../../packages/app/package.json` so the app consumes the vendored package through pnpm workspace resolution.

Example:

```json
{
	"dependencies": {
		"@remix-run/interaction": "workspace:*"
	}
}
```

## 8. Exclude the vendored package from Vite prebundling

Update `../../../packages/app/vite.config.ts` so Vite does not prebundle the vendored dependency as opaque external code.

Add the package to `optimizeDeps.exclude`.

Example:

```ts
optimizeDeps: {
	exclude: [
		"@remix-run/interaction",
	],
},
```

This keeps the package treated as source, which improves:

- local edits
- TypeScript resolution
- HMR/debug iteration

## 9. Install and verify workspace resolution

After workspace and dependency changes, refresh the lockfile through the pinned runtime:

```powershell
vp env exec pnpm install
```

Confirm that the app dependency resolves to the workspace source, inspect the lockfile change, and run the smallest app type check and tests that cover the package integration.

## 10. Verify `.gitmodules`

Make sure the submodule entry exists, matches the vendored path, points at the **fork URL**, and sets `branch = rt0-updates` when remote updates should follow that branch. A normal clone checks out the exact submodule commit recorded by the parent repository. The `branch` setting controls `git submodule update --remote`; it does not make a clone ignore the pinned commit.

Match the existing `polar` vendor entry:

```ini
[submodule "packages/app/vendor/rate-limiter"]
	path = packages/app/vendor/rate-limiter
	url = https://github.com/raythurnvoid/rate-limiter
	branch = rt0-updates
```

If a previous attempt added a wrong URL (for example, the upstream URL instead of the fork URL), fix `.gitmodules`, then run. Replace every `<...>` token before execution; the quotes keep an unreplaced placeholder from becoming shell redirection:

```bash
git submodule sync "packages/app/vendor/<name>"
cd "packages/app/vendor/<name>"
git remote set-url origin "https://github.com/raythurnvoid/<repo>.git"
```

`git submodule add` normally stages the new gitlink and `.gitmodules` change. Inspect the index after the command and do not disturb unrelated user-staged files.

# Updating an existing vendor

1. Read the parent gitlink, current submodule status, branch, and `origin`/`upstream` remotes.
2. Fetch `upstream` and inspect the incoming changes before choosing merge or rebase. Preserve the fork's local patches.
3. Run the vendored package's focused checks and the app checks that exercise the integration.
4. Push the fork branch only when the user authorized the external write.
5. Update the parent repository's gitlink to the verified commit and inspect the final parent and submodule diffs.

# Current Local Pattern

Use `.gitmodules`, `pnpm-workspace.yaml`, and the nearest vendor with the same package shape as current evidence. `polar`, `rate-limiter`, and `r2` are useful fork/`rt0-updates` references; `remix` is already a vendored workspace dependency, not a future example. Existing metadata has some legacy inconsistencies, including duplicate or stale entries. Do not normalize unrelated submodules unless the user includes that cleanup in scope.

Keep the implementation aligned with the nearest matching vendor instead of inventing a new structure.
