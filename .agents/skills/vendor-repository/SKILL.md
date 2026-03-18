---
name: vendor-repository
description: Vendored repository workflow for this monorepo. Use this when adding or updating a third-party repository under `packages/app/vendor/`, wiring it into `pnpm-workspace.yaml`, exposing package entrypoints from source files, switching app dependencies to `workspace:*`, or updating Vite so the vendored package is treated as editable source instead of prebundled output.
---

# Goal

Vendor repositories in a way that keeps them directly editable inside the app workspace.

Prefer importing vendored TypeScript source files instead of compiled JavaScript when the package is meant to be patched locally. This keeps edits visible in the app immediately and makes debugging simpler.

# Read First

Use these existing vendors as the local pattern:

- `../../../packages/app/vendor/novel`
- `../../../packages/app/vendor/liveblocks`
- `../../../packages/app/vendor/headless-tree`
- `../../../pnpm-workspace.yaml`
- `../../../packages/app/package.json`
- `../../../packages/app/vite.config.ts`

If the repo should be reference-only and not part of the runtime workspace, put it under `../../../references-submodules/` instead of `../../../packages/app/vendor/`.

# Workflow

## 1. Add the repository as a submodule

Add the new repository under `packages/app/vendor/<name>`.

Example:

```bash
git submodule add https://github.com/remix-run/remix.git packages/app/vendor/remix
```

## 2. Add an upstream remote and a local patch branch

Inside the vendored repo, add the canonical upstream remote if needed and create a local branch for app-specific edits.

Example:

```bash
cd packages/app/vendor/remix
git remote add upstream https://github.com/remix-run/remix.git
git checkout -b rt0-updates
```

## 3. Register vendored packages in `pnpm-workspace.yaml`

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

## 4. Normalize the vendored repo’s root workspace config

If the vendored repository has its own workspace manager config that conflicts with the root pnpm workspace, remove or adapt it.

Common case:

- Remove a root `workspaces` field from the vendored repo’s `package.json`.
- Keep package-manager-specific settings that are still needed.

## 5. Point vendored packages at source files

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

## 6. Switch the app dependency to the workspace package

Update `../../../packages/app/package.json` so the app consumes the vendored package through pnpm workspace resolution.

Example:

```json
{
	"dependencies": {
		"@remix-run/interaction": "workspace:*"
	}
}
```

## 7. Exclude the vendored package from Vite prebundling

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

## 8. Verify `.gitmodules`

Make sure the submodule entry exists and matches the vendored path.

Example:

```ini
[submodule "remix"]
	path = packages/app/vendor/remix
	url = https://github.com/remix-run/remix.git
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
