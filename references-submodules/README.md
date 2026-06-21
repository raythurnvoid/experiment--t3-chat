This folder contains **git submodules used only for reference** (docs + source reading).

We do **not** vendor these into the application build; the app should continue to use normal `node_modules` dependencies.

# Assistant UI

The `assistant-ui` repository is checked out here as a submodule so it can be updated easily when needed.
It is used for scraping/reading documentation and source code during development.

- root: `references-submodules/assistant-ui` - assistant-ui monorepo

# AI SDK

The Vercel AI SDK repository is checked out here as a submodule so it can be updated easily when needed.
It is used for scraping/reading documentation and source code during development.

- root: `references-submodules/ai` - Vercel AI SDK monorepo
- Documentation: `references-submodules/ai/content/docs/` - Official documentation
- Examples: `references-submodules/ai/examples/` - Usage examples and patterns
- Packages: `references-submodules/ai/packages/` - Core SDK packages
- AI chatbot template: `references-submodules/ai-chatbot` - Vercel AI Chatbot reference app/template

# Bash And Sandbox References

These repositories are checked out here as submodules for reading shell-tooling, Postgres-backed filesystem, and sandbox implementation patterns.

- bash-gres: `references-submodules/bash-gres`
- postgres-vfs: `references-submodules/postgres-vfs`
- just-bash: `references-submodules/just-bash`
- bash-tool: `references-submodules/bash-tool`
- Convex sandbox: `references-submodules/convex-sandbox`

# Dynamic Plugin Platform

These repositories are checked out here as submodules for researching the GitHub-sourced plugin system, Cloudflare Dynamic Worker runtime, iframe-hosted plugin UI, and manifest/contribution design.

- Space Agent: `references-submodules/space-agent`
  - Useful for modular capabilities, Git-backed rollback/history, user/group layering, and agent-built workspace surfaces.
- Dynamic Software: `references-submodules/dynamic-software`
  - Useful for Cloudflare Dynamic Worker plugin execution, R2-backed runtime artifacts, sandboxed iframe UI, plugin storage, host capability grants, and backend/UI artifact contracts.
- Executor: `references-submodules/executor`
  - Useful for operation discovery, describe/call contracts, typed tool/API surfaces, and integration-host patterns.
- Figma plugin samples: `references-submodules/figma-plugin-samples`
  - Useful for iframe/plugin UI separation, plugin manifests, UI bridge patterns, and examples of keeping host APIs mediated.
- VS Code extension samples: `references-submodules/vscode-extension-samples`
  - Useful for manifest contribution points, activation/event design, extension commands, and webview-style extension UI examples.

# Convex

The Convex repositories are checked out here as submodules so they can be updated easily when needed.
They are used for scraping/reading documentation and source code during development.

- Convex backend (OSS): `references-submodules/convex-backend`
  - Docs source: `references-submodules/convex-backend/npm-packages/docs/docs/`
- Convex TypeScript/JS SDK + CLI: `references-submodules/convex-js`
- Convex helpers (community utilities): `references-submodules/convex-helpers`
  - Package docs: `references-submodules/convex-helpers/packages/convex-helpers/README.md`
- Convex Action Retrier component: `references-submodules/action-retrier`
- Convex demos: `references-submodules/convex-demos`
- Convex tutorial starter: `references-submodules/convex-tutorial`
- Convex tour chat sample: `references-submodules/convex-tour-chat`
- Convex Auth + role-based permissions template: `references-submodules/convex-auth-with-role-based-permissions`
- Convex + TanStack Start template: `references-submodules/convex-tanstack-start` (no top-level README; start at `src/` and `convex/`)
