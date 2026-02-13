# Package manager

This repository uses `pnpm` do not use `npm`.

# Running commands in the terminal

Do not run `pnpm run dev` let the user run it manually.

# Code Quality and Linting

Do not run commands to verify lints or check code quality (such as `pnpm lint`, `pnpm type-check`, or similar commands). Instead, rely only on the information that Cursor automatically provides through its built-in linting and error detection.

You can run linting commands only if the user explicitly requests it.

# Project Structure and Key Directories

## Monorepo Structure

This is a monorepo project with the following essential structure that you must always be aware of:

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
  - [vendor/liveblocks/](packages/app/vendor/liveblocks) - Liveblocks submodule (full repo for reference)
  - [vendor/opencode/](packages/app/vendor/opencode) - OpenCode development platform submodule (full repo for reference)
  - [vendor/novel/](packages/app/vendor/novel) - Novel rich text editor submodule (full repo for reference)

- [references-submodules/](references-submodules) - Reference-only git submodules (docs + source scraping)

  - [assistant-ui/](references-submodules/assistant-ui) - Assistant UI submodule (reference-only)

- [+personal/](+personal) - DOCUMENTATION & RESEARCH FOLDER
  - [+personal/+ai/](+personal/+ai) - Only writable subfolder for AI-generated content
  - [+personal/sources/](+personal/sources) - Local research sources, contains 3rd party codebases and documentation for research purposes
  - [+personal/sources/README.md](+personal/sources/README.md) - Master list of local research sources, read this if you need to read inside the [+personal/sources/](+personal/sources) folder to have an idea of what the packages are
  - DO NOT MODIFY other files in +personal/ - they are reference material only

## Submodules (Special Import Handling)

The `assistant-ui` repository is checked out as a **reference-only** submodule at `references-submodules/assistant-ui`.
The app should **not** depend on `@assistant-ui/*` packages; use normal `node_modules` dependencies for runtime.

- [packages/app/vendor/liveblocks/](packages/app/vendor/liveblocks) - Liveblocks submodule

  - Importing: Use standard node_modules imports in the app, submodule is for reference
    - Correct:
      ```ts
      import { LiveblocksProvider } from "@liveblocks/react";
      ```
  - Documentation folders:
    - [docs/](packages/app/vendor/liveblocks/docs)
    - [guides/](packages/app/vendor/liveblocks/guides)
    - [tutorial/](packages/app/vendor/liveblocks/tutorial)
  - Examples folders:
    - [examples/](packages/app/vendor/liveblocks/examples)
    - [starter-kits/](packages/app/vendor/liveblocks/starter-kits)

- [references-submodules/ai/](references-submodules/ai) - AI SDK repository

  - Importing: Use standard node_modules imports in the app, submodule is for reference
  - Documentation folders:
    - [content/docs/](references-submodules/ai/content/docs)
    - [content/providers/](references-submodules/ai/content/providers)
  - Examples folders:
    - [examples/](references-submodules/ai/examples)

- [references-submodules/ai-chatbot/](references-submodules/ai-chatbot) - Vercel AI Chatbot reference app/template

- Convex reference repositories (submodules under [references-submodules/](references-submodules))

  - Importing: Use standard node_modules imports in the app, submodules are for reference only
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

- [packages/app/vendor/opencode/](packages/app/vendor/opencode) - OpenCode development platform submodule

  - Importing: Use standard node_modules imports in the app, submodule is for reference
  - Documentation folders:
    - [README.md](packages/app/vendor/opencode/README.md)
    - [AGENTS.md](packages/app/vendor/opencode/AGENTS.md)
  - Package folders:
    - [packages/](packages/app/vendor/opencode/packages)

- [packages/app/vendor/novel/](packages/app/vendor/novel) - Novel rich text editor submodule
  - Importing: Use standard node_modules imports in the app, submodule is for reference
    - Correct:
      ```ts
      import { useEditor } from "novel";
      ```
  - Documentation folders:
    - [README.md](packages/app/vendor/novel/README.md)
  - Examples folders:
    - [apps/web/](packages/app/vendor/novel/apps/web) - Example implementation
  - Package folders:
    - [packages/headless/](packages/app/vendor/novel/packages/headless) - Core editor package

## 3rd Party Documentation Research

When users ask about 3rd party libraries or request implementations using external dependencies, conduct thorough documentation research for accurate responses.

Documentation Sources

- [+personal/sources](+personal/sources) - read [+personal/sources/README.md](+personal/sources/README.md) when reading inside the folder
- You may assume `+personal/sources/` matches runtime versions (e.g. `node_modules/.pnpm`).
- Submodules - [references-submodules/assistant-ui/](references-submodules/assistant-ui), [packages/app/vendor/liveblocks/](packages/app/vendor/liveblocks), [references-submodules/ai/](references-submodules/ai), [references-submodules/convex-backend/](references-submodules/convex-backend), [references-submodules/convex-helpers/](references-submodules/convex-helpers), [references-submodules/convex-js/](references-submodules/convex-js), and [packages/app/vendor/opencode/](packages/app/vendor/opencode), and [packages/app/vendor/novel/](packages/app/vendor/novel) have full repos for reference
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

## Import Guidelines

### Standard Library Imports

For other libraries like Liveblocks, use standard node_modules imports:

```ts
// ✅ CORRECT - Standard import
import { LiveblocksProvider } from "@liveblocks/react";
```

# Code guidelines and patterns

You must not use `any` to bypass typescript errors unless the user is asking for it.

## TypeScript return types: prefer inference

Avoid explicitly annotating function return types; prefer TypeScript's inferred return type.

Exceptions (add an explicit return type when it helps):

- Exported/public API functions where the return type is part of the contract
- When inference is unstable/too-wide and a return annotation prevents regressions

Use tab indentation for `.ts`, `.tsx` and `.css` files.

## Errors as values (`Result`) pattern

This codebase uses the `Result` helper from `packages/app/shared/errors-as-values-utils.ts` for recoverable errors.

Return `Result` values with explicit success/failure branches:

```ts
return Result({ _yay: value });
return Result({
	_nay: {
		name: "nay",
		message: "[OwnerSymbol.operation] Error while doing something",
		cause: error,
	},
});
```

When consuming a Result-returning function:

- Handle both branches explicitly (`_yay` and `_nay`)
- Prefer bubbling `_nay` at the same abstraction layer (`if (result._nay) return result;`)
- Do not ignore returned Result values; if bubbling is not possible, at least log the `_nay` with context

### Throwing because of `_nay`

At boundaries where you must throw (for example integration boundaries), throw an ad hoc error message and pass `_nay` in `cause`:

```ts
if (result._nay) {
	throw new Error("[OwnerSymbol.operation] Failed to perform operation", {
		cause: result._nay,
	});
}
```

Never throw raw `_nay.message` directly:

```ts
// bad
throw new Error(result._nay.message);
```

### Message string format

For both `_nay.message` and throw messages:

- Start with `[OwnerSymbol.operation]`
- Describe the failed operation in clear terms (`Failed to ...`, `Error while ...`)
- Keep the message stable and concise (do not embed volatile payloads)
- Put details in `cause` and structured logs, not in the message text

## Consistency requirement (same-author rule)

When editing existing code, your changes must match the existing local style and patterns in that file and nearby modules — **it should look like the same person wrote the code**. Do not introduce new organizational patterns, naming conventions, or stylistic preferences unless the user explicitly requested it or it is required for correctness.

### Type and classnames colocation

Keep component-scoped types next to their owner component instead of centralizing them in a single module-level block.

- For component styling contracts, place `*_ClassNames` immediately above the related `*_Props` and component.
- If a small component has no dedicated `*_Props`, keep its `*_ClassNames` directly above that component.
- Avoid creating a top-level "css contracts" region that groups classnames/types for many components in one place.
- Keep helper/data structure types with helper logic, and keep root component types with the root component region.

### Region organization (flat, non-nested)

Use region comments as a flat list to keep the VS Code minimap easy to navigate.

- Do not nest `#region` blocks inside other `#region` blocks.
- Use ad hoc component regions (one region per component), even for small descendants.
- Avoid umbrella regions like "atoms", "subcomponents", or similar grouped component buckets.
- Use lowercase word-case names for region labels.
- Keep region labels concise and avoid repeating a shared file/component prefix (for example, prefer `#region tree item` over `#region pages sidebar tree item`).
- Keep the root component region at the bottom of the file, after lower-level components/helpers, and name it exactly `root`.
- Do not create `#region` blocks inside a component body for "local state", "handlers", "render", etc., unless the user explicitly requests that structure.
- If you need extra grouping inside a component, use plain comments instead of more `#region` markers.

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

## React Compiler: avoid try/catch/finally blocks

The React Compiler currently has issues lowering `try { ... } catch { ... } finally { ... }` (especially with a `finally` clause) inside components/handlers. Prefer the existing pattern used in this repo:

- Wrap async logic in an `async (/* iife */) => { ... }` IIFE
- Handle errors with `.catch(...)`
- Do cleanup/state resets with `.finally(...)`

## Casing

Use these naming rules with one practical exception for symbols that are tightly scoped to a specific component, hook, or utility.

### Root Level Module Symbols (default: snake_case)

```ts
export const ai_chat_HARDCODED_PROJECT_ID = "app_project_local_dev";

export class ai_chat_MyClass {
	constructor(public projectId: string) {}
}

export interface ai_chat_MyInterface {
	projectId: string;
}

export type ai_chat_MyType = {
	projectId: string;
};

export function ai_chat_my_function(projectId: string) {
	const processedResult = processData(projectId);
	return processedResult;
}

export enum ai_chat_MyEnum {
	PROJECT_ID = "app_project_local_dev",
}
```

### Root-Level Scoped Symbols (allowed: OwnerSymbol_Descriptor)

When a root-level symbol exists only to support a specific owner symbol (component, hook, or utility), you may use `OwnerSymbol_Descriptor`.

This is the pattern used for colocated helper types and companion utilities, for example:

```ts
type AiChatThread_Props = { ... };
type AiChatThread_ClassNames = "AiChatThread" | "AiChatThread-content";
type useAutoScroll_Props = { ... };
```

Use this pattern only for tightly related declarations. Keep shared/generic module APIs in `snake_case`.

### Everything Else (camelCase)

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

Components use PascalCase, hooks use camelCase:

```ts
export function ThemeProvider() {}
export function MessageComposer() {}
export function useTheme() {
	return { mode: "light", resolvedTheme: "light", setMode: () => {} };
}
export function useAiChat_grouped_threads() {
	const threadGroups = useMemo(() => {}, []);
	return threadGroups;
}
```

#### Hook naming gotcha (React Compiler)

React tooling (and the React Compiler) expects hooks to be named in the form `useXxx...` where the character immediately after `use` is uppercase.

- ✅ Good: `usePagesLastOpen`, `useAiChatController`, `useAiChat_grouped_threads`
- ❌ Bad: `use_pages_last_open`, `use_ai_chat_controller`, `use_foo`

### Third-Party and Native JavaScript Functions

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
- Example: import from "./components/ui/button.tsx" or export from "./button.tsx"; do not add a directory-level index.
- Barrel files are bad for intellisense and code completion.

# Application Architecture

This app is an AI chatbot that allows users to chat with AI, call tools, and produce documents in a canvas panel.

## Backend Architecture

The backend uses Convex as the primary backend platform, located in [packages/app/convex/](packages/app/convex):

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

The frontend is a React 19 application located in [packages/app/src/](packages/app/src):

- [main.tsx](packages/app/src/main.tsx) - Application entry point with providers
- [routes/](packages/app/src/routes) - TanStack Router route definitions
  - [\_\_root.tsx](packages/app/src/routes/__root.tsx) - Root layout with auth setup
  - [index.tsx](packages/app/src/routes/index.tsx) - Home page
  - [chat.tsx](packages/app/src/routes/chat.tsx) - Main chat interface with canvas
- [components/](packages/app/src/components) - React components organized by feature
  - [assistant-ui/](packages/app/src/components/assistant-ui) - Chat interface components
  - [canvas/](packages/app/src/components/canvas) - Canvas/document editing components
  - [ui/](packages/app/src/components/ui) - Shared UI components

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
- React Complex Tree - Docs/file explorer
- Vite - Dev/build tool
- Playwright - UI verification
- AI SDK + OpenAI - AI integration and streaming

## Application Structure

The app runs at http://localhost:5173/ during development.

- Chat: The center panel sends messages to Convex HTTP actions (`packages/app/convex/http.ts`, `packages/app/convex/ai_chat.ts`). Responses stream token-by-token and may call tools. Tool outputs render inline in the chat UI.
- Agent file access: Server-side tools in `packages/app/server/server-ai-tools.ts` let the agent read, write, and diff files in the workspace (search, edits, filesystem ops). These run in Node, not the browser, and are invoked through tool calls from the chat flow.
- Docs: The docs experience combines a file/tree explorer and an editor surface. Content supports rich text Markdown via BlockNote and code/diff via Monaco Diff Editor. The canvas can switch between these modes depending on the document type.
- Collaboration: Liveblocks + Yjs provide real-time presence and editing. Convex acts as a secondary source of truth: we persist Yjs snapshots and metadata (`packages/app/convex/ai_docs_temp.ts`) and hydrate rooms from Convex when joining, ensuring recovery and consistency if Yjs state is unavailable. Webhooks/mutations upsert snapshots so new clients can catch up quickly.

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

# Use Playwright / browser tools

Do not use Playwright or any browser automation tools unless the user explicitly requests it.
