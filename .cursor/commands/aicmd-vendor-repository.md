We vendor packages in order to apply edits to make it easier to integrate them in our app or to patch issues we encounter. Since we vendor, if possible we prefer to directly import the TypeScript source files instead of the compiled JavaScript as it makes it easier to quickly edit and see the results.

# Steps to Vendor Remix Repository

## 1. Add Submodule

```bash
git submodule add https://github.com/remix-run/remix.git packages/app/vendor/remix
```

## 2. Add Upstream Remote (in submodule)

```bash
cd packages/app/vendor/remix
git remote add upstream https://github.com/remix-run/remix.git
```

## 3. Create Custom Branch in Submodule

```bash
cd packages/app/vendor/remix
git checkout -b rt0-updates
```

## 4. Update Workspace Configuration

**Update `pnpm-workspace.yaml`:**

```yaml
packages:
  - "packages/*"
  - "packages/app/vendor/novel/packages/*"
  - "packages/app/vendor/liveblocks/packages/*"
  - "packages/app/vendor/liveblocks/shared/*"
  - "packages/app/vendor/remix/packages/*" # Added
  - "packages/app/vendor/opencode"
  - "packages/app/vendor/presence"
```

## 5. Update Remix Root Package.json

**File: `packages/app/vendor/remix/package.json`**

Remove the `workspaces` field (pnpm uses `pnpm-workspace.yaml` instead):

```json
{
  "name": "remix-the-web",
  "type": "module",
  "private": true,
  "packageManager": "pnpm@10.20.0",
  // ... other fields ...
  // Remove: "workspaces": ["packages/*"]
  "pnpm": {
    "onlyBuiltDependencies": [...]
  }
}
```

## 6. Update Interaction Package.json

**File: `packages/app/vendor/remix/packages/interaction/package.json`**

Add `main`, `module`, and `types` fields pointing to source files:

```json
{
	"name": "@remix-run/interaction",
	"type": "module",
	"main": "./src/index.ts", // Added
	"module": "./src/index.ts", // Added
	"types": "./src/index.ts", // Added
	"exports": {
		".": "./src/index.ts", // Already points to src
		"./form": "./src/lib/interactions/form.ts",
		"./keys": "./src/lib/interactions/keys.ts",
		"./popover": "./src/lib/interactions/popover.ts",
		"./press": "./src/lib/interactions/press.ts"
	}
	// ... rest of config
}
```

## 7. Update App Package.json

**File: `packages/app/package.json`**

Change dependency to use workspace version:

```json
{
	"dependencies": {
		// Change from:
		// "@remix-run/interaction": "^0.1.0",
		// To:
		"@remix-run/interaction": "workspace:*"
	}
}
```

## 8. Update Vite Configuration

**File: `packages/app/vite.config.ts`**

Add to `optimizeDeps.exclude` array:

```typescript
optimizeDeps: {
  exclude: [
    // ... other vendored packages ...
    "@remix-run/interaction",  // Added
  ],
},
```

This ensures Vite treats the package as source files (not pre-bundled), enabling:

- Direct imports from `src` files
- Proper hot module replacement (HMR)
- TypeScript source file resolution

## 9. Verify .gitmodules

**File: `.gitmodules`**

Ensure entry exists:

```ini
[submodule "remix"]
	path = packages/app/vendor/remix
	url = https://github.com/remix-run/remix.git
```

# Result

After completing these steps:

- The remix repository is vendored as a submodule
- All remix packages are available via pnpm workspace
- The `@remix-run/interaction` package exports directly from `src` files
- You can import from source: `import { TypedEventTarget } from '@remix-run/interaction'`
- Custom changes are on the `rt0-updates` branch in the submodule

# Pattern for Other Vendored Packages

This same pattern applies to:

- `novel` - Already configured
- `liveblocks` - Already configured
- `headless-tree` - Now configured
- `remix` - Now configured

All follow the same structure:

1. Submodule added to `packages/app/vendor/`
2. Workspace entry in `pnpm-workspace.yaml`
3. Root package.json updated (remove workspaces if using pnpm)
4. Individual package.json files export from `src`
5. App package.json uses `workspace:*` dependencies
6. Vite config excludes from pre-bundling
