# Terminal and Tooling Constraints

- Package manager: this repository uses `pnpm`; do not use `npm`.
- Dev server: do not run `pnpm run dev`; let the user run it manually.
- Lint/type-check commands: do not run verification commands (for example `pnpm lint`, `pnpm type-check`) unless the user explicitly requests them; rely on Cursor diagnostics by default.

# Application Architecture

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, follow the project Convex guidelines in this order:

- **Base rule:** [.cursor/rules/convex/RULE.mdc](.cursor/rules/convex/RULE.mdc)
- **Additional rule:** [.cursor/rules/convex-additional/RULE.mdc](.cursor/rules/convex-additional/RULE.mdc)

They override what you may have learned about Convex from training data.

## Backend Architecture

[packages/app/convex/](packages/app/convex):

- [ai_chat.ts](packages/app/convex/ai_chat.ts) - Main AI chat functionality with streaming and tool calling
- [schema.ts](packages/app/convex/schema.ts) - Database schema for threads and messages
- [auth.ts](packages/app/convex/auth.ts) - Authentication with Clerk integration
- [http.ts](packages/app/convex/http.ts) - HTTP routing for API endpoints

The Convex backend handles:

- AI chat streaming with OpenAI integration
- Thread and message management
- Tool calling (weather, page tools)
- Authentication token generation
- CORS handling

## Frontend Architecture

[packages/app/src/](packages/app/src):

- [main.tsx](packages/app/src/main.tsx) - Application entry point with providers
- [routes/](packages/app/src/routes) - TanStack Router route definitions
  - [\_\_root.tsx](packages/app/src/routes/__root.tsx) - Root layout with auth setup
  - [index.tsx](packages/app/src/routes/index.tsx) - Home page
  - [chat.tsx](packages/app/src/routes/chat.tsx) - Main chat interface with canvas
- [components/](packages/app/src/components) - React components organized by feature
  - [assistant-ui/](packages/app/src/components/assistant-ui) - Chat interface components
  - [canvas/](packages/app/src/components/canvas) - Canvas/document editing components
  - [ui/](packages/app/src/components/ui) - Shared UI components

## Runtime Boundaries

- Treat `packages/app/src/` modules as browser-only SPA code unless a file is explicitly designed otherwise.
- Do not add defensive `typeof document` / `typeof window` guards in frontend-only modules just to handle hypothetical SSR.
- Treat `packages/app/shared/` as the default isomorphic boundary; keep shared modules portable across browser and server runtimes.

## Key Technologies

- Convex - Real-time backend, HTTP actions, persistence
- Clerk - Authentication
- Liveblocks + Yjs - Real-time collaborative editing
- BlockNote - Rich text/Markdown editor
- Monaco Editor - Code and Diff editor
- TanStack Router - File-based routing
- Zustand - State management
- CSS + shadcn/ui - Styling and components
- React 19 - Frontend framework
- Headless Tree - Docs/file explorer
- Vite - Dev/build tool
- Playwright - UI verification
- AI SDK + OpenAI - AI integration and streaming

## Application Structure

The app runs at http://localhost:5173/ during development.

- Chat: The center panel sends messages to Convex HTTP actions (`packages/app/convex/http.ts`, `packages/app/convex/ai_chat.ts`). Responses stream token-by-token and may call tools. Tool outputs render inline in the chat UI.
- Agent file access: Server-side tools in `packages/app/server/server-ai-tools.ts` let the agent read, write, and diff files in the workspace (search, edits, filesystem ops). These run in Node, not the browser, and are invoked through tool calls from the chat flow.
- Docs: The docs experience combines a file/tree explorer and an editor surface. Content supports rich text Markdown via BlockNote and code/diff via Monaco Diff Editor. The canvas can switch between these modes depending on the document type.
- Collaboration: Liveblocks + Yjs provide real-time presence and editing. Convex acts as a secondary source of truth: we persist Yjs snapshots and metadata (`packages/app/convex/ai_docs_temp.ts`) and hydrate rooms from Convex when joining, ensuring recovery and consistency if Yjs state is unavailable. Webhooks/mutations upsert snapshots so new clients can catch up quickly.

## Tiptap / Novel / Rich Text Editors

When working on rich text editors in this repo, treat Tiptap and Novel as source-level infrastructure that must be wired into the app's CSS layering deliberately.

- Do not allow Tiptap to inject runtime styles via `style[data-tiptap-style]` in mounted browser editors. Those injected styles bypass the app's layer ordering and can override component or app styles unexpectedly.
- For mounted editors, set `injectCSS: false`. This applies both to direct `useEditor(...)` / `new Editor(...)` usage and to wrapper components built on top of Tiptap or Novel.
- Keep the canonical editor base styles in layered app CSS (`packages/app/src/app.css` and component-owned `.css` files), not in runtime-injected Tiptap styles.
- If a Novel wrapper is used as the shared editor entrypoint, keep its default behavior aligned with the app rule above so editor instances opt out of Tiptap CSS injection unless a caller explicitly opts in.
- When adding or changing editor visuals, first check the app-owned layered CSS before patching vendored editor internals. Prefer fixing style precedence at the app layer.
- Treat `.ProseMirror-selectednode`, decoration-highlight styles, placeholder styles, and other editor-state visuals as app-owned styling concerns. Keep those selectors in the repo's layered CSS so they remain predictable.
- For headless/non-mounted Tiptap editors used only for parsing or serialization (`element: null`), CSS injection is irrelevant, but keep the configuration explicit when it improves clarity.
- If a change appears to require fighting Tiptap's injected CSS with higher specificity, stop and disable injection instead. Do not paper over layer-order problems with selector escalation.

# Project Structure and Key Directories

## Monorepo Structure

- [package.json](package.json) - Root package configuration
- [pnpm-workspace.yaml](pnpm-workspace.yaml) - Workspace configuration for the monorepo
- [pnpm-lock.yaml](pnpm-lock.yaml) - Lockfile for all dependencies

## Folders organization

- [packages/app/](packages/app) - MAIN APPLICATION ROOT

  - [src/](packages/app/src) - React frontend application code
    - [src/components/](packages/app/src/components) - React components (UI, app assistant UI, canvas)
    - [src/routes/](packages/app/src/routes) - TanStack Router route definitions
    - [src/lib/](packages/app/src/lib) - Shared utilities and helpers
    - [src/hooks/](packages/app/src/hooks) - Custom React hooks
    - [src/stores/](packages/app/src/stores) - State management (Zustand stores)
    - [src/types/](packages/app/src/types) - TypeScript type definitions
    - [src/app.css](packages/app/src/app.css) - Main app CSS file
  - [convex/](packages/app/convex) - Convex backend code and functions
  - [shared/](packages/app/shared) - Shared code between frontend and backend
  - [vendor/](packages/app/vendor) - Vendored submodules used as local workspace sources (see "Submodules (Special Import Handling)" below)

- [references-submodules/](references-submodules) - Reference-only git submodules (docs + source scraping; see full list in "Submodules (Special Import Handling)" below)

- [../t3-chat-+personal/](../t3-chat-+personal) - DOCUMENTATION & RESEARCH FOLDER
  - [../t3-chat-+personal/+ai/](../t3-chat-+personal/+ai) - Only writable subfolder for AI-generated content
  - [../t3-chat-+personal/sources/](../t3-chat-+personal/sources) - Local research sources, contains 3rd party codebases and documentation for research purposes
  - [../t3-chat-+personal/sources/README.md](../t3-chat-+personal/sources/README.md) - Master list of local research sources, read this if you need to read inside the [../t3-chat-+personal/sources/](../t3-chat-+personal/sources) folder to have an idea of what the packages are
  - DO NOT MODIFY other files in ../t3-chat-+personal/ - they are reference material only

## Submodules (Special Import Handling)

The `assistant-ui` repository is kept only as a **reference-only** submodule at `references-submodules/assistant-ui`.
The app does **not** use `@assistant-ui/*` packages at runtime; use normal `node_modules` dependencies for runtime.
All vendored and reference submodule paths are listed below in this single section.

- [packages/app/vendor/liveblocks/](packages/app/vendor/liveblocks) - Liveblocks submodule

  - Documentation folders:
    - [docs/](packages/app/vendor/liveblocks/docs)
    - [guides/](packages/app/vendor/liveblocks/guides)
    - [tutorial/](packages/app/vendor/liveblocks/tutorial)
  - Examples folders:
    - [examples/](packages/app/vendor/liveblocks/examples)
    - [starter-kits/](packages/app/vendor/liveblocks/starter-kits)

- [packages/app/vendor/headless-tree/](packages/app/vendor/headless-tree) - Headless Tree submodule

  - Package folders:
    - [packages/core/](packages/app/vendor/headless-tree/packages/core)
    - [packages/react/](packages/app/vendor/headless-tree/packages/react)

- [packages/app/vendor/novel/](packages/app/vendor/novel) - Novel rich text editor submodule

  - Documentation folders:
    - [README.md](packages/app/vendor/novel/README.md)
  - Examples folders:
    - [apps/web/](packages/app/vendor/novel/apps/web) - Example implementation
  - Package folders:
    - [packages/headless/](packages/app/vendor/novel/packages/headless) - Core editor package

- [references-submodules/assistant-ui/](references-submodules/assistant-ui) - Assistant UI reference submodule (not used at runtime)

- [references-submodules/opencode/](references-submodules/opencode) - OpenCode development platform submodule

  - Documentation folders:
    - [README.md](references-submodules/opencode/README.md)
    - [AGENTS.md](references-submodules/opencode/AGENTS.md)
  - Package folders:
    - [packages/](references-submodules/opencode/packages)

- [references-submodules/ai/](references-submodules/ai) - AI SDK repository

  - Documentation folders:
    - [content/docs/](references-submodules/ai/content/docs)
    - [content/providers/](references-submodules/ai/content/providers)
  - Examples folders:
    - [examples/](references-submodules/ai/examples)

- [references-submodules/ai-chatbot/](references-submodules/ai-chatbot) - Vercel AI Chatbot reference app/template

- Convex reference repositories (submodules under [references-submodules/](references-submodules))

  - Back-end + docs source:
    - [references-submodules/convex-backend/](references-submodules/convex-backend)
    - [docs source](references-submodules/convex-backend/npm-packages/docs/docs)
  - TypeScript/JS SDK + CLI:
    - [references-submodules/convex-js/](references-submodules/convex-js)
  - Helpers:
    - [references-submodules/convex-helpers/](references-submodules/convex-helpers)
    - [package docs](references-submodules/convex-helpers/packages/convex-helpers/README.md)
  - Example apps / templates:
    - [references-submodules/convex-demos/](references-submodules/convex-demos)
    - [references-submodules/convex-tutorial/](references-submodules/convex-tutorial)
    - [references-submodules/convex-tour-chat/](references-submodules/convex-tour-chat)
    - [references-submodules/convex-auth-with-role-based-permissions/](references-submodules/convex-auth-with-role-based-permissions)
    - [references-submodules/convex-tanstack-start/](references-submodules/convex-tanstack-start)

## 3rd Party Documentation Research

When users ask about 3rd party libraries or request implementations using external dependencies, conduct thorough documentation research for accurate responses.

Documentation Sources

- [../t3-chat-+personal/sources](../t3-chat-+personal/sources) - read `../t3-chat-+personal/sources/README.md` when reading inside the folder; you may assume this source mirror matches runtime versions (e.g. `node_modules/.pnpm`)
- Submodules - see [Submodules (Special Import Handling)](#submodules-special-import-handling) above for the canonical full reference list
- Web search - For external documentation when not available locally

Research Process

1. Find docs first - Look for `.md`, `.mdx`, `.txt`, and `docs/` folders
2. Read extensively - Multiple sections, examples, and guides until confident
3. Prioritize docs over source - Use source code only for complex edge cases
4. Understand thoroughly - Continue reading until no doubts remain
5. Look for examples - Prefer real code examples and usage patterns

Quality Standard: Understanding should be deep enough to explain concepts confidently and implement solutions without guessing. If uncertain, keep researching until clear.

### Configuration Files

- [packages/app/convex.json](packages/app/convex.json) - Convex configuration
- [packages/app/components.json](packages/app/components.json) - shadcn/ui component library configuration
- [packages/app/tsconfig.json](packages/app/tsconfig.json) - TypeScript configuration for the app
- [packages/app/index.html](packages/app/index.html) - HTML entry point for Vite
- [packages/app/vite.config.ts](packages/app/vite.config.ts) - Vite development server configuration

# Code guidelines and patterns

You must not use `any` to bypass typescript errors unless the user is asking for it.

## Trust application invariants

When changing application code, default to trusting the product invariants enforced by the app's public queries, mutations, routes, and other supported entrypoints.

- Do not add defensive checks, repair paths, or "self-healing" data logic just because the database schema could theoretically allow an invalid state.
- When one supported flow produces data for a downstream flow, trust that producer/consumer contract in downstream code. Do not add fallback, repair, or self-healing logic in the consumer just because upstream data could theoretically be wrong; identify the concrete producer that can violate the invariant and fix that bug at the source.
- If you think a corrupted state can happen, point to the exact real bug or reachable flow that would create it. Name the concrete mutation, query, route, background job, migration, or user action path.
- If you cannot identify a real reachable corruption path, do not add extra validation or repair code for that hypothetical state.
- Treat "the schema does not prevent it" as insufficient reasoning by itself. In this codebase, the application layer is often the real invariant boundary.
- Prefer fixing the actual bug at the source over masking it downstream with fallback behavior.
- Do not silently recreate pointers, memberships, or related records to paper over a suspected invariant violation unless the user explicitly wants a repair/migration flow and there is a concrete product reason for it.

## TypeScript return types: prefer inference

Avoid explicitly annotating function return types; prefer TypeScript's inferred return type.

Exceptions (add an explicit return type when it helps):

- Exported/public API functions where the return type is part of the contract
- When inference is unstable/too-wide and a return annotation prevents regressions

## TypeScript exports: export only public API

Use `export` only when a symbol is intentionally part of the module's public API because another module imports it now or is expected to import it soon.

- Keep helpers, types, constants, and other implementation details module-private when they are only used inside the same file.
- Do not export symbols "just in case" or to make local file organization feel cleaner.
- When in doubt, start module-private and add `export` later once there is a real cross-module use.

## Test organization

When you add or reorganize tests in an existing `.test.ts` file, group related cases under top-level `describe("<function_name>")` blocks instead of leaving a flat list of `test(...)` calls.

- Use one `describe(...)` per primary function or behavior under test.
- Keep individual `test(...)` names specific, but avoid repeating grouping that already belongs in the enclosing `describe(...)`.
- Follow the local pattern already used by nearby test files before introducing a different layout.
- Do not make regular runtime tests depend on Convex migration functions or `packages/app/convex/migrations.ts` entrypoints.
- If you need to verify a migration, add a focused migration-specific test for that migration instead of routing normal feature tests through migration APIs.

Use tab indentation for `.ts`, `.tsx` and `.css` files.

## Comments that explain code

When comments explain what code does (usually `//` comments, including consecutive multiline `//` comments), write them in imperative second-person language as if you are talking to the developer reading the code.

- Prefer "Keep...", "Use...", "Reset...", "Return...", "Guard..." over descriptive narration like "Keeps...", "Uses...", "Resets...", "Returns...", "Guards...".
- Apply this rule to comments that explain behavior or intent near the code.
- Skip this rule for doc-style prose where imperative wording would be unnatural.

```ts
// ✅ Good
// Keep one cleanup task per row and replace the older scheduled run whenever the row changes.

// ❌ Bad
// Keeps one cleanup task per row and replaces the older scheduled run whenever the row changes.
```

## Global DOM ids: `AppElementId` + `satisfies`

When selecting a DOM element by a global static id (non-dynamic id), the id must be declared in `AppElementId` and used with `satisfies AppElementId` at the call site.

- Add every global static id to `packages/app/src/lib/dom-utils.ts` in `AppElementId`.
- Use `"some_id" satisfies AppElementId` when calling DOM APIs (for example `document.getElementById(...)`).
- Do not use raw string literals for global static ids without `satisfies`.
- Dynamic/runtime-generated ids are excluded from this rule.
- For component-owned `data-*` attributes, model the keys with a dedicated `ComponentName_CustomAttributes` type and validate key usage with `satisfies keyof`.

```ts
// ✅ correct
const rootElement = document.getElementById("root" satisfies AppElementId);

// ❌ incorrect
const rootElement = document.getElementById("root");
```

## Errors as values (`Result`) pattern

This codebase uses the `Result` helper from `packages/app/shared/errors-as-values-utils.ts` for recoverable errors.

Return `Result` values with explicit success/failure branches:

```ts
return Result({ _yay: value });
return Result({
	_nay: {
		name: "nay",
		message: "Error while doing something",
		cause: error,
	},
});
```

When consuming a Result-returning function:

- Handle both branches explicitly (`_yay` and `_nay`)
- Prefer bubbling `_nay` at the same abstraction layer (`if (result._nay) return result;`)
- Do not ignore returned Result values; if bubbling is not possible, at least log the `_nay` with context

### Full-run concurrent Result aggregation (Result_all + Promise.all)

Use `Result_all` by itself to convert `Array<Result<...>>` into one `Result`:

```ts
const results = Result_all(
	await Promise.all(
		items.map(async (item) => {
			const value = await doStep(item);
			if (!value) {
				return Result({
					_nay: { name: "nay", message: "Item not found", data: { item } },
				});
			}

			return Result({ _yay: value });
		}),
	),
);

if (results._nay) {
	return results;
}

const values = results._yay;
```

Use this variant when:

- you want all tasks to run fully;
- you do not need the shared `nayResult` short-circuit guard inside each task;
- you still want one flat `Result` at the end.

### Fail-fast concurrent Result loop (Result_all + Promise.all)

When processing many items concurrently and each item can fail with `_nay`, prefer this pattern:

```ts
const results = Result_all(
	await Promise.all(
		(function* (/* iife */) {
			let nayResult = undefined;

			for (const item of items) {
				yield (async (/* iife */) => {
					const value = await doStep(item);
					if (nayResult) return nayResult;

					if (!value) {
						return (nayResult = Result({
							_nay: { name: "nay", message: "Item not found", data: { item } },
						}));
					}

					return Result({ _yay: value });
				})();
			}
		})(),
	),
);

if (results._nay) {
	return results;
}
```

Use this when you want to:

- fan out work concurrently;
- bubble one `_nay` quickly and consistently;
- avoid additional expensive work in in-flight tasks after first failure (`if (nayResult) return nayResult`).

Important caveat:

- This does not cancel already started promises; it only short-circuits subsequent logic inside each task.
- Keep this phase validation-only when possible, and perform related DB writes after the `_nay` check.

### Throwing because of `_nay`

At boundaries where you must throw (for example integration boundaries), throw an ad hoc error message and pass `_nay` in `cause`:

```ts
if (result._nay) {
	throw new Error("Failed to perform operation", {
		cause: result._nay,
	});
}
```

Never throw raw `_nay.message` directly:

```ts
// bad
throw new Error(result._nay.message);
```

### Message and log string format

For `_nay.message` and throw messages:

- Do not prefix with `[OwnerSymbol.operation]`
- Describe the failed operation in clear terms (`Failed to ...`, `Error while ...`)
- Keep the message stable and concise (do not embed volatile payloads)
- Put details in `cause` and structured logs, not in the message text

For log messages:

- Start with `[OwnerSymbol.operation]`
- Keep logs stable and concise; include variable details as structured metadata
- Do not use `.catch(console.error)` in promise chains; prefer explicit handlers like `.catch((error) => { console.error("[OwnerSymbol.operation] ...", { error, ...context }); })` so failures include operation context

### Promise error-handling style

For promise chains in frontend/component handlers, prefer logging + early return over throwing for expected `Result._nay` branches.

- In `.then((result) => { ... })`, when `result._nay` is an expected/recoverable branch, use `console.error` with context and `return` early.
- Do not `throw new Error(...)` inside `.then(...)` for expected `Result._nay` branches in UI handlers.
- Keep `.catch(...)` for unexpected exceptions/rejections, and make it contextual (no bare `console.error` pass-through).
- Reserve throws for true boundary layers where an exception is required (see "Throwing because of `_nay`").

```ts
someAsyncOperation()
	.then((result) => {
		if (result._nay) {
			console.error("[OwnerSymbol.operation] Failed to perform operation", { result, ...context });
			return;
		}

		// success path
	})
	.catch((error) => {
		console.error("[OwnerSymbol.operation] Unexpected async error", { error, ...context });
	});
```

## Consistency requirement (same-author rule)

When editing existing code, your changes must match the existing local style and patterns in that file and nearby modules — **it should look like the same person wrote the code**. Do not introduce new organizational patterns, naming conventions, or stylistic preferences unless the user explicitly requested it or it is required for correctness.

### Type and classnames colocation

Keep component-scoped types next to their owner component instead of centralizing them in a single module-level block.

- Use owner-based placement, not similarity-based placement.
- For component styling contracts, place `Owner_ClassNames` immediately above the same owner's `Owner_Props` and component.
- If a small component has no dedicated `*_Props`, keep its `*_ClassNames` directly above that component.
- Avoid creating a top-level "css contracts" region that groups classnames/types for many components in one place.
- Keep owner-scoped contracts with the exact owner in their symbol name.
- Do not mix parent-owned and child-owned contracts in the same region.
- If you extract `ParentItem` from `Parent`, rename the extracted item's `*_ClassNames`, `*_Props`, and CSS selectors to match `ParentItem`.
- If the user asks for multiple sibling components (for example `FooSelected`, `FooSelectable`, and `Foo`), treat them as three separate owners. Do not keep their types in one shared "components" region.
- If a coordinating wrapper component renders no owned DOM node, keep only its `Owner_Props` and component in that region; do not invent shared class contracts for it.
- If sibling variants both need similar slots like label/description, each variant still owns its own slot classes (`FooSelected-label`, `FooSelectable-label`) unless the user explicitly asked for a shared base owner.

Examples:

- `Foo_ClassNames`, `Foo_Props`, and `Foo` stay together.
- `FooItem_ClassNames`, `FooItem_Props`, and `FooItem` stay together.
- `FooItem` must not keep using `Foo_ClassNames`.

### Region organization

Use region comments only when the user explicitly requests them, or when the module already uses regions.

- Treat regions as mandatory in those cases.
- Let the user guide region naming and organization when introducing or restructuring regions.
- If a file already uses regions, preserve that structure and place new code in the most relevant existing region.
- Keep regions flat (do not nest `#region` blocks).
- Do not duplicate region labels within the same file; each region label must appear at most once per file.
- Region labels must be lowercase words and concise.
- If a `.tsx` file has a paired `.css` file, keep region labels aligned between TSX (`// #region ...`) and CSS (`/* #region ... */`).
- Place `// #region <label>` before the same-owner types/helpers/components and `// #endregion <label>` after that owner's body.
- Keep owner boundaries explicit. Treat `foo` and `foo item` as different owners and different regions.
- Do not add or remove regions in files that do not already use them unless the user explicitly requests it.
- Do not create `#region` blocks inside a component body for "local state", "handlers", "render", etc., unless the user explicitly requests that structure.
- If you need extra grouping inside a component, use plain comments instead of more `#region` markers.
- When the user asks for concrete extracted components, region labels should usually match those concrete owners one-for-one (`foo selected`, `foo selectable`, `foo`) instead of using one catch-all region such as `foo components`.
- If a supporting non-component shape also needs a region, give it a distinct label like `foo model` so it does not collide with the actual component-owner region names.
- A composer/chooser component still gets its own region even when its paired CSS region is intentionally empty or comment-only because it only composes other owners.

Examples:

- Keep `foo submenu` contracts in `foo submenu`.
- Keep `foo submenu item` contracts in `foo submenu item`.
- Do not keep `FooSubMenu_ClassNames` inside the `foo submenu item` region.
- Do not keep `FooItem_ClassNames` inside the `foo submenu` region.

### Anatomy example

Use this pattern when a feature module extracts multiple concrete sibling components plus one chooser/composer:

```tsx
// #region item selected
type FooItemSelected_ClassNames = "FooItemSelected" | "FooItemSelected-label" | "FooItemSelected-description";

type FooItemSelected_Props = {
	label: string;
	description: string;
};

const FooItemSelected = memo(function FooItemSelected(props: FooItemSelected_Props) {
	const { label, description } = props;
	return <div className={cn("FooItemSelected" satisfies FooItemSelected_ClassNames)} />;
});
// #endregion item selected

// #region item selectable
type FooItemSelectable_ClassNames = "FooItemSelectable" | "FooItemSelectable-label" | "FooItemSelectable-description";

type FooItemSelectable_Props = {
	label: string;
	description: string;
	onSelect: () => void;
};

const FooItemSelectable = memo(function FooItemSelectable(props: FooItemSelectable_Props) {
	const { label, description, onSelect } = props;
	return (
		<button
			type="button"
			className={cn("FooItemSelectable" satisfies FooItemSelectable_ClassNames)}
			onClick={onSelect}
		/>
	);
});
// #endregion item selectable

// #region item
type FooItem_Props = {
	item: {
		id: string;
		label: string;
		description: string;
		onSelect: () => void;
		isCurrent: boolean;
	};
};

const FooItem = memo(function FooItem(props: FooItem_Props) {
	const { item } = props;
	return item.isCurrent ? (
		<FooItemSelected label={item.label} description={item.description} />
	) : (
		<FooItemSelectable label={item.label} description={item.description} onSelect={item.onSelect} />
	);
});
// #endregion item
```

```css
/* #region item selected */
.FooItemSelected {
}

.FooItemSelected-label {
}

.FooItemSelected-description {
}
/* #endregion item selected */

/* #region item selectable */
.FooItemSelectable {
}

.FooItemSelectable-label {
}

.FooItemSelectable-description {
}
/* #endregion item selectable */

/* #region item */
/* FooItem composes siblings only; no owned selectors. */
/* #endregion item */
```

Key takeaways:

- Give each concrete owner its own region.
- Keep each owner's `_ClassNames`, `_Props`, and selectors inside that same owner region.
- Use kebab-case suffixes in class strings (`-label`, `-description`, `-icon-wrap`).
- Create regions only for real long-lived owners or boundaries. Inline one-off supporting data shapes in the nearest owning region unless a separate owner boundary materially improves clarity.
- Let the chooser/composer region stay small; if it owns no DOM, it usually owns no selectors.

### Effect placement inside components

Inside a component body, keep `useEffect` hooks below local functions/handlers and above the JSX template return.

- Prefer ordering as: state/derived values -> local functions/handlers -> `useEffect` hooks -> `return (...)`.
- Avoid scattering `useEffect` between unrelated declarations unless the user explicitly requests that layout.
- Keep effect callbacks able to reference functions declared above.

### Props ordering and naming

Keep the same prop order in both `*_Props` definitions and JSX call sites.

- Use this order: `ref` (if any), `id` (if any), `className` (if any), `style` (if any), other non-callback props, then callback/event props.
- Callback/event props must be prefixed with `on*`.
- Keep callback/event props grouped at the end of the object/type and at the end of JSX prop lists.
- For extracted child components, keep prop names and call-site order aligned with the same contract order.
- Keep named slots after callback/event props.
- Keep `children` last.
- Keep `...rest` as the final destructured item.
- For feature-local extracted components that own a specific UI shape, prefer structured props (`icon`, `title`, `items`, `selectedItemId`, `onCreate`) over broad `ReactNode` slot props (`headSlot`, `listSlot`) unless the component is intentionally a reusable layout primitive.
- Use named slot props only when caller-controlled composition is the goal. Do not default to slot APIs for local composition when plain data + callback props describe the component more clearly.

### Insertion placement (pre-scan first)

Before inserting code in an existing `.tsx` module, scan:

- Existing region markers (if any)
- Imports/exports and module-level constants
- Existing ordering patterns (types/helpers/handlers/components)

Placement rules:

- If regions exist, insert inside the region owned by that symbol.
- If no regions exist, insert immediately above/below the nearest similar symbol or first call-site.
- Do not dump new helpers/types at the top or bottom; match the file’s local organization.

## React Compiler: avoid try/catch/finally blocks

The React Compiler currently has issues lowering `try { ... } catch { ... } finally { ... }` (especially with a `finally` clause) inside components/handlers. Prefer the existing pattern used in this repo:

- Wrap async logic in an `async (/* iife */) => { ... }` IIFE
- Handle errors with `.catch(...)`
- Do cleanup/state resets with `.finally(...)`

## Casing

Prefer these naming rules in order. The main distinction is between root-level value symbols, root-level type-like symbols, and owner-scoped colocated symbols.

### Root-Level Value Symbols (default: snake_case, scope-first)

Use `snake_case` for root-level value symbols such as `const`, `let`, `function`, and non-class helper objects. Choose names by symbol visibility, not by folder path.
This rule does not apply to React components or hooks; keep following the dedicated `PascalCase` / `useXxx` rules below.

- File-local/private symbols should usually omit the module/feature prefix when the file context already makes ownership obvious.
- Exported/public values may use a module prefix for import-site discoverability, for example `pages_*`, `ai_chat_*`, `app_*`, `storage_*`.
- Match the file's established constant casing, but keep the semantic name short. Do not repeat the full feature path in private constants, ids, storage keys, or local glue helpers just because the symbol lives in that feature file.
- Name private helpers after their actual module-level role, not after a redundant feature prefix. Prefer `runtime`, `cache_by_storage_key`, or `registered_field_definitions` over `app_local_storage_runtime`, `cacheByStorageKey`, or `definitionByStorageKey` when the file context already provides the namespace.
- Prefer names that describe the current axis of the abstraction. If an API is keyed by storage keys, use `key`, `storage_key`, `cache_by_storage_key`, and similar terms instead of older `field` / `scope` terminology that no longer reflects the public shape.
- Prefer plain descriptive names such as `strip_provider_metadata_from_message_parts` over `ai_chat_strip_provider_metadata_from_message_parts`.
- Keep well-established exceptions when they improve clarity or match external APIs: hooks use `useXxx`, short shared utilities may stay `cn` / `sx`, and wrappers over external APIs may preserve existing camelCase names.

```ts
// bad
const PAGE_EDITOR_SIDEBAR_AGENT_TABS_DROPPABLE_ID = "...";

// good
const DROPPABLE_ID = "...";
```

### Root-Level Type-Like Symbols (PascalCase suffix, scope-first)

Classes, interfaces, type aliases, and enums use PascalCase for the type-like part of the symbol.

Use one of these two shapes:

- File-local/private type-like symbols: plain PascalCase
- Exported/public or cross-module type-like symbols: optional `snake_case` namespace + PascalCase suffix when it improves import-site discoverability

Do not add a module/feature prefix to a private type just because it lives in that feature file. Prefer `OpenTabRecord` over `page_editor_sidebar_open_tab_Entry` when the file context already provides the namespace. If you add a prefix to an exported/public type-like root-level symbol, keep the namespace prefix in `snake_case` and the type-like suffix in PascalCase (for example `ai_chat_Stream`, `pages_DocSnapshot`, `ai_chat_Result`).

When a private type supports generic module machinery rather than one specific exported owner, prefer a plain PascalCase name such as `FieldDefinition` over `app_local_storage_FieldDefinition`. Reserve owner-scoped names like `OwnerSymbol_Descriptor` for declarations that are truly owned by that symbol, not for every private type in the file.

```ts
export const ai_chat_MAIN_MODEL_IDS = ["gpt-5-nano", "gpt-4.1-mini"] as const;

export class ai_chat_MyClass {
	constructor(public projectId: string) {}
}

export interface ai_chat_MyInterface {
	projectId: string;
}

export type ai_chat_MyType = {
	projectId: string;
};

type OpenTabRecord = {
	id: string;
	title: string;
};

type PendingEditSyncResult = {
	aborted: boolean;
};

export function ai_chat_my_function(projectId: string) {
	const processedResult = processData(projectId);
	return processedResult;
}

export enum ai_chat_MyEnum {
	PROJECT_ID = "app_project_local_dev",
}

class LatestSerializedRunner {}
```

### Root-Level Scoped Symbols (allowed: OwnerSymbol_Descriptor)

When a root-level symbol exists only to support a specific owner symbol (component, hook, or utility), you may use `OwnerSymbol_Descriptor`.

- Components and component-like owners use PascalCase, for example `PageEditorDiff_Props`.
- Hooks keep the normal hook owner name, for example `useAiChatController_Props`.
- Use this pattern when the owner relationship materially improves clarity, not as a default substitute for every private type or helper.
- Prefer plain PascalCase for small file-local data shapes when owner linkage would add noise.

This is the pattern used for colocated helper types and companion utilities, for example:

```ts
type AiChatThread_Props = { ... };
type AiChatThread_ClassNames = "AiChatThread" | "AiChatThread-content";
type useAutoScroll_Props = { ... };
type LatestSerializedRunner_RunResult<T> = { ... };
```

Use this pattern only for tightly related declarations. Keep shared/generic module APIs in the root-level patterns above.

This owner-scoped pattern is allowed for private helpers but not required; prefer local file consistency and minimal naming over mechanical namespace repetition.
For function-owned types, one-off shapes are often easier inline, while owner-linked names (for example `OwnerSymbol_Args` or `OwnerSymbol_Result`) can be helpful when the type is reused, exported, or notably improves readability.

### Function-local variables and helpers (camelCase)

```ts
function ai_chat_example_function() {
	const bodyResult = await request.json();
	const generationResult = await generateObject();
	const workspacePattern = `${orgId}:${projectId}:*`;

	const processData = (inputValue: string, optionFlags: boolean) => {
		return {
			processedValue: inputValue,
			isComplete: optionFlags,
		};
	};
}
```

### Components and Hooks (Exceptions)

Components use PascalCase. Hooks use camelCase in the `useMyHook` form:
This exception overrides the general root-level `snake_case` rule above.

For extracted inner components, prefer the owner name in one PascalCase symbol such as `PageEditorInner` instead of `PageEditor_Inner`.
When you colocate owner-scoped types for that inner component, keep the same owner spelling, for example `PageEditorInner_Props`.

```ts
export function ThemeProvider() {}
export function MessageComposer() {}
export function useTheme() {
	return { mode: "dark", resolvedTheme: "dark", setMode: () => {} };
}
export function useAiChatGroupedThreads() {
	const threadGroups = useMemo(() => {}, []);
	return threadGroups;
}
```

#### Hook naming gotcha (React Compiler)

React tooling (and the React Compiler) expects hooks to be named in the form `useXxx...` where the character immediately after `use` is uppercase.

- ✅ Good: `usePagesLastOpen`, `useAiChatController`, `useAiChatGroupedThreads`
- ❌ Bad: `use_pages_last_open`, `use_ai_chat_controller`, `use_foo`

## IIFE

IIFEs should be marked with an `/* iife */` comment to make them explicitly visible to the USER.

```ts
const someValue = ((/* iife */) => {
	// complex logic here
	return someValue;
})();
```

## Lazy singletons

To lazily create a singleton only when it's used to optimize performance and memory usage you can use the IIFE pattern.

The IIFE can return a named function with the same name of the symbol it's being assigned to improve the debugging experience.

```ts
const get_singleton = ((/* iife */) => {
	function value() {
		return { someValue: "someValue" };
	}

	let cache: ReturnType<typeof value> | undefined;

	return function get_singleton() {
		return (cache ??= value());
	};
})();
```

### Parametrized functions with memoization

For functions that take parameters and you want to memoize results based on those parameters, use a `Map` to cache results keyed by the input parameters.

The pattern follows the same structure as lazy singletons, but uses a `Map` for caching multiple results:

```ts
export const pages_parse_markdown_to_html = ((/* iife */) => {
	function value(markdown: string) {
		const markedInstance = pages_marked();
		const result = markedInstance.parse(markdown, { async: false });
		return result;
	}

	const cache = new Map<Parameters<typeof value>[0], ReturnType<typeof value>>();

	return function pages_parse_markdown_to_html(markdown: string) {
		const cachedValue = cache.get(markdown);
		if (cachedValue) {
			return cachedValue;
		}

		const result = value(markdown);
		cache.set(markdown, result);
		return result;
	};
})();
```

**Key points:**

- The `value` function accepts the same parameters as the returned function
- Use a `Map` with appropriate key type (often `string` for single parameter, or a tuple/serialized object for multiple parameters)
- Cache type uses `ReturnType<typeof value>` for type safety
- Check cache first, compute and cache if missing, then return

## Zustand stores

This repo uses Zustand for client-side state.

When you create or update a Zustand store, you should follow the existing store patterns in this repo:

- **Store creation**: create the store in an IIFE and export the result (matches the “lazy singleton” style used elsewhere in this repo).
- **Actions (common pattern)**: many stores attach actions via `Object.assign(store, { actions: { ... } })` so call sites use `useXxx.actions.someAction(...)`.
- **Tiny stores (allowed)**: for very small stores, it’s acceptable to export the store directly and call `useXxx.setState(...)` at call sites.

Before implementing a new store, read these examples and match their local style:

- [packages/app/src/lib/app-global-store.ts](packages/app/src/lib/app-global-store.ts)
- [packages/app/src/lib/app-local-storage-state.ts](packages/app/src/lib/app-local-storage-state.ts)

## No Barrel Exports

- Do not create index.\* barrel files (index.ts, index.tsx, index.js).
- Always import from concrete files and export from the component file directly.
- Prefer named exports. Do not add `export default` unless a framework, runtime API, or build tool strictly requires it.
- Treat default exports as banned by default. If you use one for a technical reason, keep the reason explicit and local to that integration point.
- TanStack Router route modules are not an exception here; keep using the route file convention they actually require (for example `export const Route = createFileRoute(...)`), not `export default`.
- Example: import from "./components/ui/button.tsx" or export from "./button.tsx"; do not add a directory-level index.
- Barrel files are bad for intellisense and code completion.

# React components

## React Compiler (this project)

## Core mental model

When you are writing components/hooks, you must assume:

- Values computed inside a component are memoized and reused until their automatically tracked dependencies change.
- Functions/closures created inside a component are memoized and reused until their automatically tracked dependencies change.
- You must not assume "everything is recomputed every render".

## Practical guidelines

### Avoid premature memoization

Do not add `useMemo` / `useCallback` just to avoid recomputation or to stabilize identities. Prefer plain expressions and inline callbacks.

Only add `useMemo` / `useCallback` when there is a concrete semantic requirement that cannot rely on the compiler (e.g. bridging to non-React APIs that store identities and must not be re-registered), and include a short comment explaining why it is required.

This guidance applies to hook-level memoization (`useMemo` / `useCallback`). Component declarations are still required to use `memo(...)` (see Component declaration style below).

### Component declaration style (mandatory)

All React components must be exported with `memo` using a named function expression.

```tsx
export const MyComponent = memo(function MyComponent(props: MyComponent_Props) {
	const { className, ...rest } = props;
	return <div className={className} {...rest} />;
});
```

For propsless components:

```tsx
export const MyComponent = memo(function MyComponent() {
	return <div />;
});
```

Exception for components with attached static exports (for example `Component.useStore`): use `Object.assign(memo(function Component(...) { ... }), { ...staticFields })` and then export with a separate named export (`export { Component };`) (see [Component attached exports (Fast Refresh / HMR-friendly)](#component-attached-exports-fast-refresh--hmr-friendly)).

### Effect dependency rule (React Compiler-first)

When evaluating effect dependencies in this repo:

- Assume derived values and closures are compiler-memoized by semantics.
- Do not add "stability guard" dependencies (for example object/function identities) unless required by a concrete non-React API contract.
- Prefer semantic dependencies (derived values such as visible IDs) over broad source-input fanout dependencies.
- If adding extra dependencies, justify them with a concrete failure mode in this codebase.

### Avoid derived-state effects

Do not use `useEffect` to keep derived state in sync.

Prefer computing derived values during render and returning them directly.

### Effects are still valid for real side-effects

Use `useEffect` (or other effect hooks) only for real side effects such as:

- Subscriptions/unsubscriptions to external systems
- Timers/intervals
- Imperative DOM APIs
- Bridging to non-React code

### Error boundaries

For React subtree error boundaries in app UI, prefer TanStack Router's `CatchBoundary` over ad hoc class-based error boundary components.

- Match the existing pattern from `packages/app/src/components/page-editor/page-editor.tsx`: pass `errorComponent`, `onCatch`, and `getResetKey`.
- Use `getResetKey` to recover when the owning identity changes (for example route params, selected thread, or branch anchor).
- Keep the fallback UI local to the feature surface and style it like that surface instead of showing a generic app-level error.

## Review checklist

When reviewing or proposing changes, you must question any newly introduced:

- `useEffect` (is this a real side effect, or derived state?)
- `useMemo` / `useCallback` (is this actually required, given React Compiler memoization?)

## Event-driven, centralized UI logic (preferred)

- **Prefer explicit events over sync effects**: update state as a direct result of user/actions/events (e.g. `onSubmit`, `onSelect`, `onToggle`) rather than `useEffect`-based syncing.
- **Centralize side effects and integrations**: keep data fetching, mutations, and other side-effectful work in a stable “owner” layer (route/container/controller hook). Leaf components should be mostly presentational.
- **Prop-drill state + handlers**: children receive derived values and callbacks; avoid reintroducing contexts/hooks in leaves that duplicate wiring and hide dependencies.
- **Don’t leak query arguments to leaves**: for Convex (and similar), prefer that leaf components receive _data_, not the parameters used to fetch it; this reduces surprising cache/lifecycle issues when leaves unmount.
- **Prefer reset via re-mount over effect syncing**: when a leaf needs to “reset” on a key change (e.g. thread switch), prefer keying/remounting or passing an `initialValue`, not a store→leaf `useEffect` sync.

## Props Parameter Pattern

Use a single `props` parameter and destructure on the first line. Keep `...rest` last when forwarding DOM-compatible props.

The following rules are mandatory across this codebase:

## Do

- Export components with `memo(function ComponentName(...) { ... })` using a named function expression.
- For components that accept props: accept a single `props` parameter; destructure on the first line inside the function body.
- For propsless components: do not add an empty `props` arg or empty props type; omit the parameter.
- Keep `...rest` last and forward DOM-compatible props as needed.
- Prefix all CSS classes with the component name.
- Follow the naming/casing rules in [Casing](#casing) (components/hooks, root/module symbols, and namespaced symbols).
- Inside components, use arrow functions for all helpers/handlers (avoid hoisted `function` declarations).
- Follow ref rules in [Ref as a regular prop](#ref-as-a-regular-prop), [Forwarding ref to children](#forwarding-ref-to-children), and [Imperative handle pattern](#imperative-handle-pattern).

## Don't

- Use `React.FC` or `FC`.
- Export non-memoized components; all components must be wrapped with `memo`.
- Destructure props in the function signature.
- Export anonymous arrow component expressions for top-level components.
- Use `function foo()` declarations inside components (they are hoisted; prefer `const foo = () => {}`).

## Strict props by default (feature components)

When the user requests a new component, or when you edit an existing component, you must use a **strict API** by default.

## Required by default

Props are required by default. Do not make props optional for convenience, backward compatibility, or speculative future use.

- Use optional props only when omission is part of the intended behavior.
- Do not hide required behavior with silent defaults in destructuring unless the user explicitly asked for that behavior.

## Model “absence” explicitly

If absence is part of the intended behavior, prefer explicit absence modeling (`T | null` or a discriminated union) over implicit omission.

This makes the call-site explicit and avoids silent defaults.

## Exception: low-level reusable / technical components

Optional props are allowed when the component is a low-level reusable / technical building block used in many places (for example: a sentinel, a UI primitive, or shared infrastructure).

In those components:

- Optional props should have clear defaults.
- Keep the API small and stable across many use cases.

### Also applies to `_Props` type declarations

Use the same ordering when declaring fields in your `ComponentName_Props` interface. This applies to custom fields you declare; inherited DOM props from `extends React.ComponentProps<...>` are not re-ordered. Always put `children` last.

```tsx
export type Example_Props = React.ComponentProps<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
	// Other props
	variant?: "default" | "compact";
	// Events
	onClick?: React.MouseEventHandler<HTMLDivElement>;
	// Named slots
	headerSlot?: React.ReactNode;
	// Children last
	children?: React.ReactNode;
};
```

## Example

```tsx
export type Toolbar_Props = React.ComponentProps<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
	variant?: "default" | "compact"; // other prop
	onClick?: React.MouseEventHandler<HTMLDivElement>; // event
	labelSlot?: React.ReactNode; // named slot
	children?: React.ReactNode;
};

export function Toolbar(props: Toolbar_Props) {
	const { ref, id, className, variant = "default", onClick, labelSlot, children, ...rest } = props;

	return (
		<div
			id={id}
			ref={ref}
			className={cn("Toolbar", `Toolbar-variant-${variant}`, className)}
			onClick={onClick}
			{...rest}
		>
			{labelSlot}
			{children}
		</div>
	);
}
```

## Component Styles

- Declare a `_ClassNames` union type enumerating all CSS class strings. Class values are prefixed with the component name and use kebab-case. **Always include a root class equal to the component name**, even when styles are minimal, so the component is easy to identify in the DOM.
- Keep every suffix segment in class string literals kebab-case. Use `ComponentName-icon-wrap`, not `ComponentName-iconWrap`.
- If sibling components own similar slots, repeat the slot suffix under each owner instead of inventing a shared pseudo-owner. Prefer `FooSelected-label` and `FooSelectable-label` over a shared `Foo-label` when `Foo` itself is only a chooser/composer.

```ts
type Thread_ClassNames = "Thread" | "Thread-header" | "Thread-actions";
```

- When a component uses vanilla CSS, you must keep styles **module-owned and co-located**.

## TSX ↔ CSS pairing (no cross-file styling by default)

When you create a new component module `foo.tsx` that uses vanilla CSS, you must also create a paired `foo.css` and import it from `foo.tsx`.

When you extract/split a component into a new `*.tsx` module, you must also extract/split the relevant CSS into that module’s paired `*.css` file.

You must not style a new module by importing another component’s CSS file unless the user explicitly requested shared/global styling.

When both paired files use regions, keep region labels aligned between TSX (`// #region ...`) and CSS (`/* #region ... */`) with exact matching label text (including casing/spacing). Do not add extra CSS regions that do not exist in the paired TSX module.

When extracting JSX into a dedicated subcomponent region in the same file (for example `// #region header`), move its selectors into a dedicated matching CSS region in the paired stylesheet in the same change (for example `/* #region header */`).

Do not keep extracted subcomponent selectors inside `/* #region root */`; keep `root` focused on the root component selectors only.

✅ Good: the module imports its own paired CSS

```tsx
import "./ai-chat-message.css";
```

❌ Bad: the module imports a different component’s CSS

```tsx
import "./ai-chat.css";
```

## Exceptions (must be explicit)

Only reuse styling across components when it is explicit and intentional:

### Shared/global styles

If the user explicitly requests shared/global styles, put them in an appropriate shared/global location (e.g. app-wide CSS), not in an unrelated feature component’s CSS file.

### Reuse via class contracts (preferred)

If you need to inherit another component’s styling, prefer reusing its class contract (apply both class names and type-check them), rather than importing the other component’s CSS file.

Use this when the reused component is actually rendered (its CSS is already loaded). If styling must be shared independently of rendering, extract shared rules to an explicit shared/global stylesheet.

- **MANDATORY**: Use TypeScript's `satisfies` operator to validate component-owned class string literals at call sites.

```ts
<div className={cn("Thread" satisfies Thread_ClassNames)} />
```

## One \_ClassNames type per component

Each component owns exactly one `<ComponentName>_ClassNames` type for its own class contract. If a module contains multiple components (including compound subcomponents), each component defines and uses its own `_ClassNames` type.

**Type placement**: put each `_ClassNames` type directly above its component definition, before related `_Props` / `_Ref` types.

- A chooser/composer component and each concrete rendered variant count as separate components for this rule. `Foo`, `FooSelected`, and `FooSelectable` must not be collapsed into one `_ClassNames` contract.
- If the chooser/composer has no owned DOM node, it may omit `_ClassNames` entirely. In that case, keep only `Foo_Props` and `Foo` in its region.

## Region boundaries: class name ownership (default)

When a module uses `// #region ...` blocks to encapsulate components, you must treat each region as a component boundary.

By default, a component must only use class names from its own `_ClassNames` type (its own region). Do not “reach across” regions and use another component’s class name type just because it exists in the same file.

If you need a class name for a subcomponent, create a dedicated `<SubcomponentName>_ClassNames` type for that subcomponent and use that type inside the subcomponent implementation.

## Extraction rename rule (mandatory)

When extracting JSX into a new component (same file or new file), rename class literals to the new component prefix and update matching CSS selectors in the same change.

- The extracted component must own `NewComponent*` class names in `NewComponent_ClassNames`.
- Do not leave only `OldComponent*` classes inside the extracted component.
- If reuse is intentional, apply both classes (`NewComponent*` + `OldComponent*`) and satisfy both class contracts.

✅ Good: subcomponent owns its class names

```tsx
export type AiChatMessageUser_ClassNames = "AiChatMessageUser" | "AiChatMessageUser-role-user";

export function AiChatMessageUser(props: AiChatMessageUser_Props) {
	return <div className={cn("AiChatMessageUser-role-user" satisfies AiChatMessageUser_ClassNames)} />;
}
```

❌ Bad: subcomponent uses the parent/root region’s class name type by default

```tsx
export type AiChatMessage_ClassNames = "AiChatMessage" | "AiChatMessage-role-user";

export function AiChatMessageUser(props: AiChatMessageUser_Props) {
	return <div className={cn("AiChatMessage-role-user" satisfies AiChatMessage_ClassNames)} />;
}
```

## Exceptions (must be intentional and explicit)

You may use class names from another region only when you intentionally want one of these behaviors:

### Reuse exact styling

You are intentionally inheriting the exact same styles (apply both classes and type-check them), and the reused styles are meant to be shared.

### Cross-component selectors / DOM targeting

You are intentionally targeting another component in a selector or query (for example `:has(...)`, `querySelector`, or test selectors). In this case, using another region’s class name is allowed because the goal is explicit cross-component targeting, not ownership.

**Reusing styles from other components**: import the other component's `_ClassNames` type and apply both class names (the local identity class + the reused class).

```tsx
import type { MyInputArea_ClassNames, MyInputControl_ClassNames } from "./my-input.tsx";

export type MyComboboxInputArea_ClassNames = "MyComboboxInputArea";

export function MyComboboxInputArea(props: MyComboboxInputArea_Props) {
	const { className, children, ...rest } = props;
	return (
		<div
			className={cn(
				"MyComboboxInputArea" satisfies MyComboboxInputArea_ClassNames,
				"MyInputArea" satisfies MyInputArea_ClassNames,
				className,
			)}
			{...rest}
		>
			{children}
		</div>
	);
}
```

- Variants and sizes must be represented directly in each component's `_ClassNames` type. Use conditional adds with `satisfies` for validation.
- Prefer explicit modifier naming segments in class values: `ComponentName-modifierType-value` (for example `Button-variant-default`, `Button-size-sm`, `Button-state-loading`) instead of ambiguous forms like `Button--sm`.

### CSS Authoring Details

#### Layering

```css
@layer components {
	/* Feature-level / context-specific component styles (e.g. ai-chat, page-editor, routes) */
}

@layer common_components {
	/* Reusable app “primitives” used across many contexts (e.g. MyButton, MyInput, MyModal, MyIconButton) */
}
```

#### Which layer should I use?

- Use `@layer components` for **high-level, feature/context styles** (routes, ai-chat, page-editor, sidebars specific to a page/feature).
- Use `@layer common_components` for **shared/reusable UI components** (the `My*` component CSS files, small primitives used broadly).

#### Group selectors by component, then by role

- Keep each component’s selectors contiguous (don’t interleave other components).
- For each component, prefer this adjacency:
  - Base selector (e.g. `.MyThing`)
  - Direct children / slots (e.g. `.MyThing-title`, `.MyThing-actions`)
  - Modifiers/states (e.g. `.MyThing-state-open`, `.MyThing-variant-...`)
  - Contextual overrides (e.g. `.MyThing-state-open .MyThing-title`)

#### Modern CSS Nesting

- Prefer nesting by default for component-owned selectors. If a selector starts with the current component class, write it inside that component's base block unless there is a clear reason not to.
- Use the `&` syntax for pseudo-classes, child selectors, modifiers/states, and contextual overrides that belong to the same component.
- Keep component states and owned slots nested under the base component selector to maintain low specificity and make selector ownership obvious.
- Flatten selectors only when you are intentionally expressing cross-component relationships, shared/global rules, or a selector that does not have one clear component owner.

```css
/* ✅ Good - using modern CSS nesting with low specificity */
.Button {
	/* Base styles */

	&:hover {
		/* Hover styles with low specificity */
	}

	&:focus-visible {
		/* Focus styles with low specificity */
	}

	& svg {
		/* SVG child styles with low specificity */
		pointer-events: none;
		flex-shrink: 0;
	}

	&.Button-variant-outline {
		border-color: var(--color-base-1-05);
	}
}

/* ❌ Bad - separate selectors increase complexity */
.Button {
	/* Base styles */
}

.Button:hover {
	/* Hover styles - separate selector */
}

.Button svg {
	/* Child styles - separate selector */
}

.Button.Button-variant-outline {
	/* Variant styles - separate selector */
}
```

#### Property Grouping and Organization

- Use empty lines to group related properties.
- Common property groups:
  - Box model (position, display, box-sizing)
  - Layout (flex, grid, gap, align-items)
  - Spacing (padding, margin)
  - Typography (font properties)
  - Visual (color, background, border)
  - Transitions and animations

```css
.Button {
	position: relative;

	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 0.5rem;

	padding: 0.5rem 1rem;
	border-radius: 0.375rem;

	font-size: 0.875rem;
	font-weight: 500;
	line-height: 1.25rem;

	background: var(--color-accent-06);
	color: var(--color-fg-12);

	transition: all 0.15s ease;
}
```

#### Flex alignment keywords

- Prefer logical keywords `start` / `end` over `flex-start` / `flex-end` (e.g. `align-self: end`, `justify-content: start`) so alignment stays consistent across writing modes.

#### Size Units: Avoid rem for Sizing

**Avoid using `rem` or `em` units for sizing properties** (padding, width, height, margin) unless explicitly requested by the user.

```css
/* ✅ Good - px for precise sizing */
.Button {
	padding: 8px 16px;
	width: 120px;
	height: 40px;
	margin: 4px;
	gap: 8px;
	border-width: 1px;
	top: 8px;
	left: 12px;
}

/* ✅ Good - rem for typography */
.Button {
	font-size: 0.875rem;
	line-height: 1.25rem;
}

/* ❌ Avoid - rem for sizing unless requested */
.Button {
	padding: 0.5rem 1rem;
	width: 7.5rem;
	height: 2.5rem;
	margin: 0.25rem;
	gap: 0.5rem;
	top: 0.25rem;
	left: 0.5rem;
}
```

#### Color System

This project uses a custom color system defined in `app.css` with `oklch()` values. The system is currently **dark-mode only**.

##### How it works

- Each color has a numbered scale (e.g. `--color-base-1-01` through `--color-base-1-12`). The last number varies by color — it can be 10, 12, or other values.
- **`-01` is the darkest shade, higher numbers are progressively lighter.** Every step is lighter than the previous one.
- This gives flexibility and predictability: instead of being constrained to a few named tokens like "primary" / "secondary", you pick the shade that matches the element's visual depth in the UI.

##### Depth model (dark mode)

The color system follows a depth-based approach:

- **Deepest elements** (page background, main content area) use the **darkest shades** (low numbers like `-01`, `-02`).
- **Higher / elevated elements** (buttons, sidebars, popovers, cards) use **progressively lighter shades** (higher numbers like `-04`, `-05`, `-06`).
- This creates visual depth — elements that sit "above" the background appear lighter, giving the UI layering.

##### Using the variables

Use `var(--color-...)` directly — **no** `hsl()` wrapper needed (the variables already contain complete `oklch()` color values).

##### Available color scales

- **`--color-base-1-*`** (01–12) and **`--color-base-2-*`** (01–12) — Neutral backgrounds and surfaces. Base comes in two groups: group 1 has the dark shades, group 2 has the brighter shades. Use these for page backgrounds, cards, panels, inputs, borders, etc.
- **`--color-base-alt-1-*`** / **`--color-base-alt-2-*`** — Alternative neutral with a cool (blue) hue. Use to emphasize or differentiate certain sections from the main base surfaces.
- **`--color-fg-*`** (01–12) — Foreground content: text, icons, outlines. 01 is the dimmest, 12 is the brightest.
- **`--color-accent-*`** (01–10) — Primary accent (warm orange). For interactive/important elements like links, active states, primary buttons.
- **`--color-accent-alt-*`** (01–10) — Secondary accent (blue/purple). For secondary emphasis, tags, or alternative highlights.
- **`--color-green-*`** (01–12) — Success / positive states.
- **`--color-red-*`** (01–12) — Danger / destructive / error states.

```css
/* ✅ Good - use var() directly */
background: var(--color-accent-06);
color: var(--color-fg-10);
border-color: var(--color-base-1-05);

/* ❌ Bad - do not use hsl() or shadcn variables */
background: hsl(var(--primary));
color: hsl(var(--foreground));
```

#### Dark Mode Support

- Use `@media (prefers-color-scheme: dark)` for dark theme handling.
- Place dark mode overrides within the component scope.

```css
.Button-variant-outline {
	background: var(--color-base-1-02);
	border: 1px solid var(--color-base-1-05);

	@media (prefers-color-scheme: dark) {
		background: var(--color-base-1-04);
		border-color: var(--color-base-1-06);
	}
}
```

#### State Handling

- Use nested pseudo-classes for interactive states.
- Handle disabled, focus, hover, and active states consistently.

```css
.Button {
	/* Base styles */

	&:disabled {
		pointer-events: none;
		opacity: 0.5;
	}

	&:focus-visible {
		outline-color: var(--color-fg-12);
	}

	&:hover {
		background: var(--color-accent-07);
	}
}
```

#### Child Element Styling

- Use low-specificity child selectors via nesting.
- Use semantic child selectors.

```css
.Button {
	/* Base styles */

	& svg {
		pointer-events: none;
		flex-shrink: 0;

		&:not([class*="size-"]) {
			width: 1rem;
			height: 1rem;
		}
	}

	&:has(> svg) {
		padding-left: 0.75rem;
		padding-right: 0.75rem;
	}
}
```

#### Container Performance & Clipping

Prefer `contain: content` for container components (e.g., sidebars) instead of `overflow: hidden` to limit layout/paint scope without clipping descendants. This plays well with animated size changes.

```css
/* Example */
.MySidebar {
	contain: content;
	transition: width 200ms linear;
}

/* Class-based state (instead of attributes) */
.MySidebar-state-collapsed {
	width: 47px;
}
.MySidebar-state-closed {
	display: none;
}
```

#### Example Complete Component

```css
@layer components {
	.Card {
		position: relative;

		display: flex;
		flex-direction: column;

		padding: 1.5rem;
		border-radius: 0.5rem;
		border: 1px solid var(--color-base-1-05);

		background: var(--color-base-1-03);
		color: var(--color-fg-10);

		box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1);
	}

	/* Variant: Elevated */
	.Card-variant-elevated {
		box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);

		&:hover {
			box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1);
		}
	}

	/* Size: Compact */
	.Card-size-compact {
		padding: 1rem;
	}

	/* Size: Large */
	.Card-size-large {
		padding: 2rem;
	}
}
```

#### Benefits of This Approach

- **Low specificity**: Easy to override styles when needed.
- **Modern CSS**: Uses latest nesting and selector features.
- **Maintainable**: Clear naming convention and organization.
- **Performance**: Efficient CSS with minimal specificity conflicts.
- **Scalable**: Consistent patterns across all components.

```ts
export type Button_ClassNames =
	| "Button"
	| "Button-variant-default"
	| "Button-variant-destructive"
	| "Button-variant-outline"
	| "Button-variant-ghost"
	| "Button-size-default"
	| "Button-size-sm"
	| "Button-size-lg"
	| "Button-size-icon";

export function Button(
	props: {
		className?: string;
		variant?: "default" | "destructive" | "outline" | "ghost" | null;
		size?: "default" | "sm" | "lg" | "icon";
	} & React.ComponentProps<"button">,
) {
	const { className, variant = "default", size = "default", ...rest } = props;
	return (
		<button
			className={cn(
				"Button" satisfies Button_ClassNames,
				variant === "default" && ("Button-variant-default" satisfies Button_ClassNames),
				variant === "destructive" && ("Button-variant-destructive" satisfies Button_ClassNames),
				variant === "outline" && ("Button-variant-outline" satisfies Button_ClassNames),
				variant === "ghost" && ("Button-variant-ghost" satisfies Button_ClassNames),
				size === "default" && ("Button-size-default" satisfies Button_ClassNames),
				size === "sm" && ("Button-size-sm" satisfies Button_ClassNames),
				size === "lg" && ("Button-size-lg" satisfies Button_ClassNames),
				size === "icon" && ("Button-size-icon" satisfies Button_ClassNames),
				className,
			)}
			{...rest}
		/>
	);
}
```

## Component CSS Variables (\_CssVars)

Use a `<ComponentName>_CssVars` type to model component-scoped CSS custom properties and provide defaults merged into the `style` prop. Spread defaults first, then user `style` so the user can override defaults.

```tsx
export type Thread_ClassNames = "Thread" | "Thread-header" | "Thread-actions";

export type Thread_CssVars = {
	"--thread-width": string;
	"--thread-width-collapsed": string;
};

const Thread_CssVars_DEFAULTS: Partial<Thread_CssVars> = {
	"--thread-width": "320px",
	"--thread-width-collapsed": "48px",
} as const;

export type Thread_Props = React.ComponentProps<"aside"> & {
	style?: React.CSSProperties & Partial<Thread_CssVars>;
	width?: string;
	widthCollapsed?: string;
};

export function Thread(props: React.ComponentProps<"aside">) {
	const { className, style, width, widthCollapsed, ...rest } = props;
	return (
		<aside
			className={cn("Thread" satisfies Thread_ClassNames, className)}
			style={{
				...({
					...Thread_CssVars_DEFAULTS,
					"--thread-width": width ?? Thread_CssVars_DEFAULTS["--thread-width"],
					"--thread-width-collapsed": widthCollapsed ?? Thread_CssVars_DEFAULTS["--thread-width-collapsed"],
				} satisfies Partial<Thread_CssVars>),
				...style,
			}}
			{...rest}
		/>
	);
}
```

- Prefer overriding specific properties via `className` over custom positioning. Fall back to custom CSS only when necessary.

## className and style utilities

Use `cn` from `@/lib/utils.ts` to merge class names, and `sx` for style objects:

When only a single static class is used and `className` is not merged, prefer a plain string (optionally with `satisfies`) over `cn(...)`. Do not refactor existing `cn("SingleClass")` usages solely for this reason.

```ts
import { cn, sx } from "@/lib/utils.ts";

// className merging with cn
<div
	className={cn(
		"base-class" satisfies MyComponent_ClassNames,
		className,
		condition && "conditional-class",
	)}
/>

// style objects with sx (especially useful for CSS custom properties)
<div
	style={sx({ "--MyComponent-custom-var": value } satisfies Partial<MyComponent_CssVars>)}
/>
```

### Tailwind utility class whitelist

In general, do **not** use Tailwind for styling; use vanilla CSS in component-owned `.css` files. A small set of Tailwind utility classes is allowed when they provide standard accessibility or layout behavior that would otherwise require custom CSS with no benefit:

- **`sr-only`** — Visually hide content while keeping it available to screen readers (e.g. for disclosure buttons, skip links, or accessible labels). Prefer this over custom “visually hidden” rules when the intent is screen-reader-only content.

Add new entries to this whitelist only when a Tailwind utility clearly solves a cross-cutting need (e.g. accessibility) without pulling in broader Tailwind usage. Do not use other Tailwind classes (e.g. spacing, colors, typography) unless they are added here.

## List rows: primary action + secondary actions (overlay grid + subgrid)

Use this pattern for list rows where:

- The row should be clickable as a single **primary action** (open/select).
- The row also has **secondary icon actions** (star/archive/rename, etc.).
- The row highlight on hover should match the primary click target (no “dead” padding).
- The primary label must never go underneath the actions (proper truncation).

### Core idea

- The row container is a 2-column grid: `1fr auto` (content + actions).
- The **primary action element** spans the full row and uses `subgrid` so it “inherits” the same column layout as the row.
- The **actions container** sits in the right column and intercepts clicks in the actions area, so clicking between action buttons does not trigger the primary action.

### CSS template

```css
.Row {
	display: grid;
	grid-template-columns: 1fr auto;
	align-items: center;

	border: 1px solid transparent; /* enables :focus-within border affordance */
}

.Row-primary {
	grid-column: 1 / -1;
	grid-row: 1;

	display: grid;
	grid-template-columns: subgrid;
	align-items: center;

	height: 36px; /* match action button height */
	padding: 0 12px; /* row padding belongs here */
}

.Row-title {
	grid-column: 1;
	min-width: 0;

	contain: content;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.Row-actions {
	grid-column: 2;
	grid-row: 1;

	display: flex;
	align-items: center;
	gap: 4px;

	/* Keep pointer-events enabled so clicks in this zone don't hit .Row-primary */
	pointer-events: auto;
}
```

### Interaction guidance

- Prefer a single row-level focus affordance: `.Row:focus-within { border-color: ... }` so the whole row reads as “focused”.
- Apply hover/selected backgrounds to `.Row` (not the primary button) so the visual highlight includes the actions area too.
- Use a shared icon button component for secondary actions (e.g. `MyIconButton`/`MyIconButtonIcon`) to keep hover/focus colors consistent.

## Ariakit composites with inline row actions (Select/Combobox)

When a `MySelectItem` / `MySearchSelectItem` row also contains secondary action buttons (favorite/archive/etc.), implement actions with composite-safe behavior:

- Keep the row as the composite primary action (`MySelectItem`/`MySearchSelectItem` with `value`).
- Mark action buttons with a component-owned `data-*` attribute and gate row click behavior via `hideOnClick` + `setValueOnClick`.
- Prevent action `mousedown` from stealing focus from the composite item (`event.preventDefault()` + `event.stopPropagation()`).
- Keep action buttons out of tab order unless their row is the current active composite item.
- In feature components, prefer wrapper static hooks (`MySearchSelect.useStore`, `MySearchSelect.useStoreState`) instead of directly using Ariakit context/store hooks.

### Required wiring template

```tsx
const selectStore = MySearchSelect.useStore();

const isActiveItem =
	MySearchSelect.useStoreState(selectStore, (state) => {
		if (!state?.activeId) return false;
		const activeItem = selectStore.item(state.activeId);
		return activeItem?.value === rowValue;
	}) ?? false;

const handleItemClickBehavior = (event: MouseEvent<HTMLElement>) => {
	const target = event.target;
	if (!(target instanceof HTMLElement)) return true;
	return !target.closest("[data-row-action]");
};

<MySearchSelectItem hideOnClick={handleItemClickBehavior} setValueOnClick={handleItemClickBehavior} value={rowValue}>
	<MyIconButton data-row-action tabIndex={isActiveItem ? 0 : -1} onMouseDown={handleActionMouseDown} />
</MySearchSelectItem>;
```

## Modern Context with use Hook

**MANDATORY**: Use React 19's `use` hook instead of `useContext` for consuming context.

### Context Setup Pattern:

```tsx
import { createContext, use, useState, ReactNode } from "react";

interface SearchContextType {
	searchQuery: string;
	isLoading: boolean;
	setSearchQuery: (query: string) => void;
	setIsLoading: (loading: boolean) => void;
}

const SearchContext = createContext<SearchContextType | null>(null);

const useSearchContext = () => {
	const context = use(SearchContext);
	if (!context) {
		throw new Error("useSearchContext must be used within SearchContextProvider");
	}
	return context;
};

function SearchContextProvider(props: { children: ReactNode }) {
	const { children } = props;
	const [searchQuery, setSearchQuery] = useState("");
	const [isLoading, setIsLoading] = useState(false);

	return (
		<SearchContext.Provider
			value={{
				searchQuery,
				setSearchQuery,
				isLoading,
				setIsLoading,
			}}
		>
			{children}
		</SearchContext.Provider>
	);
}
```

## Ref as a regular prop

You must pass `ref` as a regular prop without `forwardRef`:

```tsx
// ✅ React 19: ref as regular prop (new way)
export interface Button_Props {
	ref?: Ref<HTMLButtonElement>;
	children: React.ReactNode;
}

export function Button(props: Button_Props) {
	const { ref, children, ...rest } = props;

	return (
		<button ref={ref} {...rest}>
			{children}
		</button>
	);
}
```

## Forwarding ref to children

Use a callback ref with the `forward_ref` helper to forward the instance to the parent `ref` and internal ref targets.

```tsx
import { forward_ref } from "@/lib/utils.ts";

function Parent(props: { ref?: React.Ref<any> }) {
	const { ref } = props;
	const childRef = useRef<any>(null);

	return (
		<Child
			ref={(inst) => {
				return forward_ref(inst, ref, childRef);
			}}
		/>
	);
}
```

You can also use `forward_ref` to forward the same instance to a `setState` function (for example, store a DOM node in state so you can pass it as an `IntersectionObserver` root).

```tsx
import { forward_ref } from "@/lib/utils.ts";

function Example() {
	const divRef = useRef<HTMLDivElement | null>(null);
	const [root, setRoot] = useState<HTMLDivElement | null>(null);

	return <div ref={(node) => forward_ref(node, divRef, setRoot)} />;
}
```

## Imperative handle pattern

```tsx
import React, { useImperativeHandle, useRef, useState, Ref } from "react";

export interface MyWidget_Ref {
	rootElement: HTMLDivElement | null;
	focusInput: () => void;
	getValue: () => string;
}

export type MyWidget_Props = React.ComponentProps<"div"> & {
	ref?: Ref<MyWidget_Ref>;
	initialValue?: string;
};

export function MyWidget(props: MyWidget_Props) {
	const { ref, initialValue = "", className, ...rest } = props;
	const rootRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const [value, setValue] = useState(initialValue);

	useImperativeHandle(
		ref,
		() => ({
			rootElement: rootRef.current,
			focusInput: () => inputRef.current?.focus(),
			getValue: () => value,
		}),
		[value],
	);

	return (
		<div ref={rootRef} className={cn("MyWidget", className)} {...rest}>
			<input ref={inputRef} value={value} onChange={(e) => setValue(e.target.value)} className={cn("MyWidget-input")} />
		</div>
	);
}
```

## Stable prop callbacks with `useFn`

Use `useFn` from `packages/app/src/hooks/utils-hooks.ts` when you need a stable callback identity outside an effect, especially for callbacks passed to memoized children or non-React APIs that benefit from receiving the same function reference across renders.

- Use `useFn` for event handlers you pass down as props when the child or consumer benefits from a stable callback identity.
- Prefer `useFn` over `useCallback` for this repo's "latest value + stable identity" callback pattern.
- Keep using plain inline closures when you do not need a stable callback contract.

```tsx
const handleClick = useFn(() => {
	doSomethingWithLatestValue(value);
});

return <MyIconButton onClick={handleClick} />;
```

## Component attached exports (Fast Refresh / HMR-friendly)

When a component needs attached exports (for example `Component.useStore`), keep them on the component via dot notation.

For memoized components with attached static exports, use this pattern:

1. Create one symbol with `Object.assign(memo(function Component(...) { ... }), { ...staticFields })`.
2. Export that symbol with a separate named export line (`export { Component };`).
3. Keep static fields stable and colocated in the `Object.assign` object.

- Prefer `MyContextProvider.useContext` over a separate `export function useMyContext()`.
- Attach only _stable_ helpers/hooks/constants that are conceptually owned by the component.
- Do not use `Object.assign(..., { Subpart })` just to fake a local compound component API for organization. Reserve attached static exports for genuine public static helpers or constants that are conceptually part of that component's API.

```tsx
const MyContextProvider = Object.assign(
	memo(function MyContextProvider(props: MyContextProvider_Props) {
		const { children } = props;

		// ...

		return children;
	}),
	{
		useContext: function useContext() {
			// ... read context ...
			return {};
		},
		DEFAULTS: {
			mode: "default",
		} as const,
	},
);

export { MyContextProvider };
```

# Convex Environment Variables

## Two URLs for Different Purposes

- VITE_CONVEX_URL - WebSocket/real-time (queries, mutations, subscriptions)
- VITE_CONVEX_HTTP_URL - HTTP actions (API endpoints, authentication)

## HTTP Request Configuration

Use centralized fetch utilities from [packages/app/src/lib/fetch.ts](packages/app/src/lib/fetch.ts) for internal HTTP requests.

For third-party integrations, construct URLs manually using `VITE_CONVEX_HTTP_URL`.

If a function is imported as camelCase, keep it as-is:

```ts
import { randomUUID } from "node:crypto";
const uuid = randomUUID();
window.matchMedia("(prefers-color-scheme: dark)").matches;
```

# Playwright / browser tools

Do not use Playwright or the browser automation tools unless the user explicitly requests it.

Instead prefer using `Playwriter` if available. `Playwriter` is a superior tool to use the browser.

# Debug mode logging (Convex exception)

When working in debug mode, follow hypothesis-driven runtime debugging and use temporary instrumentation logs.

- For frontend/client JavaScript or TypeScript paths, use the configured debug ingestion endpoint/log-file workflow when requested by the session.
- **For Convex code paths, do not use fetch-based debug logging to localhost ingestion endpoints.**
- For Convex debugging, add temporary structured `console.log` instrumentation in Convex code, then read those logs from the terminal output while `pnpx convex dev` is running.
- If Convex logs are needed, inspect the relevant terminal output file (the terminal stream contains Convex server logs).
- Keep temporary logs during verification runs, then clean them up after the fix is confirmed.
