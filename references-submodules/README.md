# Reference repositories

This directory contains read-only repositories for documentation, examples, and source inspection. Do not import them into app runtime code or add them to `pnpm-workspace.yaml`; use the app's declared runtime dependencies instead.

[`.gitmodules`](../.gitmodules) is the authoritative inventory and remote configuration. This file is the routing guide: it explains what each registered `references-submodules/*` repository is useful for and where to start reading. Update it when a reference repository is added or when its purpose or best starting path changes.

Read a repository's own `AGENTS.md` before working inside it. Prefer its README, docs, and examples before implementation source.

| Repository | Use it for | Start here |
| --- | --- | --- |
| [action-retrier](action-retrier/) | Convex action retries, backoff, and completion behavior | [README](action-retrier/README.md), [source](action-retrier/src/) |
| [agent](agent/) | Convex Agent threads, messages, tools, and workflows | [README](agent/README.md), [docs](agent/docs/), [source](agent/src/) |
| [ai](ai/) | Vercel AI SDK APIs, providers, tool calling, and examples | [docs](ai/content/docs/), [provider docs](ai/content/providers/), [examples](ai/examples/) |
| [ai-chatbot](ai-chatbot/) | Full-stack AI chat application patterns | [README](ai-chatbot/README.md), [app](ai-chatbot/app/) |
| [assistant-ui](assistant-ui/) | Assistant UI chat components and runtime patterns; reference-only in this app | [README](assistant-ui/README.md), [AGENTS](assistant-ui/AGENTS.md), [packages](assistant-ui/packages/) |
| [bash-gres](bash-gres/) | PostgreSQL-backed virtual filesystems implementing the `just-bash` filesystem contract | [README](bash-gres/README.md), [examples](bash-gres/examples/), [library](bash-gres/lib/) |
| [bash-tool](bash-tool/) | AI SDK-compatible bash, read-file, and write-file tools | [README](bash-tool/README.md), [skills example](bash-tool/examples/skills-tool/), [source](bash-tool/src/) |
| [cloudflare-agents](cloudflare-agents/) | Stateful Cloudflare agents, Durable Objects, scheduling, MCP, and workflows | [README](cloudflare-agents/README.md), [docs](cloudflare-agents/docs/), [examples](cloudflare-agents/examples/) |
| [convex-auth-with-role-based-permissions](convex-auth-with-role-based-permissions/) | Convex authentication and role-based permission examples | [README](convex-auth-with-role-based-permissions/README.md), [source](convex-auth-with-role-based-permissions/src/) |
| [convex-backend](convex-backend/) | Convex backend internals and official documentation source | [README](convex-backend/README.md), [docs source](convex-backend/npm-packages/docs/docs/) |
| [convex-demos](convex-demos/) | Convex example applications and integration patterns | [README](convex-demos/README.md) |
| [convex-helpers](convex-helpers/) | Convex helper utilities and package patterns | [README](convex-helpers/README.md), [package docs](convex-helpers/packages/convex-helpers/README.md) |
| [convex-js](convex-js/) | Convex TypeScript/JavaScript SDK and CLI implementation | [README](convex-js/README.md), [source](convex-js/src/) |
| [convex-sandbox](convex-sandbox/) | Convex-backed persistent bash sandbox and agent integration | [README](convex-sandbox/README.md), [app](convex-sandbox/app/), [Convex backend](convex-sandbox/convex/) |
| [convex-tanstack-start](convex-tanstack-start/) | Convex with TanStack Start | [app source](convex-tanstack-start/src/), [Convex backend](convex-tanstack-start/convex/) |
| [convex-tour-chat](convex-tour-chat/) | Convex chat tutorial application | [README](convex-tour-chat/README.md), [source](convex-tour-chat/src/) |
| [convex-tutorial](convex-tutorial/) | Convex starter tutorial | [README](convex-tutorial/README.md), [source](convex-tutorial/src/) |
| [dynamic-software](dynamic-software/) | Cloudflare Dynamic Worker plugin execution, iframe UI, and artifact contracts | [notes](dynamic-software/NOTES.md), [plugin runtime](dynamic-software/plugin-runtime/README.md), [demo](dynamic-software/dynamic-software-demo/) |
| [executor](executor/) | Tool discovery, describe/call contracts, and integration-host patterns | [README](executor/README.md), [packages](executor/packages/), [examples](executor/examples/) |
| [figma-plugin-samples](figma-plugin-samples/) | Figma plugin manifests, iframe UI, and host/plugin bridge patterns | [README](figma-plugin-samples/README.md), [sample repository](figma-plugin-samples/) |
| [file-selector](file-selector/) | Browser drag/drop and file-input extraction; the app uses the published package at runtime | [README](file-selector/README.md), [source](file-selector/src/) |
| [just-bash](just-bash/) | TypeScript bash interpreter, virtual filesystem, commands, and sandbox assumptions | [README](just-bash/README.md), [threat model](just-bash/THREAT_MODEL.md), [core package](just-bash/packages/just-bash/) |
| [obsidian-dataview](obsidian-dataview/) | Querying and indexing Markdown metadata in an Obsidian-style vault | [README](obsidian-dataview/README.md), [docs](obsidian-dataview/docs/docs/), [source](obsidian-dataview/src/) |
| [openchat](openchat/) | Open-source AI chat application and supporting services | [README](openchat/README.md), [docs](openchat/docs/), [apps](openchat/apps/) |
| [openclaw](openclaw/) | Personal AI assistant gateway, channels, apps, and extension patterns | [README](openclaw/README.md), [docs](openclaw/docs/), [packages](openclaw/packages/) |
| [opencode](opencode/) | Open-source coding agent, tools, editing flows, and platform architecture | [README](opencode/README.md), [AGENTS](opencode/AGENTS.md), [packages](opencode/packages/) |
| [postgres-vfs](postgres-vfs/) | Multi-tenant PostgreSQL virtual filesystem and bash-tool layer | [README](postgres-vfs/README.md), [diagrams](postgres-vfs/diagrams/), [examples](postgres-vfs/examples/) |
| [pragmatic-drag-and-drop](pragmatic-drag-and-drop/) | Low-level browser drag/drop behavior and accessibility patterns; the app uses the published packages at runtime | [README](pragmatic-drag-and-drop/README.md), [core package](pragmatic-drag-and-drop/packages/core/), [guides](pragmatic-drag-and-drop/packages/) |
| [react-resizable-panels](react-resizable-panels/) | Accessible resizable panel groups and layout behavior | [README](react-resizable-panels/README.md), [package](react-resizable-panels/packages/react-resizable-panels/) |
| [reor](reor/) | Local AI knowledge management, Markdown notes, and semantic search | [README](reor/README.md), [source](reor/src/) |
| [space-agent](space-agent/) | Modular workspace capabilities, Git-backed history, and user/group layering | [README](space-agent/README.md), [app](space-agent/app/), [server](space-agent/server/) |
| [streamdown](streamdown/) | Streaming Markdown rendering and related UI packages | [package README](streamdown/packages/streamdown/README.md), [packages](streamdown/packages/) |
| [tanstack-router](tanstack-router/) | TanStack Router docs, route generation, adapters, and examples | [router docs](tanstack-router/docs/router/), [React examples](tanstack-router/examples/react/), [packages](tanstack-router/packages/) |
| [voltagent](voltagent/) | AI agent engineering, orchestration, observability, and examples | [README](voltagent/README.md), [docs](voltagent/docs/), [examples](voltagent/examples/) |
| [vscode-extension-samples](vscode-extension-samples/) | VS Code manifests, activation, commands, contribution points, and webviews | [README](vscode-extension-samples/README.md), [sample repository](vscode-extension-samples/) |
| [workpool](workpool/) | Convex workload concurrency, retries, and durable completion callbacks | [README](workpool/README.md), [source](workpool/src/) |
