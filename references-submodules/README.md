This folder contains **git submodules used only for reference** (docs + source reading).

We do **not** vendor these into the application build; the app should continue to use normal `node_modules` dependencies.

# AI SDK

The Vercel AI SDK repository is checked out here as a submodule so it can be updated easily when needed.
It is used for scraping/reading documentation and source code during development.

- root: `references-submodules/ai` - Vercel AI SDK monorepo
- Documentation: `references-submodules/ai/content/docs/` - Official documentation
- Examples: `references-submodules/ai/examples/` - Usage examples and patterns
- Packages: `references-submodules/ai/packages/` - Core SDK packages
- AI chatbot template: `references-submodules/ai-chatbot` - Vercel AI Chatbot reference app/template

# Convex

The Convex repositories are checked out here as submodules so they can be updated easily when needed.
They are used for scraping/reading documentation and source code during development.

- Convex backend (OSS): `references-submodules/convex-backend`
  - Docs source: `references-submodules/convex-backend/npm-packages/docs/docs/`
- Convex TypeScript/JS SDK + CLI: `references-submodules/convex-js`
- Convex helpers (community utilities): `references-submodules/convex-helpers`
  - Package docs: `references-submodules/convex-helpers/packages/convex-helpers/README.md`
- Convex demos: `references-submodules/convex-demos`
- Convex tutorial starter: `references-submodules/convex-tutorial`
- Convex tour chat sample: `references-submodules/convex-tour-chat`
- Convex Auth + role-based permissions template: `references-submodules/convex-auth-with-role-based-permissions`
- Convex + TanStack Start template: `references-submodules/convex-tanstack-start` (no top-level README; start at `src/` and `convex/`)
