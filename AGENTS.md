# Terminal and Tooling Constraints

- Package manager: this repository uses `pnpm`; do not use `npm`.
- VERY IMPORTANT Node runtime rule: run every command that executes Node.js through Vite Plus so commands use the repo-pinned Node version from `.node-version` instead of Cursor's bundled Node. Do not run bare `node`, `pnpm`, `pnpx`, `tsx`, `vite`, `vitest`, `convex`, or package scripts directly from the Cursor shell.
- Use `vp env exec ...` for Node-backed commands. Examples: `vp env exec node -v`, `vp env exec pnpm --dir packages/app run test:once`, `vp env exec pnpm --dir packages/app exec vitest run --project src path/to/test.ts`, `vp env exec pnpx wrangler ...`.
- Dev server: do not run `pnpm run dev`; let the user run it manually.
- Full app lint: run `vp env exec pnpm --dir packages/app run lint`. The root package does not have a `lint` script, and `pnpm --dir packages/app lint:tsc` is only the TypeScript check, not the full ESLint/React Compiler lint.
- Full app tests: run `vp env exec pnpm --dir packages/app run test:once` for a one-shot test run.
- Full app lint and test commands can take up to 20 minutes to complete. Use a long enough timeout when running them through tooling.

## Modal CLI

Use the Docker-wrapped Modal CLI script instead of installing Python or the Modal Python package on the Windows host:

```powershell
.\packages\app\scripts\modal-cli.ps1 <modal args>
```

The script builds and runs the `t3-chat-modal-cli:1.4.2` Docker image from [packages/app/modal/Dockerfile.cli](packages/app/modal/Dockerfile.cli), mounts the repo at `/workspace`, and stores Modal credentials outside the repo at `%USERPROFILE%\.modal-cli\.modal.toml`.

Examples:

```powershell
.\packages\app\scripts\modal-cli.ps1 token new
.\packages\app\scripts\modal-cli.ps1 secret create BONOBO_SENATE_PRESS BONOBO_SENATE_PRESS=replace-with-random-token
.\packages\app\scripts\modal-cli.ps1 deploy packages/app/modal/files_markitdown.py
```

Prefer non-interactive Modal CLI commands and flags when available so Codex does not block on prompts.

## Cloudflare / Wrangler CLI

Use Wrangler through Vite Plus + `pnpx` only. Do not install Wrangler globally, and do not use `npx wrangler`.

Examples:

```powershell
vp env exec pnpx wrangler login
vp env exec pnpx wrangler queues create bonobo-senate-press-r2-upload-events
vp env exec pnpx wrangler queues create bonobo-senate-press-r2-upload-events-dlq
vp env exec pnpx wrangler deploy --config packages/r2-upload-finalizer/wrangler.jsonc
vp env exec pnpx wrangler secret put EVENTS_SECRET --config packages/r2-upload-finalizer/wrangler.jsonc
vp env exec pnpx wrangler r2 bucket notification create bonobo-senate-press-files --event-type object-create --queue bonobo-senate-press-r2-upload-events --prefix "organizations/"
vp env exec pnpx wrangler r2 bucket notification list bonobo-senate-press-files
vp env exec pnpx wrangler tail bonobo-senate-r2-upload-finalizer
```

The R2 upload finalizer Worker is documented in [packages/r2-upload-finalizer/README.md](packages/r2-upload-finalizer/README.md).

# Application Architecture

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, follow the project Convex skill:

- **Skill:** [.agents/skills/convex/SKILL.md](.agents/skills/convex/SKILL.md) (base Convex usage)
- **Codebase-specific guidelines:** [.agents/skills/convex/references/additional-guidelines.md](.agents/skills/convex/references/additional-guidelines.md) (linked from the skill)

They override what you may have learned about Convex from training data.

## Backend Architecture

[packages/app/convex/](packages/app/convex):

- [ai_chat.ts](packages/app/convex/ai_chat.ts) - Main AI chat functionality with streaming and tool calling
- [schema.ts](packages/app/convex/schema.ts) - Application database schema
- [auth.config.ts](packages/app/convex/auth.config.ts) - Clerk and anonymous JWT authentication providers
- [users.ts](packages/app/convex/users.ts) - User lifecycle and anonymous authentication routes
- [http.ts](packages/app/convex/http.ts) - HTTP routing for API endpoints

The Convex backend handles:

- AI chat streaming with OpenAI integration
- Thread and message management
- Tool calling (file and shell tools, code execution, and web search)
- Authentication token generation
- CORS handling

## Backend current-user auth

Backend handlers that require a current app user should return or throw `Unauthenticated` when Convex auth has no usable identity or when the resolved id has no matching `users` doc. Keep detailed examples and exceptions in the auth system skill: [.agents/skills/auth-system/SKILL.md](.agents/skills/auth-system/SKILL.md).

For recoverable auth and permission failures, follow the Convex skill's handler-boundary rules: public queries usually throw only for missing current-user auth and otherwise return their nullable/empty shape, while actions and mutations should return a `_nay` Result.

## Runtime Boundaries

- Treat `packages/app/src/` modules as browser-only SPA code unless a file is explicitly designed otherwise.
- Do not add defensive `typeof document` / `typeof window` guards in frontend-only modules just to handle hypothetical SSR.
- Treat `packages/app/shared/` as the default isomorphic boundary; keep shared modules portable across browser and server runtimes.

## Key Technologies

- Convex - Real-time backend, HTTP actions, persistence
- Clerk - Authentication
- Yjs + vendored Liveblocks editor packages - Convex-backed collaborative editing
- Novel + Tiptap - Rich text/Markdown editor
- Monaco Editor - Code and Diff editor
- TanStack Router - File-based routing
- Zustand - State management
- CSS + shadcn/ui - Styling and components
- React 19 - Frontend framework
- Headless Tree - File explorer
- Vite - Dev/build tool
- Playwright - Test APIs
- Playwriter - Live browser QA
- AI SDK + OpenAI - AI integration and streaming

## Application Structure

The app runs at http://localhost:5173/ during development.

- Frontend shell: `packages/app/src/main.tsx` mounts the app-wide providers. `packages/app/src/routes/__root.tsx` waits for auth and billing bootstrap, renders the route outlet, and owns the shared Tiptap, Monaco, and app portal containers.
- Chat: The workspace chat route at `packages/app/src/routes/w/$organizationName/$workspaceName/chat/index.tsx` renders the UI from `packages/app/src/components/ai-chat/`. It sends messages to Convex HTTP actions (`packages/app/convex/http.ts`, `packages/app/convex/ai_chat.ts`). Responses stream token-by-token and may call tools. Tool calls and their outputs render inside the message UI.
- Agent file access: Server-side tools in `packages/app/server/server-ai-tools.ts` let the agent read files and propose file changes as pending updates. Users review those changes before saving them. The tools run in Node and are called from the chat flow.
- Files: The workspace files route at `packages/app/src/routes/w/$organizationName/$workspaceName/files/index.tsx` combines the file tree with editors under `packages/app/src/components/files/`. Novel/Tiptap handles rich text. Monaco handles plain text and diffs.
- Collaboration: Yjs collaboration and presence are backed by Convex. Vendored Liveblocks Yjs/Tiptap packages provide editor integration. Convex stores Yjs snapshots and incremental updates.

## Tiptap / Novel / Rich Text Editors

Treat Tiptap and Novel as source-level infrastructure that must follow the app's CSS layers.

- Mounted editors, including direct `useEditor(...)` / `new Editor(...)` calls and wrappers such as Novel's `EditorContent`, must use `injectCSS: false` unless the reviewed override below applies. Otherwise Tiptap adds `style[data-tiptap-style]`, which bypasses the app's CSS layer order.
- If a shared wrapper owns editor creation, make `injectCSS: false` its default so callers cannot accidentally use Tiptap's `true` default. Allow an override only when a caller explicitly needs Tiptap's runtime styles and its CSS-layer impact has been reviewed.
- For parsing or serialization editors that remain headless (`element: null`), CSS injection is not a styling concern because Tiptap injects its styles only while mounting a view. Keep `element: null` explicit, and apply the mounted-editor rule if the editor is mounted later.
- Keep editor base and state styles, including `.ProseMirror-selectednode`, decoration highlights, and placeholders, in `packages/app/src/app.css` or the component's paired CSS file.
- Check app-owned layered CSS before changing vendored editor code. Do not solve layer-order problems by increasing selector specificity.

# Project Structure and Key Directories

## Monorepo Structure

- [package.json](package.json) - Root package configuration
- [pnpm-workspace.yaml](pnpm-workspace.yaml) - Workspace configuration for the monorepo
- [pnpm-lock.yaml](pnpm-lock.yaml) - Lockfile for all dependencies

## Folder organization

- [packages/app/](packages/app) - MAIN APPLICATION ROOT

  - [src/](packages/app/src) - React frontend application code
    - [src/components/](packages/app/src/components) - React components organized by feature
    - [src/routes/](packages/app/src/routes) - TanStack Router route definitions
    - [src/lib/](packages/app/src/lib) - Shared utilities and helpers
    - [src/hooks/](packages/app/src/hooks) - Custom React hooks
    - [src/app.css](packages/app/src/app.css) - Main app CSS file
  - [convex/](packages/app/convex) - Convex backend code and functions
  - [shared/](packages/app/shared) - Shared code between frontend and backend
  - [vendor/](packages/app/vendor) - Vendored source dependencies listed in `pnpm-workspace.yaml`

- [references-submodules/](references-submodules) - Read-only repositories for docs, examples, and source inspection

- [../t3-chat-+personal/](../t3-chat-+personal) - DOCUMENTATION & RESEARCH FOLDER
  - [../t3-chat-+personal/+ai/](../t3-chat-+personal/+ai) - Writable subfolder for AI-generated content and scratch artifacts. Write ALL throwaway output here — temp/runner scripts, ideation screenshots, eval output, scratch plans — grouped under a descriptive `<topic>-YYYY-MM-DD` subfolder.
  - Do not write scratch files to the repo or the OS temp directory. If the sandbox cannot write to the personal AI folder, request approval instead of silently using another location. Reusable browser-QA helpers or recipes belong in the Playwriter harness ([.agents/skills/app-playwriter-harness/](.agents/skills/app-playwriter-harness)).
  - [../t3-chat-+personal/sources/](../t3-chat-+personal/sources) - Read-only third-party code and docs. Read its [README](../t3-chat-+personal/sources/README.md) first. Modify it only when the user explicitly asks.
  - Do not modify any other path under `../t3-chat-+personal/` unless the user explicitly asks.

## Vendored and reference repositories

Use [.gitmodules](.gitmodules) and `git submodule status` to inspect registered submodules. Do not maintain a second exhaustive inventory here.

Use [references-submodules/README.md](references-submodules/README.md) as the maintained routing guide for registered research repositories. [.gitmodules](.gitmodules) remains the authoritative inventory and remote configuration. Update the routing guide when a repository is added or when its purpose or best starting path changes.

- Repositories under `packages/app/vendor/` are source dependencies only when `pnpm-workspace.yaml` lists their packages. Import their declared package entrypoints, not arbitrary source paths, unless an existing integration requires a source import.
- Repositories under `references-submodules/` are read-only research sources. Do not import them into app runtime code or add them to the workspace.
- `references-submodules/assistant-ui/` is research-only. The app does not use `@assistant-ui/*` packages at runtime.
- The app uses the published `file-selector` and `@atlaskit/pragmatic-drag-and-drop` packages. Their repositories under `references-submodules/` are source references only.

## Third-party documentation research

When users ask about 3rd party libraries or request implementations using external dependencies, conduct thorough documentation research for accurate responses.

Use sources in this order:

1. Read [../t3-chat-+personal/sources/README.md](../t3-chat-+personal/sources/README.md) before using the local source mirror.
2. Use the vendored or reference repository when it contains the relevant version and docs.
3. Use official web documentation when local material is missing or version-sensitive.

Inside each repository, read its README, documentation, and examples before inspecting implementation source. Use source code when the documented behavior remains unclear.

For version-sensitive work, compare the local source or submodule version with `pnpm-lock.yaml` or the installed package before relying on it. Read enough docs and examples to implement without guessing, and report any material uncertainty that remains.

## Task Start Documentation And Quality Check

At the start of every implementation, review, or investigation task, decide whether the task should also update durable project knowledge or verification surfaces. This is a required evaluation step, not a requirement to add churn to every diff.

Consider whether the work needs:

- Skill or README updates: update relevant `.agents/skills/**/SKILL.md`, skill references, `packages/**/README.md`, or playbooks when behavior, architecture, commands, workflows, integration details, or agent-facing guidance changes.
- New skills: create a focused skill when a new or newly important app area has repeatable workflows, business rules, tooling, or gotchas that future agents should load on demand. Prefer updating an existing skill when it already owns the domain.
- Tests: add or update the smallest focused unit test for changed business logic, serialization, validation, permissions, data transforms, or regression-prone edge cases when there is a natural public entrypoint. Use integration or browser coverage when the behavior only exists across modules or UI flows.
- Playwriter harness/docs: put broadly reusable browser primitives in `.agents/skills/app-playwriter-harness/`. Put route-specific workflows and selectors in `packages/app/playwriter-playbooks/` or a relevant harness reference.
- Accessibility: for UI work, check keyboard access, focus order and management, semantic controls, accessible names and descriptions, form labels and errors, contrast, zoom/responsive fit, target size, and reduced-motion expectations. Fix obvious regressions in the same pass.
- Observability and operations: update runbooks, log or metric expectations, environment variable docs, migration notes, or rollback guidance when deployment, background jobs, external services, or data repair workflows change.
- Security and privacy: document or test auth, authorization, secret handling, tenant isolation, user data exposure, and webhook or external-boundary behavior when those surfaces are touched.

In the final response, report the relevant docs and verification work. Mention a skipped category only when it was relevant to the task.

## System Spec Skills

Treat the core business-logic skill files under `.agents/skills/` as maintained system-spec documents for the product behavior they describe.

Current spec-style skills include:

- `.agents/skills/auth-system/SKILL.md`
- `.agents/skills/billing-system/SKILL.md`
- `.agents/skills/access-control/SKILL.md`
- `.agents/skills/organizations-tenancy/SKILL.md`
- `.agents/skills/quotas/SKILL.md`
- `.agents/skills/data-deletion/SKILL.md`
- `.agents/skills/ai-chat-agent/SKILL.md`
- `.agents/skills/files-agent-pending-updates/SKILL.md`

When product requirements or business logic change, update the relevant spec skills in the same pass as the implementation so those files stay accurate.

- Do not leave a skill file describing stale behavior after you change the code or the intended product rules.
- If a change affects multiple domains, update every relevant spec skill, not just the first file you touched.
- Treat these skill files as the maintained description of how the system is supposed to work, not as optional follow-up documentation.

## Configuration Files

- [packages/app/convex.json](packages/app/convex.json) - Convex configuration
- [packages/app/components.json](packages/app/components.json) - shadcn/ui component library configuration
- [packages/app/tsconfig.json](packages/app/tsconfig.json) - TypeScript configuration for the app
- [packages/app/index.html](packages/app/index.html) - HTML entry point for Vite
- [packages/app/vite.config.ts](packages/app/vite.config.ts) - Vite development server configuration

# Code guidelines and patterns

You must not use `any` to bypass TypeScript errors unless the user asks for it.

## Simplicity and necessity

Treat code as a liability and keep the implementation as direct as the problem allows.

- Use the least code that fully solves the real problem.
- Treat every new line, branch, helper, abstraction, normalization step, fallback, and defensive check as a cost that must be justified by a concrete need.
- Prefer direct code over flexible code, local code over abstract code, and obvious code over clever code.
- Avoid unnecessary indirection.
- Do not add wrapper functions, pass-through helpers, adapter layers, generic abstractions, and extracted modules when they only rename or forward data.
- Prefer inline local code over a helper when the helper does not remove real complexity, hide a necessary external-system detail, or enable meaningful reuse.
- When adding any abstraction, be ready to explain the concrete benefit in the current change.

## Clean-slate development

This product is not in production. Build the current design directly instead of preserving obsolete behavior.

- Do not add backward-compatibility branches, legacy parsers, dual reads or writes, optional old fields, version adapters, migration shims, or fallback routes unless the user explicitly requires continuity with deployed production data.
- When a breaking schema or contract change conflicts with disposable development data, prefer deleting that data and regenerating the current derived content over carrying compatibility code.
- For a development reset, load `dev-data-reset` and every supporting skill it requires. For plugin-only recovery, load `plugin-system`. Follow their readback gates rather than improvising deletion order.
- Never delete a `users` doc whose `clerkUserId` is non-null during a development reset. Use the data-only purge mode so the Clerk identity, profile, Polar customer/billing state, and default tenant remain attached to the same user doc. Anonymous or non-Clerk users may be fully deleted.
- Rebuild plugin registry data from the current source repositories and trusted deployment secrets. Never scrape, print, log, or copy provider tokens from browser pages; use existing deployment environment values, provider-supported credential issuance, or explicit user-provided values.

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

Prefer inferred return types for ordinary local functions.

Exceptions (add an explicit return type when it helps):

- An interface or framework contract requires it.
- It breaks a TypeScript inference cycle.
- A public boundary benefits from a stable return contract.
- Inference is unstable or too wide and an annotation prevents regressions.

## TypeScript exports: export only public API

Use `export` only when a symbol is intentionally part of the module's public API because another module imports it now or is expected to import it soon.

- Keep helpers, types, constants, and other implementation details module-private when they are only used inside the same file.
- Do not export symbols "just in case" or to make local file organization feel cleaner.
- When in doubt, start module-private and add `export` later once there is a real cross-module use.

## External data validation

Treat data from outside the application process as `unknown`. Runtime-validate every consumed field before use; a TypeScript cast is not validation.

- Prefer Zod for structured HTTP responses, third-party callbacks, reused schemas, and shapes with several fields.
- A small explicit local check is acceptable for a simple shape with one or two primitive fields.
- Validate that every field the application uses is present and has the expected runtime type.
- For verified vendor webhooks in Convex, keep the boundary validator loose as described in the Convex skill. Then validate every consumed field with Zod or a focused local check.
- Prefer `safeParse` when malformed input is a recoverable error.

## Convex function argument types

When a helper needs a Convex args object type, keep the type surface as small and local as the code needs.

- Prefer an inline object type when the helper only consumes a small body shape or a one-off subset.
- If a helper intentionally mirrors a generated registered function's full args shape (`api.foo.bar` or `internal.foo.bar`), use `FunctionArgs<typeof internal.foo.bar>`.
- If you need the result type from a same-file registered mutation, infer its awaited return type from `RegisteredMutation` instead of reaching into `_handler`.
- For same-file Convex calls that would otherwise trigger generated API circularity, keep the generated reference direct and cast only the awaited result. Follow the current pattern in `packages/app/convex/files_nodes.ts`.
- Do not use implementation details such as `_handler`, do not extract a separate validator just to get a type, and do not create a named args type unless a production API genuinely needs it.

Current same-file result pattern:

```ts
import type { RegisteredMutation } from "convex/server";

type finalize_file_content_materialization_Result =
	typeof finalize_file_content_materialization extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

const finalizationResult = (await ctx.runMutation(
	internal.files_nodes.finalize_file_content_materialization,
	{
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		userId: args.userId,
		sequence,
		targetSequence: args.targetSequence,
		markdown: reconstructed._yay.markdown,
		versionSnapshotAssetId,
		markdownSize: files_get_utf8_byte_size(reconstructed._yay.markdown),
		yjsSnapshotSize: reconstructed._yay.snapshotUpdate.byteLength,
	},
)) as finalize_file_content_materialization_Result;
```

## Test organization

Follow the existing test file's layout. When adding a new related group or reorganizing a section, use `describe("<function_name>")` blocks. Do not rewrap unrelated existing tests.

- Use one `describe(...)` per primary function or behavior under test.
- Keep individual `test(...)` names specific, but avoid repeating grouping that already belongs in the enclosing `describe(...)`.
- Follow nearby test names and grouping before introducing a different layout.
- Do not make regular runtime tests depend on Convex migration functions or `packages/app/convex/migrations.ts` entrypoints.
- If you need to verify a migration, add a focused migration-specific test for that migration instead of routing normal feature tests through migration APIs.

## Test design

Avoid test-induced design damage. Do not reshape production code primarily to satisfy a testing style when that reshape makes the code less natural, more fragmented, or expands the module's public surface without a real product need.

- Do not extract a helper, create a new module, add dependency injection, or export a symbol only so a test can reach it in isolation.
- Let production design drive the test strategy. If a few lines of logic belong inline inside a single function or module, keep them there unless extracting them improves the production code on its own merits.
- Prefer testing through the public entrypoint or observable behavior of the owning module/component instead of reaching into implementation details.
- Use focused unit tests when the logic is already naturally separable, stable, and meaningfully reusable. Do not force separability just because a testing pattern prefers it.
- When isolated unit coverage would require unnatural seams, prefer a broader integration-style test that exercises the real code path.
- Treat exports as public API, not as test hooks. Keep implementation details private unless another production module genuinely needs them.
- Extract or modularize only when it improves readability, reuse, ownership boundaries, or domain clarity in the production code even if no test existed.

## In-source tests

When adding or editing an in-source test, use this guard:

```ts
if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, expect, test } = import.meta.vitest;
	// tests...
}
```

- The `process.env.NODE_ENV === "test"` check must come first. Vite statically replaces `process.env.NODE_ENV`, so production builds strip the whole block. Checking only `import.meta.vitest` is not enough: the test code would ship as dead weight in frontend bundles, and in `convex/` and `server/` code esbuild must erase the block before Convex analyzes the bundle.
- `includeSource` in [packages/app/vitest.config.ts](packages/app/vitest.config.ts) controls which files are scanned for in-source tests: `src/**`, `convex/**`, and `server/bash.ts`.

Use tab indentation for `.ts`, `.tsx` and `.css` files.

## Comments that explain code

Many AI models under-comment by default; in this repo, lean the other way. Leave a short comment whenever the next reader will ask "why this?" and the answer is not visible in the surrounding code. Aim for comments that describe intent, not syntax.

Write a comment when the code:

- Encodes a **product/business rule** not obvious from names (precedence, ordering, lifecycle, plan/role gating, quotas, tenancy).
- Has a **non-obvious "why"** — a trade-off, a deliberate choice over the obvious alternative, or a constraint from an external system (Convex, Clerk, Polar, Liveblocks, Yjs, browser).
- Relies on a **cross-module/cross-runtime contract** not visible locally (producer/consumer invariant, SSR/browser boundary, Convex action contract).
- Has a **framework gotcha** (React Compiler memoization, `try/catch/finally` lowering, Tiptap CSS injection, Yjs lifecycles, race/idempotency ordering).
- Is a **migration shim or two-phase rollout** that should be removed later — say so.
- Has **business-rule branches** in a long function — add short branch-boundary comments instead of narrating every line.
- Intentionally **skips an obvious defensive check** because of a trusted invariant (see "Trust application invariants").

Skip comments that restate the code, narrate trivial flow, or document self-evident functions.

Place comments for control-flow branches and loops immediately before the `if`, `else if`, `else`, `for`, or `while` block they explain, rather than as the first line inside the block, so the comment remains visible when the block is collapsed in the IDE.

Preserve and update existing product-requirement comments when refactoring; a stale comment is worse than none.

Use imperative second-person voice ("Keep...", "Use...", "Guard...") rather than descriptive narration ("Keeps...", "Uses...", "Guards..."). Skip this for doc-style prose where it would be unnatural.

```ts
// ✅ Good
// Keep one cleanup task per file and replace the older scheduled run whenever the file changes.

// ❌ Bad
// Keeps one cleanup task per file and replaces the older scheduled run whenever the file changes.
```

### Comment wording: plain language

Write comments and JSDoc for a reader who is not an eloquent native English speaker and does not have the whole module context in mind. Keep commenting the "why" (see above), but say it in plain language.

- Use short sentences with a plain subject-verb-object shape. Split a multi-fact sentence into separate sentences instead of chaining facts with semicolons, colons, or em-dashes.
- Use simple everyday words: "delete" over "reclaim"/"drain"/"sweep", "files" over "objects", "never happened" over "was lost" — unless the technical term is the precise domain term the code also uses.
- Name the actor and the action instead of a compressed noun phrase: "the publish records the keys it is about to write", not "durably record the exact keys".
- Spell out cause and effect as a small story: "If X crashes between A and B, Y would happen. So we do Z." The reader should not have to reconstruct the failure scenario from one packed clause.
- Do not invent shorthand or metaphors ("crash-shaped exit", "yanked out from under", "the overflow rides the continuation").
- Do not assume the reader knows what a referenced mechanism does; give one short clause of context ("the cron fallback picks this attempt up again after the deadline").
- Plain does not mean longer. Keep comments concise by dropping asides that are already explained at the site where they matter, not by compressing sentences.

```ts
// ✅ Good
// If the publish crashes between the uploads below and registration, the uploaded files must
// not stay in the bucket forever. So before the first upload, one mutation records the exact
// keys and schedules their cleanup.

// ❌ Bad
// A crash between the uploads below and registration must not orphan bucket objects: durably
// record the exact keys and schedule their cleanup in one mutation before the first put.
```

### JSDoc layout

Use multi-line JSDoc by default, even when the text is one sentence. The extra space makes the documented symbol easier to find and review.

```ts
/**
 * Explain the symbol in plain language.
 */
```

Use a single-line JSDoc only when it is a very short label and the compact form makes a tight group of small symbols easier to scan. Do not use a single line for a reason, lifecycle, constraint, warning, or any text that may wrap. When unsure, use the multi-line form.

### Vertical spacing and code chunks

Use one empty line between different logical chunks of code. Examples of chunks are configuration, validation, reads, calculations, writes, and the final result.

Keep statements together when they complete one small step. For example, keep an environment-variable guard with the constant it validates. Do not add an empty line after every statement.

Before finishing an edit, read each changed area with its nearby code. Check that empty lines make the steps easy to see and that no dense block hides a change of purpose. A formatter cannot make this judgment for you.

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

Use `Result` from `packages/common/src/errors-as-values-utils.ts` for recoverable errors.

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

Internal and server-only Results may keep diagnostic `cause` values. At a public Convex boundary, `_nay` must match the function's `returns` validator. With `v_result(...)`, do not return an arbitrary `cause`; put API-safe cause details in validated `_nay.data`. A custom validator may expose a validated API-safe `cause` shape when the public contract needs it. Keep server-only details in logs or internal Results.

Handle both branches. Bubble `_nay` at the same abstraction layer when possible. If the boundary cannot bubble it, show a documented user-facing message or log it with context. Never ignore it.

```ts
const result = await doStep();
if (result._nay) return result;

const value = result._yay;
```

### Full-run concurrent Result aggregation (`Result_all` + `Promise.all`)

Use `Result_all(await Promise.all(...))` when expected failures are fulfilled `Result` values and all concurrent tasks may finish before their results are combined. An `_nay` value does not end `Promise.all` early or cancel other tasks. If a task rejects unexpectedly, `Promise.all` rejects early, but the other started tasks keep running. Do not add a shared `nayResult` variable inside concurrent tasks and call it fail-fast; all tasks have already started, and the guard neither ends `Promise.all` early nor cancels work.

```ts
const results = Result_all(
	await Promise.all(
		items.map(async (item) => {
			const value = await findItem(item);
			if (value === null) {
				return Result({ _nay: { name: "nay", message: "Item not found" } });
			}

			return Result({ _yay: value });
		}),
	),
);

if (results._nay) return results;

const values = results._yay;
```

### Throwing at exception boundaries

Outside Convex, when a boundary must throw, use a stable operation message and pass `_nay` as `cause`. In Convex code, follow the `convex_error` rules in the Convex skill.

Do not throw raw `_nay.message` merely to preserve diagnostic details. Throw it directly only when the producer defines it as API-safe and user-facing, and the receiving interface intentionally uses `Error.message` as its public command or adapter contract.

```ts
if (result._nay) {
	throw new Error("Failed to create file", {
		cause: result._nay,
	});
}
```

### Message and log string format

Keep expected domain/API messages such as `Unauthenticated`, `Unauthorized`, `Not found`, and `Permission denied` stable. Use `Failed to ...` or `Error while ...` for operation-wrapper messages. Do not put `[OwnerSymbol.operation]` in `_nay.message` or thrown error messages. Put volatile details in `cause` or structured metadata.

Prefix non-Convex log messages with `[OwnerSymbol.operation]`. Convex already adds function/runtime context, so do not add owner tags there. Keep log text stable, put errors and ids in structured metadata, and do not use `.catch(console.error)`.

### Promise error-handling style

In UI promise handlers, handle expected `_nay` values with user feedback or contextual logging, then return. Reserve `.catch(...)` for unexpected rejections:

```ts
someAsyncOperation()
	.then((result) => {
		if (result._nay) {
			console.error("[OwnerSymbol.operation] Failed to perform operation", {
				error: result._nay,
				...context,
			});
			return;
		}

		// success path
	})
	.catch((error: unknown) => {
		console.error("[OwnerSymbol.operation] Unexpected async error", {
			error,
			...context,
		});
	});
```

Show `_nay.message` only when the producing boundary defines it as user-facing or API-safe; otherwise show a stable fallback and keep details in contextual logs.

## Consistency requirement (same-author rule)

Match the local file and nearby modules. Changes should look like the same person wrote the surrounding code. Use the conventions below only when local code does not already decide the style. Do not introduce a new pattern unless the user requests it or correctness requires it.

### Owner colocation

Keep each component's `*_ClassNames`, `*_Ref` when present, `*_Props`, component, and paired selectors together. Keep sibling and extracted component contracts with their exact owner; do not centralize several owners in a shared types or CSS-contract block.

When extracting or renaming an owner, rename its `*_ClassNames`, `*_Ref`, `*_Props`, region label, and paired selectors together.

Example when the file already uses regions:

```tsx
// #region item selected
type FooItemSelected_ClassNames =
	| "FooItemSelected"
	| "FooItemSelected-label"
	| "FooItemSelected-description";

type FooItemSelected_Props = {
	label: string;
	description: string;
};

const FooItemSelected = memo(function FooItemSelected(props: FooItemSelected_Props) {
	const { label, description } = props;

	return (
		<div className={cn("FooItemSelected" satisfies FooItemSelected_ClassNames)}>
			<span className={cn("FooItemSelected-label" satisfies FooItemSelected_ClassNames)}>{label}</span>
			<span className={cn("FooItemSelected-description" satisfies FooItemSelected_ClassNames)}>
				{description}
			</span>
		</div>
	);
});
// #endregion item selected

// #region item selectable
type FooItemSelectable_ClassNames =
	| "FooItemSelectable"
	| "FooItemSelectable-label"
	| "FooItemSelectable-description";

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
		>
			<span className={cn("FooItemSelectable-label" satisfies FooItemSelectable_ClassNames)}>{label}</span>
			<span className={cn("FooItemSelectable-description" satisfies FooItemSelectable_ClassNames)}>
				{description}
			</span>
		</button>
	);
});
// #endregion item selectable

// #region item
type FooItem_Props = {
	item: {
		label: string;
		description: string;
		isCurrent: boolean;
		onSelect: () => void;
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
@layer components {
	/* #region item selected */
	.FooItemSelected {
		display: grid;
		gap: 4px;
	}

	.FooItemSelected-label {
		font-weight: 600;
	}

	.FooItemSelected-description {
		opacity: 0.8;
	}
	/* #endregion item selected */

	/* #region item selectable */
	.FooItemSelectable {
		display: grid;
		gap: 4px;
	}

	.FooItemSelectable-label {
		font-weight: 600;
	}

	.FooItemSelectable-description {
		opacity: 0.8;
	}
	/* #endregion item selectable */
}
```

`FooItem` owns no DOM node, so it has no `FooItem_ClassNames` or paired CSS selectors.

### Region organization

Use regions only when the user requests them or the file already uses them.

- Preserve existing region markers, casing, and ordering. Put new code in the nearest relevant region. Leave existing nested regions unchanged unless the task reorganizes them, but do not create a nested region. Do not duplicate labels. When local style does not decide, use a concise lowercase label.
- Keep each component owner's `*_ClassNames`, `*_Ref` when present, `*_Props`, component, and paired CSS selectors together. Do not create catch-all helpers, types, constants, or components regions; keep supporting code with the nearest concrete owner.
- Matching TSX and CSS sections must use the same label. A label does not need to exist in both files when there is no corresponding code or CSS.
- Use plain comments for small groupings inside a component instead of adding regions.

### Effect placement inside components

When local style does not already decide placement, keep `useEffect` hooks below local functions/handlers and above the JSX return.

- Prefer ordering as: state/derived values -> local functions/handlers -> `useEffect` hooks -> `return (...)`.
- Avoid scattering `useEffect` between unrelated declarations unless the user explicitly requests that layout.

## React Compiler: avoid try/catch/finally blocks

In code compiled as a React component or hook, the React Compiler can have issues lowering `try { ... } catch { ... } finally { ... }`, especially with `finally`. Prefer the existing pattern:

- Use an `async (/* iife */) => { ... }` IIFE when async component or hook logic needs chained error handling or cleanup.
- Do not add `void` automatically to an unawaited Promise. If local style uses `void` to mark a deliberately discarded Promise value, use it only for that purpose. Never use it when returning, awaiting, or yielding the Promise. `void` does not handle rejection or change Promise execution.
- Handle errors with `.catch(...)` and cleanup or state resets with `.finally(...)`.

## Casing

Match the file's established names first. Use these defaults only when local code does not decide:

- Root-level value symbols use `snake_case`. File constants may use `SCREAMING_SNAKE_CASE` when nearby constants do. React context objects use PascalCase.
- Public values may add a short `snake_case` namespace when it improves import-site clarity, for example `ai_chat_MODEL_IDS` or `files_parse_markdown_to_html`. Do not repeat the feature path in private names.
- Classes, interfaces, type aliases, and enums use PascalCase for the type-like part. A public type may add a `snake_case` namespace, for example `ai_chat_ModelId`.
- Declarations owned by one component, hook, class, or utility may use `OwnerSymbol_Descriptor`, for example `FileEditorDiff_Props` or `useAutoScroll_Props`. Use this only when the owner link helps.
- Keep the owner itself as one PascalCase or hook name. Put `_Descriptor` after the complete owner: `FileEditorDiffInner` and `FileEditorDiffInner_Props`, not `FileEditorDiff_Inner`.
- React components and React context objects use PascalCase. Hooks use `useXxx`; the first character after `use` must be uppercase for React tooling.
- Function-local names should match nearby code. Use camelCase when there is no local pattern.
- Preserve established external API names such as `randomUUID` and browser methods.

```ts
const cache_by_storage_key = new Map<string, unknown>();
type OpenTabRecord = { id: string; title: string };

export const ai_chat_MODEL_IDS = ["gpt-5.4-nano", "gpt-5.4-mini"] as const;
export type ai_chat_ModelId = (typeof ai_chat_MODEL_IDS)[number];

type FileEditorDiff_Props = { fileId: string };
type useAutoScroll_Props = { enabled: boolean };
function useAutoScroll(props: useAutoScroll_Props) {
	return props.enabled;
}

function example() {
	const processedResult = processData();
	const handleSelect = () => processedResult;
	return handleSelect();
}
```

## IIFE

Mark new IIFEs with an `/* iife */` comment so readers can spot them.

```ts
const next_id = ((/* iife */) => {
	let currentId = 0;

	return function next_id() {
		currentId += 1;
		return currentId;
	};
})();
```

## Lazy singletons

Use an IIFE that returns a getter when a singleton must be created only on first use.

The IIFE can return a named function with the same name as the assigned symbol to improve the debugging experience.

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

### Parameterized functions with memoization

For functions that take parameters and you want to memoize results based on those parameters, use a `Map` to cache results keyed by the input parameters.

The pattern follows the same structure as lazy singletons, but uses a `Map` for caching multiple results:

```ts
type DocumentKind = "markdown" | "plain-text";

const get_document_parser = ((/* iife */) => {
	function value(kind: DocumentKind) {
		return create_document_parser(kind);
	}

	const cache = new Map<Parameters<typeof value>[0], ReturnType<typeof value>>();

	return function get_document_parser(kind: DocumentKind) {
		if (cache.has(kind)) {
			return cache.get(kind)!;
		}

		const result = value(kind);
		cache.set(kind, result);
		return result;
	};
})();
```

**Key points:**

- The `value` function accepts the same parameters as the returned function
- For new memoization caches, prefer naturally bounded keys or add cleanup/eviction. Do not copy an existing unbounded cache without checking its input lifetime and growth. A literal union is an ideal bounded key. For multiple primitive inputs, use nested maps or a stable serialized key. Object and tuple keys compare by reference, so use them only when callers reuse the same object identity.
- Cache type uses `ReturnType<typeof value>` for type safety
- Check cache membership, not value truthiness, so cached falsy values still work

## Zustand stores

This repo uses Zustand for client-side state.

When you create or update a Zustand store, match the nearest existing store:

- Complex stores may use an IIFE to keep the raw store private and attach actions with `Object.assign(store, { actions: { ... } })`.
- Tiny stores may export `create(...)` directly and use `useXxx.setState(...)` at call sites.
- A store IIFE runs immediately. Do not describe it as lazy unless it returns a getter that creates the value on first use.

Before implementing a new store, read these examples and match their local style:

- [packages/app/src/lib/app-global-store.ts](packages/app/src/lib/app-global-store.ts) for a tiny direct store
- [packages/app/src/hooks/ai-chat-controller.tsx](packages/app/src/hooks/ai-chat-controller.tsx) for an IIFE store with attached actions

```ts
// Tiny store
export const usePanelStore = create(() => ({ isOpen: false }));
usePanelStore.setState({ isOpen: true });

// Store with an owned action API
export const useSelectionStore = ((/* iife */) => {
	const store = create<{ selectedId: string | null }>(() => ({ selectedId: null }));

	return Object.assign(store, {
		actions: {
			clear() {
				store.setState({ selectedId: null });
			},
		},
	});
})();
```

## No index barrels

- Do not create app-owned `index.ts`, `index.tsx`, or `index.js` files whose purpose is re-exporting other modules.
- Always import from concrete files and export from the component file directly.
- Prefer named exports. Do not add `export default` unless a framework, runtime API, or build tool strictly requires it.
- Treat default exports as banned by default. If you use one for a technical reason, keep the reason explicit and local to that integration point.
- TanStack Router may require route files named `index.tsx`; these are route modules, not barrels. Keep their required named `Route` export instead of adding a default export.
- Example: import from "./components/ui/button.tsx" or export from "./button.tsx"; do not add a directory-level index.
- Existing runtime-boundary bridge modules are allowed when they expose a deliberate cross-runtime API.

# React components

## React Compiler

Vite runs the React Compiler over app source. The compiler may reuse values and functions when their inputs are unchanged. Keep render logic pure and idempotent; do not rely on a value being recomputed or on its identity changing on every render.

### Memoization

- Do not add `useMemo` or `useCallback` only to reduce recomputation or stabilize identities.
- Add them only for a concrete semantic contract, such as a non-React API that stores an identity. Leave a short comment explaining the contract.
- Do not read or mutate `ref.current` during ordinary component render. Keep audited infrastructure exceptions such as `useLiveRef` local; do not copy that pattern into feature components. Use state when a change must rerender. Use module-level keyed storage only for non-reactive values with complete scope keys and a clear cleanup policy.

### Component declaration style

For new or edited app-owned components, use a memoized named function expression. Export the component only when it is part of the module's public API:

```tsx
export const MyComponent = memo(function MyComponent(props: MyComponent_Props) {
	const { className, ...rest } = props;
	return <div className={className} {...rest} />;
});
```

Use `const` instead of `export const` for a module-private component. Propsless components omit the parameter. Components with attached static exports use the `Object.assign(memo(function Component(...) { ... }), { ... })` pattern described below. Preserve framework, vendor, or established local component patterns when they require another shape.

### Effects

This repo disables `react-hooks/exhaustive-deps` and enables the React Compiler's `automatic-effect-dependencies` rule. That is not permission to accept stale closures:

- Make every effect react to each semantic value it reads. Do not omit a value only to suppress reruns.
- Evaluate dependencies with React Compiler semantics. Prefer the derived semantic value the effect reads over adding all of that value's upstream inputs.
- Do not add object or function identity dependencies only as stability guards. Add one when a concrete external API stores or compares that identity.
- Do not use an effect to keep derived state in sync. Compute derived values during render.
- Use effects for real external work: subscriptions, timers, imperative DOM APIs, and bridges to non-React code.
- Question every new `useEffect`, `useMemo`, and `useCallback` during review.

### Error boundaries

Prefer TanStack Router's `CatchBoundary` for app UI subtrees. Follow `packages/app/src/components/ai-chat/ai-chat.tsx`: provide `errorComponent`, `onCatch`, and `getResetKey`, and keep the fallback local to the feature.

Make `getResetKey` change when the subtree's owning identity changes, such as the selected thread or branch anchor, so the boundary can recover for the new subtree.

## Event-driven, centralized UI logic

- Update state from explicit user or system events instead of sync effects.
- Keep data fetching, mutations, and integration work in a stable route, container, or controller owner. Keep leaf components mostly presentational.
- Prefer `useConvex()` for one-off imperative writes. Match an existing `useMutation` or `useAction` pattern when a stable hook result belongs to the component or controller lifecycle.
- Pass children the data and callbacks they need. Do not pass query arguments or recreate owner contexts in leaves.
- Reset local state with a key/remount or an explicit initial value instead of a store-to-leaf sync effect.

## Props pattern

- Accept one `props` parameter and destructure it on the first line. Do not destructure in the signature.
- Omit the parameter and props type for a propsless component.
- Match the local style. Prefer arrow functions for new local helpers and handlers.
- Do not use `React.FC` or anonymous top-level component functions.
- Match the owner's existing prop order. For a new API with no local pattern, prefer `ref`, `id`, `className`, `style`, other data, callbacks, named slots, and `children` last. Keep `...rest` last.
- Use `on*` for event notifications. Use imperative names such as `set*` or `create*` when a callback represents a command. Render functions and getters may use `render*` or `get*` names.
- Prefer structured data and callback props for feature-local components. Use broad `ReactNode` slots only when caller-controlled composition is the goal.

### Strict props by default

Props are required unless omission is part of the intended behavior. Do not add optional props or silent defaults for convenience, compatibility, or speculative use.

Model intended absence explicitly with `T | null` or a discriminated union. Low-level reusable primitives may use optional props when they have clear defaults and a small stable API.

## Component styles

### Class contracts and ownership

- Give each rendered component one `<ComponentName>_ClassNames` union for every class string it owns.
- Include a root class equal to the component name. Slot and modifier suffixes use kebab-case, for example `MyButton-icon-wrap` and `MyButton-variant-default`.
- Validate component-owned class literals at the use site with `satisfies ComponentName_ClassNames`.
- Keep each owner's declarations in this order: `*_ClassNames`, `*_Ref` when present, `*_Props`, then the component.
- A chooser and each rendered variant are separate owners. A chooser with no DOM node may omit `*_ClassNames`.
- When extracting JSX, rename the classes and matching selectors to the new owner in the same change.
- Use another owner's class only for intentional style reuse or cross-component targeting. For style reuse, apply both the local identity class and the reused class and validate both contracts.
- When reusing another owner's class contract, confirm that owner's CSS is loaded. If it is not, make that dependency explicit or move the shared rules to a shared stylesheet.

### TSX and CSS pairing

A component module that uses vanilla CSS owns a paired file with the same base name and imports it directly. When extracting a component to a new module, move its selectors to the new paired CSS file.

- Do not import an unrelated component's CSS file to style a new component.
- Put intentionally shared/global styles in an explicit shared or global stylesheet.
- When paired TSX and CSS sections use regions for the same owner, use the same label. Do not add empty matching regions when one side has no content.
- Keep selectors with the component that owns the DOM. Do not leave extracted child selectors in the old root region.

### CSS layers and selectors

- Use `@layer components` for feature and route styles.
- Use `@layer common_components` for reusable `My*` primitives and other shared UI components.
- Keep one component's selectors together: base, owned slots, modifiers/states, then contextual overrides.
- Prefer modern nesting for owned pseudo-classes, slots, states, and modifiers. Flatten selectors for shared/global rules or intentional cross-component relationships.
- Keep specificity low. Do not fix layer problems by escalating selectors.

### CSS properties and units

- Group related properties with empty lines: box model, layout, spacing, typography, visuals, then transitions/animations.
- Prefer logical alignment keywords `start` and `end` over `flex-start` and `flex-end`.
- For new styles when local code does not decide, prefer `px` for component sizing and spacing and `rem` for typography. Avoid new `rem` or `em` sizing and spacing unless the local module or the user requires it.
- Add layout or paint containment only for a measured need and after checking clipping, portals, sticky elements, and subgrid behavior.

### Color and themes

The custom `--color-base-*`, `--color-fg-*`, `--color-accent-*`, `--color-green-*`, and `--color-red-*` scales are complete `oklch()` values in `packages/app/src/app.css`. Use them directly with `var(...)`; do not wrap them in `hsl()`.

The base and accent families also have `-alt-` scales. Check `packages/app/src/app.css` for exact names and ranges before choosing one.

The app theme provider supports `light`, `dark`, and `system` and applies a root `.light` or `.dark` class. For new or edited app-owned component theme behavior, use class-scoped overrides such as nested `.dark &`. Do not add `@media (prefers-color-scheme: dark)` because it ignores an explicit user theme. When touching an existing media-query override, migrate it when that rule is in scope.

The custom numbered palette is dark-oriented and is not swapped by the theme provider. Low `base-1` numbers are deeper surfaces; higher numbers are lighter/elevated surfaces. Foreground scales move from dim to bright. Check existing nearby use before adding a shade.

### Interaction states and child elements

- Use nested `:disabled`, `:focus-visible`, `:hover`, and `:active` states.
- Keep keyboard focus visible. Do not remove outlines without an equivalent focus affordance.
- Use low-specificity semantic child selectors. Prefer owned slot classes when the child has a stable role.
- Respect reduced-motion expectations for non-essential animation.

### Component CSS variables

Model component-owned custom properties with `<ComponentName>_CssVars`. Merge defaults before the caller's `style` so the caller can override them. Match the custom-property spelling already used by the component.

Prefer class variants over custom positioning. Add a CSS variable only when runtime values genuinely need to cross from TSX into CSS.

```tsx
type Progress_ClassNames = "Progress";

type Progress_CssVars = {
	"--Progress-value": number;
};

const Progress_CssVars_DEFAULTS: Progress_CssVars = {
	"--Progress-value": 0,
};

type Progress_Props = {
	style?: React.CSSProperties & Partial<Progress_CssVars>;
	value: number;
};

const Progress = memo(function Progress(props: Progress_Props) {
	const { style, value } = props;

	return (
		<div
			className={"Progress" satisfies Progress_ClassNames}
			style={sx({
				...Progress_CssVars_DEFAULTS,
				"--Progress-value": value,
				...style,
			} satisfies React.CSSProperties & Partial<Progress_CssVars>)}
		/>
	);
});
```

### `className` and `style` utilities

Use `cn` from `@/lib/utils.ts` to merge class names and `sx` for typed style objects. For one static class with no merge, use a plain string with `satisfies`; do not churn existing `cn("SingleClass")` calls only for this preference.

For app-owned vanilla-CSS modules, use component CSS instead of Tailwind utilities. Existing imported or generated Tailwind modules may keep their established style. The whitelist for new app-owned utility use is:

- `sr-only` for content that must remain available to screen readers.

Add another utility only for a clear cross-cutting accessibility or layout need that would not benefit from owned CSS.

## List rows with primary and secondary actions

For the current sidebar-row pattern, inspect both `packages/app/src/components/ai-chat/ai-chat-threads.tsx`/`ai-chat-threads.css` and the `MySidebarListItem*` primitives in `packages/app/src/components/my-sidebar.tsx`/`my-sidebar.css`. Feature CSS owns grid and subgrid placement. The shared primitives own title truncation and common selected, hover, and focus styles.

- Keep the primary action as the full-row action and place secondary actions in a separate actions column.
- Do not add layout or paint containment to an ancestor that must participate in subgrid.
- Use `MySidebarListItemTitle` for shared truncation instead of copying those declarations into each feature.
- Keep the actions column above the primary action so blank space between icon buttons does not trigger the row.
- Verify selected, hover, `:focus-visible`/`:focus-within`, keyboard order, and clicks across the full actions column.
- Use the shared icon-button primitive for secondary actions.

```css
.Row {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	align-items: center;
}

.Row-primary {
	display: grid;
	grid-template-columns: subgrid;
	align-items: center;

	grid-column: 1 / -1;
	grid-row: 1;

	/* Keep size/style containment only. Layout or paint containment breaks subgrid. */
	contain: size style;
}

.Row-title {
	grid-column: 1;
}

.Row-actions {
	grid-column: 2;
	grid-row: 1;

	display: flex;
	pointer-events: auto;
}
```

## Ariakit composites with inline row actions

When a `MySelectItem` or `MySearchSelectItem` row contains secondary buttons, use the corrected wiring below. `packages/app/src/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-agent.tsx` shows the composed behavior, but do not copy its current raw selector or `HTMLElement` guard.

- Keep the composite item as the primary action.
- Mark secondary buttons with a typed component-owned `data-*` attribute. Gate `hideOnClick` and `setValueOnClick` with a callback typed from the item prop contract.
- Prevent action `mousedown` from moving composite focus.
- Keep action buttons out of the tab order unless their row is the active composite item.
- For a toggle, expose its pressed state and use a dynamic action label. Do not use `aria-pressed` for one-shot or paired commands that do not expose a persistent pressed state.
- Use the wrapper's attached store hooks instead of importing Ariakit context/store hooks into feature code.

```tsx
type ThreadRow_Props = {
	rowValue: string;
	starred: boolean;
	onStarredChange: (starred: boolean) => void;
};

type ThreadRow_CustomAttributes = {
	"data-thread-row-action": "";
};

const ThreadRow = memo(function ThreadRow(props: ThreadRow_Props) {
	const { rowValue, starred, onStarredChange } = props;
	const starButtonLabel = starred ? "Remove from favorites" : "Add to favorites";

	const selectStore = MySearchSelect.useStore();
	const isActiveItem =
		MySearchSelect.useStoreState(selectStore, (state) => {
			if (!state?.activeId) {
				return false;
			}

			return selectStore.item(state.activeId)?.value === rowValue;
		}) ?? false;

	const handleItemClickBehavior: NonNullable<MySearchSelectItem_Props["setValueOnClick"]> = (event) => {
		const target = event.target;
		if (!(target instanceof Element)) {
			return true;
		}

		return !target.closest(`[${"data-thread-row-action" satisfies keyof ThreadRow_CustomAttributes}]`);
	};

	const handleActionMouseDown = (event: MouseEvent<HTMLButtonElement>) => {
		event.preventDefault();
		event.stopPropagation();
	};

	const handleToggleStar = (event: MouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		onStarredChange(!starred);
	};

	return (
		<MySearchSelectItem
			value={rowValue}
			hideOnClick={handleItemClickBehavior}
			setValueOnClick={handleItemClickBehavior}
		>
			<MyIconButton
				{...({ "data-thread-row-action": "" } satisfies Partial<ThreadRow_CustomAttributes>)}
				tabIndex={isActiveItem ? 0 : -1}
				aria-pressed={starred}
				tooltip={starButtonLabel}
				onMouseDown={handleActionMouseDown}
				onClick={handleToggleStar}
			>
				<MyIconButtonIcon>
					<Star fill={starred ? "currentColor" : "none"} />
				</MyIconButtonIcon>
			</MyIconButton>
		</MySearchSelectItem>
	);
});
```

## React context

For new app-owned context consumers, prefer React 19's `use(Context)`. Existing integrations may keep `useContext` when local code or a third-party API owns that pattern.

Expose an app-owned context through its provider's attached hook when the provider owns the public API, for example `AppTenantProvider.useContext()`. The attached hook should call React `use(Context)`, validate the provider, and return the context value.

```tsx
type SearchContextValue = {
	query: string;
	setQuery: (query: string) => void;
};

const SearchContext = createContext<SearchContextValue | null>(null);

type SearchProvider_Props = {
	children: ReactNode;
};

const SearchProvider = Object.assign(
	memo(function SearchProvider(props: SearchProvider_Props) {
		const { children } = props;
		const [query, setQuery] = useState("");

		return <SearchContext.Provider value={{ query, setQuery }}>{children}</SearchContext.Provider>;
	}),
	{
		useContext: function useContext() {
			const value = use(SearchContext);
			if (!value) {
				throw new Error("SearchProvider.useContext must be used within SearchProvider");
			}
			return value;
		},
	},
);

export { SearchProvider };
```

## Refs

React 19 passes `ref` as a regular prop. Do not add `forwardRef` for new app-owned components.

- Use a concrete ref type such as `Ref<HTMLButtonElement>` or `ComponentPropsWithRef<"button">`. Do not use `any` in ref examples or APIs.
- Keep `ref` first in the props type, destructuring, and JSX props.
- When one callback ref updates several targets, type the instance and clear every object ref, callback ref, or state setter when the node detaches. Do not return a ref cleanup callback unless it performs that full cleanup.

```tsx
type MyButton_ClassNames = "MyButton";
type MyButton_Props = ComponentPropsWithRef<"button">;

const MyButton = memo(function MyButton(props: MyButton_Props) {
	const { ref, className, ...rest } = props;

	return (
		<button
			ref={ref}
			className={cn("MyButton" satisfies MyButton_ClassNames, className)}
			{...rest}
		/>
	);
});
```

Existing modules use `forward_ref` from `packages/app/src/lib/utils.ts`. Do not return `forward_ref(...)` from a React callback ref when any target is an object ref or state setter: the helper's returned cleanup only runs cleanup functions returned by callback refs, so those other targets stay attached. In that case, either forward both the node and the later `null` value without returning the helper cleanup, or fix the helper so its returned cleanup clears every target. Keep the node and ref types concrete.

### Imperative handles

Use `useImperativeHandle` only when a parent needs a small imperative API that cannot be expressed with normal props. Keep the handle type next to the component, expose the smallest surface, and include every reactive value used to create the handle.

```tsx
type SearchInput_Ref = {
	focus: () => void;
};

type SearchInput_Props = {
	ref?: Ref<SearchInput_Ref>;
	value: string;
	onValueChange: (value: string) => void;
};

const SearchInput = memo(function SearchInput(props: SearchInput_Props) {
	const { ref, value, onValueChange } = props;
	const inputRef = useRef<HTMLInputElement>(null);

	useImperativeHandle(ref, () => ({
		focus: () => inputRef.current?.focus(),
	}), []);

	return (
		<input
			ref={inputRef}
			value={value}
			onChange={(event) => onValueChange(event.currentTarget.value)}
		/>
	);
});
```

## Stable callbacks with `useFn`

Use `useFn` from `packages/app/src/hooks/utils-hooks.ts` for the repo's stable-identity, latest-value callback pattern. Common cases are callbacks passed to memoized children, non-React subscriptions, and APIs that store the callback.

Prefer `useFn` over `useCallback` for this pattern. Use a plain closure when stable identity is not useful.

```tsx
const handleClick = useFn<MyIconButton_Props["onClick"]>(() => {
	doSomethingWithLatestValue(value);
});

return <MyIconButton onClick={handleClick} />;
```

```tsx
const handleMessage = useFn((event: MessageEvent) => {
	onMessage(event.data);
});

useEffect(() => {
	target.addEventListener("message", handleMessage);
	return () => target.removeEventListener("message", handleMessage);
}, [target, handleMessage]);
```

## Component attached exports (Fast Refresh / HMR-friendly)

Keep stable hooks or constants on their owning component with `Object.assign(...)`, then export that one component symbol. This avoids separate non-component runtime exports and keeps the module compatible with Fast Refresh. For a component declared in the module, use `Object.assign(memo(function Component(...) { ... }), { ... })`. If a framework or factory already returns the component, attach to that stable component directly.

For a new or edited memoized component with attached exports, declare the `Object.assign(...)` symbol first, then export it with a separate `export { Component };` line. Preserve established direct or factory-based exports when nearby code uses them.

- Attach only stable APIs conceptually owned by the component.
- Do not attach subcomponents only to create a compound namespace.
- Prefer a provider's attached context hook over a separate ownerless context hook.

The `SearchProvider` example above is the canonical attached-hook pattern.

# Convex environment variables

- `VITE_CONVEX_URL`: Convex deployment URL used by `ConvexReactClient`.
- `VITE_CONVEX_HTTP_URL`: Convex HTTP/site origin used for app HTTP routes and the authentication issuer/JWKS.
- For browser calls to app-owned HTTP routes, use helpers in `packages/app/src/lib/fetch.ts`, including `app_fetch_main_api_url(...)` when building an app URL.
- Third-party services use their own documented base URLs and clients. Never use `VITE_CONVEX_HTTP_URL` as a third-party origin.

# Browser QA

For live browser inspection or UI QA, use Playwriter and load `.agents/skills/app-playwriter-harness/SKILL.md`. Use another browser tool only when Playwriter cannot perform the task or the user requests it.

# Temporary debug logging

- Add temporary structured logs only to test a concrete debugging hypothesis.
- Do not log secrets, tokens, or private user payloads.
- Do not send Convex debug logs to localhost or browser-only ingestion endpoints because Convex runs remotely. Use temporary structured `console.log` calls, then read them with the Convex CLI or an already-running Cursor terminal transcript. Run every Convex CLI command through Vite Plus.
- Load `.agents/skills/troubleshooting/SKILL.md` for service diagnostics, CLI commands, and transcript locations.
- Remove temporary logs after verification.
