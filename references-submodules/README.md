This folder contains **git submodules used only for reference** (docs + source reading).

We do **not** vendor these into the application build; the app should continue to use normal `node_modules` dependencies.

# AI SDK

The Vercel AI SDK repository is checked out here as a submodule so it can be updated easily when needed.
It is used for scraping/reading documentation and source code during development.

- root: `references-submodules/ai` - Vercel AI SDK monorepo
- Documentation: `references-submodules/ai/content/docs/` - Official documentation
- Examples: `references-submodules/ai/examples/` - Usage examples and patterns
- Packages: `references-submodules/ai/packages/` - Core SDK packages
