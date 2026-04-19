---
name: vendor-repository
description: Vendored repository workflow for this monorepo. Use this when adding or updating a third-party repository under `packages/app/vendor/`, wiring it into `pnpm-workspace.yaml`, exposing package entrypoints from source files, switching app dependencies to `workspace:*`, or updating Vite so the vendored package is treated as editable source instead of prebundled output.
---

# Goal

Vendor repositories in a way that keeps them directly editable inside the app workspace.

Prefer importing vendored TypeScript source files instead of compiled JavaScript when the package is meant to be patched locally. This keeps edits visible in the app immediately and makes debugging simpler.

# Read First

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

- Run `gh auth status` and confirm the active account is the one that should own the fork (typically `raythurnvoid` for this repo, matching every existing vendor under `packages/app/vendor/`).
- If the active `gh` account is wrong, stop and ask the user to switch accounts (`gh auth switch`) before continuing. Do not silently fork into the wrong account.

Example:

```bash
gh repo fork get-convex/rate-limiter --clone=false --remote=false
```

This produces a fork at `https://github.com/<your-account>/<repo>`. Use that URL as `origin` in the next step.

If a fork already exists for the active account, `gh repo fork` is idempotent and will reuse it.

## 2. Add the fork as a submodule

Add the new repository under `packages/app/vendor/<name>`, using the **fork URL** (not the upstream URL) so `origin` resolves to the fork.

Example:

```bash
git submodule add https://github.com/raythurnvoid/rate-limiter.git packages/app/vendor/rate-limiter
```

## 3. Add the upstream remote and a local patch branch

Inside the vendored repo, add the canonical upstream remote and create the local patch branch.

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
  - "packages/*"
  - "packages/app/vendor/novel/packages/*"
  - "packages/app/vendor/liveblocks/packages/*"
  - "packages/app/vendor/liveblocks/shared/*"
  - "packages/app/vendor/remix/packages/*"
  - "references-submodules/opencode"
  - "packages/app/vendor/presence"
```

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

## 9. Verify `.gitmodules`

Make sure the submodule entry exists, matches the vendored path, points at the **fork URL**, and pins `branch = rt0-updates` so cloning the monorepo checks out the patched branch by default.

Match the existing `polar` vendor entry:

```ini
[submodule "packages/app/vendor/rate-limiter"]
	path = packages/app/vendor/rate-limiter
	url = https://github.com/raythurnvoid/rate-limiter
	branch = rt0-updates
```

If a previous attempt added a wrong URL (for example, the upstream URL instead of the fork URL), fix `.gitmodules`, then run:

```bash
git submodule sync packages/app/vendor/<name>
cd packages/app/vendor/<name>
git remote set-url origin https://github.com/raythurnvoid/<repo>.git
```

# Result

After this workflow:

- the repository lives under `packages/app/vendor/`
- pnpm resolves its packages through the workspace
- the app can import the vendored package from source
- local patches stay easy to inspect and modify

# Current Local Pattern

Apply this same vendoring pattern to repos like:

- `novel`
- `liveblocks`
- `headless-tree`
- future editable vendors such as `remix`

Keep the implementation aligned with the nearest existing vendor instead of inventing a new structure.
