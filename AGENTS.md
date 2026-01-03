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
    - [src/components/](packages/app/src/components) - React components (UI, assistant-ui, canvas)
    - [src/routes/](packages/app/src/routes) - TanStack Router route definitions
    - [src/lib/](packages/app/src/lib) - Shared utilities and helpers
    - [src/hooks/](packages/app/src/hooks) - Custom React hooks
    - [src/stores/](packages/app/src/stores) - State management (Zustand stores)
    - [src/types/](packages/app/src/types) - TypeScript type definitions
    - [src/app.css](packages/app/src/app.css) - Main CSS file with Tailwind 4 configuration
  - [convex/](packages/app/convex) - Convex backend code and functions
  - [shared/](packages/app/shared) - Shared code between frontend and backend
  - [vendor/assistant-ui/](packages/app/vendor/assistant-ui) - Assistant UI submodule (full repo for reference)
  - [vendor/liveblocks/](packages/app/vendor/liveblocks) - Liveblocks submodule (full repo for reference)
  - [vendor/ai/](packages/app/vendor/ai) - AI SDK submodule (full repo for reference)
  - [vendor/opencode/](packages/app/vendor/opencode) - OpenCode development platform submodule (full repo for reference)
  - [vendor/novel/](packages/app/vendor/novel) - Novel rich text editor submodule (full repo for reference)

- [+personal/](+personal) - DOCUMENTATION & RESEARCH FOLDER
  - [+personal/+ai/](+personal/+ai) - Only writable subfolder for AI-generated content
  - [+personal/sources/](+personal/sources) - Local research sources, contains 3rd party codebases and documentation for research purposes
  - [+personal/sources/README.md](+personal/sources/README.md) - Master list of local research sources, read this if you need to read inside the [+personal/sources/](+personal/sources) folder to have an idea of what the packages are
  - DO NOT MODIFY other files in +personal/ - they are reference material only

## Submodules (Special Import Handling)

- [packages/app/vendor/assistant-ui/](packages/app/vendor/assistant-ui) - Assistant UI submodule with custom overrides

  - Importing: Import directly from the submodule (NOT from node_modules)
    - Correct:
      ```ts
      import { useAssistantTool } from "@/vendor/assistant-ui/packages/react/src/runtime";
      import { ThreadWelcome } from "@/vendor/assistant-ui/packages/react/src/ui/thread-welcome";
      ```
  - Documentation folders:
    - [apps/docs/](packages/app/vendor/assistant-ui/apps/docs)
  - Examples folders:
    - [examples/](packages/app/vendor/assistant-ui/examples)

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

- [packages/app/vendor/ai/](packages/app/vendor/ai) - AI SDK repository

  - Importing: Use standard node_modules imports in the app, submodule is for reference
  - Documentation folders:
    - [content/docs/](packages/app/vendor/ai/content/docs)
    - [content/providers/](packages/app/vendor/ai/content/providers)
  - Examples folders:
    - [examples/](packages/app/vendor/ai/examples)

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
- Submodules - [packages/app/vendor/assistant-ui/](packages/app/vendor/assistant-ui), [packages/app/vendor/liveblocks/](packages/app/vendor/liveblocks), [packages/app/vendor/ai/](packages/app/vendor/ai), [packages/app/vendor/opencode/](packages/app/vendor/opencode), and [packages/app/vendor/novel/](packages/app/vendor/novel) have full repos for reference
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

### Assistant UI Imports

When importing assistant-ui components or utilities, ALWAYS import directly from the submodule:

```ts
// ✅ CORRECT - Import from submodule
import { useAssistantTool } from "@/vendor/assistant-ui/packages/react/src/runtime";
import { ThreadWelcome } from "@/vendor/assistant-ui/packages/react/src/ui/thread-welcome";

// ❌ WRONG - Do not import from node_modules
import { useAssistantTool } from "@assistant-ui/react";
```

### Standard Library Imports

For other libraries like Liveblocks, use standard node_modules imports:

```ts
// ✅ CORRECT - Standard import
import { LiveblocksProvider } from "@liveblocks/react";
```

# Code guidelines and patterns

You must not use `any` to bypass typescript errors unless the user is asking for it.

Use tab indentation for `.ts`, `.tsx` and `.css` files.

## Object.assign instead of spread operator

When conditionally assigning properties to an object, use `Object.assign` instead of the spread operator to keep a cleaner syntax.

Check values for non undefined-ness to avoid appending undefined properties to the object.

✅ Correct Pattern

```ts
Object.assign(
	{
		updated_by: updated_by,
		updated_at: Date.now(),
	},
	args.title !== undefined ? { title: args.title } : null,
	args.is_archived !== undefined ? { archived: args.is_archived } : null,
);
```

❌ Problematic Pattern

```ts
Object.assign(
	{
		updated_by: updated_by,
		updated_at: Date.now(),
	},
	{
		title: args.title, // Could be undefined
		archived: args.is_archived, // Could be undefined
	},
);
```

## Casing

Use snake_case only for symbols defined at the root of a module (except components and hooks). Everything else uses camelCase.

### Root Level Module Symbols (snake_case)

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

## No Barrel Exports

- Do not create index.\* barrel files (index.ts, index.tsx, index.js).
- Always import from concrete files and export from the component file directly.
- Example: import from "./components/ui/button.tsx" or export from "./button.tsx"; do not add a directory-level index.
- Barrel files are bad for intellisense and code completion.

# Application Architecture

This app is an AI chatbot that allows users to chat with AI, call tools, and produce documents in a canvas panel.

## Backend Architecture

The backend uses Convex as the primary backend platform, located in [packages/app/convex/](packages/app/convex):

- [ai_chat.ts](packages/app/convex/ai_chat.ts) - Main AI chat functionality with streaming, tool calling, and artifact creation
- [schema.ts](packages/app/convex/schema.ts) - Database schema for threads and messages
- [auth.ts](packages/app/convex/auth.ts) - Authentication with Clerk integration
- [http.ts](packages/app/convex/http.ts) - HTTP routing for API endpoints

The Convex backend handles:

- AI chat streaming with OpenAI integration
- Thread and message management
- Tool calling (weather, artifact creation)
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
  - [canvas/](packages/app/src/components/canvas) - Canvas/artifact editing components
  - [ui/](packages/app/src/components/ui) - Shared UI components

## Key Technologies

- Convex - Real-time backend, HTTP actions, persistence
- Clerk - Authentication
- Assistant UI (submodule) - Chat/runtime UI
- Liveblocks + Yjs - Real-time collaborative editing
- BlockNote - Rich text/Markdown editor
- Monaco Editor - Code and Diff editor
- TanStack Router - File-based routing
- Zustand - State management
- Tailwind 4 + shadcn/ui - Styling and components
- React 19 - Frontend framework
- React Complex Tree - Docs/file explorer
- Vite - Dev/build tool
- Playwright - UI verification
- AI SDK + OpenAI - AI integration and streaming

## Application Structure

The app runs at http://localhost:5173/ during development.

- Chat: The center panel uses Assistant UI runtime to send messages to Convex HTTP actions (`packages/app/convex/http.ts`, `packages/app/convex/ai_chat.ts`). Responses stream token-by-token and may call tools. Tool calls can create or update artifacts which appear in the right-hand canvas.
- Agent file access: Server-side tools in `packages/app/server/server-ai-tools.ts` let the agent read, write, and diff files in the workspace (search, edits, filesystem ops). These run in Node, not the browser, and are invoked through tool calls from the chat flow.
- Docs: The docs experience combines a file/tree explorer and an editor surface. Content supports rich text Markdown via BlockNote and code/diff via Monaco Diff Editor. The canvas can switch between these modes depending on the artifact type.
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

# Use Playwright

When performing frontend changes, you can use Playwright tools to verify your changes and ensure the UI meets the user's requirements.

Verification Workflow

1. Take snapshots to understand the current page structure and navigate it properly
2. Capture screenshots to verify if the UI changes match the user's requests
