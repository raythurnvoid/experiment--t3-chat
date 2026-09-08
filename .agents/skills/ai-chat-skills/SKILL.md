---
name: ai-chat-skills
description: Spec for workspace AGENTS.md and Agent Skills in the app chat agent. Use when changing saved instruction discovery, skill parsing or activation, skill resource and script tools, system context, source access, skill selection, or the Instructions and skills dialog.
---

# Source files

- [Saved sources and access](../../../packages/app/convex/ai_chat_context.ts): discovery, public catalog, source labels, saved reads, version checks.
- [Request context](../../../packages/app/server/ai-chat-context.ts): system strings, activation, resources, script results, byte budgets.
- [Chat route](../../../packages/app/convex/ai_chat.ts): gate, selected skills, `prepareStep`, stream protection, persistence checks.
- [Tool factories](../../../packages/app/server/server-ai-tools.ts): live and stored skill schemas, execution, shared runner fetch.
- [Parser and caps](../../../packages/app/shared/ai-chat-skills.ts), [file names](../../../packages/app/shared/files.ts), and [message types](../../../packages/app/shared/ai-chat.ts).
- [Controller](../../../packages/app/src/hooks/ai-chat-controller.tsx), [dialog and chips](../../../packages/app/src/components/ai-chat/ai-chat-skills.tsx), [composer](../../../packages/app/src/components/ai-chat/ai-chat-composer.tsx), and [message parts](../../../packages/app/src/components/ai-chat/ai-chat-message.tsx).
- [Chat agent spec](../ai-chat-agent/SKILL.md), [pending changes spec](../files-agent-pending-updates/SKILL.md), and [access-control spec](../access-control/SKILL.md).

# Scope and feature gate

This feature reads files in the current app workspace. It does not read the host repository or user skill folders. It adds no browser service, Google Drive integration, delegated agents, or scheduled goal execution.

`AI_CHAT_WORKSPACE_INSTRUCTIONS_ENABLED` is one optional Convex env var. `convex/ai_chat_context.ts` reads it at module root; only the exact value `true` enables the feature. Unset is off. [Test setup](../../../packages/app/convex/setup-env.test.ts) provides the test default. When off, the catalog is empty, the dialog control is hidden, and the three live skill tools are absent. History validation still knows their stored shapes.

`.agents` is an ordinary visible folder in Files. Discover skills only at `/.agents/skills/<name>/SKILL.md`. Discover exact `AGENTS.md` files across the readable saved workspace. Exclude archived files and sources under `/.mounts`, `/.plugins`, and `/tmp`.

File naming uses the shared normalizers across UI create, rename, import, Bash destinations, and public write doors. A new bare `readme` or `README` becomes `README.md` at every door. `agents.md` and `skill.md` become `AGENTS.md` and `SKILL.md`; `.agents` keeps that spelling. Other names keep the door's extension policy, including bare `agents` and `skill`. Existing literal targets retain their identity; canonical spelling applies to new destinations. Do not rename old sources while reading or writing them.

# Saved sources and access

All source discovery and reads require an active workspace membership with `content.read`, then apply file-path access checks. Public queries throw for missing current-user auth; an authenticated user without access gets `null`. Hidden paths expose no name, description, status, or repair text. The chat route also checks its normal mode permissions before building context.

Only saved text is instruction content. The loader does not use pending content or pending move overlays. It excludes any author's eager-created proposal while its saved sequence still equals the creation stamp. A real save that advances the stamp makes the source eligible. Pending task paths can affect which ancestor rules apply, but they never move saved instruction sources.

Read committed text chunks when ready. If saved collaborative updates await materialization, the internal action uses the existing [bounded reconstruction helper](../../../packages/app/convex/files_nodes_reconstruct_content.ts). Do not copy a Yjs reconstruction engine into this feature. The public catalog cannot run that action and reports an updating source while its saved chunks lag.

Each source has an opaque SHA-256 version. It covers node identity, saved path, text kind, collaboration mode, and the last-sequence document identity, sequence, and lineage; files without that sequence use their asset ID. Materialization alone does not change the version. Reads check the expected version and recheck access after reconstruction. A save race during initial discovery retries once, then asks for another message.

Before each model step, recheck membership and source access. Remove revoked instructions, catalog entries, loaded skills, and resources from future system strings. If a resource is revoked, discard that skill's script results too. Already-loaded text stays pinned for the turn while it remains readable; a later save does not silently replace it. New reads still compare their pinned versions. A new turn discovers saved content again.

# Skill format

The [Agent Skills specification](https://agentskills.io/specification) allows lowercase Unicode letters and numbers in names. This app additionally requires ASCII `a-z`, `0-9`, and single hyphens. Names have 1–64 characters and must match the parent folder exactly. Unicode names get an app-specific repair message. Do not describe the ASCII rule as part of the standard.

Loading is deliberately stricter than the [host integration guide](https://agentskills.io/client-implementation/adding-skills-support), which suggests loading some imperfect files with warnings. This app refuses invalid skills and shows a repair message. It does not rewrite YAML or load a mismatched name anyway.

`SKILL.md` starts with fenced YAML frontmatter. A UTF-8 BOM and Windows line endings are accepted. Parse YAML 1.2 core; reject errors, warnings, duplicate keys, unsupported tags, or excessive aliases. Require `name` and a nonempty `description` of at most 1,024 characters. Optional `compatibility` is nonempty and at most 500 characters. Also accept string `license`, string-to-string `metadata`, and string `allowed-tools`. Unknown fields are ignored. `allowed-tools` grants no permission and enables no tool.

The catalog exposes names, descriptions, compatibility, status, and source links. It exposes no bodies. Invalid readable entries stay visible with repair text but cannot be selected for loading. Explicit `metadata.bonobo-script-runtime` sets the catalog's supported/unsupported script status. The dialog adds a message for unsupported scripts; supported skills show Available. Compatibility prose does not decide runtime support. Unsupported scripts do not block the skill's valid instructions.

# Model steps and storage

1. Build a new request-local context after the route's access checks. Put the base app system prompt first, then readable `AGENTS.md` text in root-to-leaf order, followed by the skill catalog. Label each instruction source and directory scope. Only ancestors of a visible task path apply; sibling rules do not. A move or copy considers both paths. App rules and the user's explicit request take priority over this untrusted source text.
2. Load explicitly selected skills before generation. They appear in the initial system string and the first prepared step. With no explicit selection, the first step has the catalog without skill bodies.
3. Carry loaded bodies, resource text, and script results in `experimental_context`. `prepareStep` rebuilds the system string before each step. A model `load_skill` call adds its body and resource IDs to the next step, not its tool output. Reading or running a resource in the same step as its first load returns `not_loaded`.
4. A resource read adds saved text to the next system string. A script run adds a private result with `toolCallId` and `resourceId`, so parallel runs stay distinguishable. Results and logs never appear in skill tool outputs.
5. A turn has at most ten model steps. With this feature enabled, step ten has no active tools and asks for an answer or a remaining checkpoint. Do not claim unfinished work is complete.

The three tools are `load_skill({ skillId })`, `read_skill_resource({ skillId, resourceId })`, and `run_skill_script({ skillId, resourceId, input? })`. Resource IDs come from the loaded skill's saved resource list. An ID outside that bundle is refused. Binary resource reads are unsupported.

Stored skill tool inputs contain only `skillId` and optional `resourceId`. Stored outputs contain only those IDs, optional 64-character lowercase hex `version`, and `status`: `loaded`, `read`, `completed`, `unavailable`, `invalid`, `changed`, `too_large`, `not_loaded`, `unsupported_runtime`, or `failed`. Opaque IDs are bounded lowercase letters, digits, and underscores. Strict schemas reject extra fields. Do not add bodies, source paths, names, script arguments, raw errors, results, or logs to stored tool parts.

The stream strips argument deltas and private fields before the browser sees them, including calls with names whose casing needs repair. Skill errors use the fixed safe message. Persistence rejects unsafe envelopes, mixed-case stored names, and dynamic aliases. These rules cover skill tool parts; they do not scrub ordinary user or assistant text.

Each tool has its own message part. Resolve source labels through the current `get_source` query, which rechecks access. Made-up or malformed model IDs return `null` and render Source unavailable. Never reuse a stored path or name as a fallback.

# Script runtime and limits

Run only an exact saved `.js` resource when the skill declares `metadata.bonobo-script-runtime: worker-async-body-v1`. Its contents are the body of `async (input) => { ... }`. No shell, Node runtime, ESM module loading, or automatic script translation is added.

Use the existing code runner with a private, short-lived app file list/read grant. These gateway reads keep the normal public-grant pending overlay; the skill document and executable script themselves remain saved-only. Public network access is disabled for skill scripts. Both skill execution and ordinary `execute_code` pass the tool abort signal into the runner fetch. Stop aborts that HTTP request; remote isolate shutdown is a separate runner concern.

Caps are byte limits unless stated otherwise. Refuse oversized sources or incomplete catalogs instead of silently truncating instructions.

| Item | Limit |
| --- | --- |
| User-selected skills | 8 |
| Discovered skills | 100 |
| Skill frontmatter | 8 KiB |
| One `SKILL.md` | 64 KiB |
| One `AGENTS.md` | 16 KiB |
| Active instruction/body/resource/result text | 64 KiB total |
| Catalog metadata | 32 KiB |
| One text resource | 64 KiB |
| Resources per skill / across loaded skills | 200 / 1,000 |
| Script / input | 20,000 / 32,000 bytes |
| Source scan / chunk scan | 1,000 nodes / 128 chunks |
| Saved reconstruction | 1 MiB snapshot and 1 MiB total updates; at most 128 updates |

The catalog cap counts the full serialized metadata, including IDs, statuses, and repair messages. The public query reserves the largest allowed escaped metadata for each Updating entry until materialization finishes. It can report a limit conservatively during that wait.

The existing runner also bounds runtime, result size, and logs. See [execute_code](../ai-chat-agent/SKILL.md#execute_code) for that contract. The active text cap counts instruction and body text, resource text, and serialized script results; it is not a total model token cap.

# Selection and dialog

Use stable `skillIds`, never names or bodies, in message metadata and send options. Root drafts and thread sessions own separate selections. Snapshot selection into each queued item and failed turn. Preserve it through queue edits, message edits, retry, regeneration, reload from message metadata, and optimistic-to-persisted thread swaps. Explicit `[]` removes the old selection. Both the full chat and Files sidebar use the same controller.

The Instructions and skills dialog shows saved source links, status, descriptions, compatibility, and repair text. It explains that changes must be saved before the next message. Agent proposals must be accepted and saved. Selection buttons use `aria-pressed`; selected skills have removable chips in their own composer row.

Use the existing modal and chip primitives. Keep focus inside the dialog and return it to the trigger on close. Escape closes only the dialog while a queued edit stays open. Register the portaled dialog with the composer outside-interaction check. Chip arrow navigation and keyboard removal move focus to another chip, then back to the editor when empty. Keep image chips, skill chips, and text in separate grid rows.

# Verification

Use the [portable plan-and-review fixture](../app-playwriter-harness/assets/files/agent-skills/.agents/skills/plan-and-review/SKILL.md) for a real saved skill with a reference and supported script. It describes sequential self-review and checkpoints, without requiring missing app capabilities.

- [Context tests](../../../packages/app/convex/ai_chat_context.test.ts): saved reads, pending exclusion, version changes, bounded reconstruction, non-member refusal, missing `content.read`, restricted paths, malformed model IDs.
- [Runtime tests](../../../packages/app/server/ai-chat-context.test.ts): next-step bodies/resources, pinned text, concurrent requests, script result correlation, and caps. [Tool tests](../../../packages/app/server/server-ai-tools.test.ts) cover strict stored parts and both runner abort signals. The [route tests](../../../packages/app/convex/ai_chat_context_route.test.ts) mock `streamText` and inspect the actual system and `prepareStep` options.
- [Shared parser tests](../../../packages/app/shared/ai-chat-skills.test.ts) and [shared file tests](../../../packages/app/shared/files.test.ts): format and naming. Keep coverage through the UI, Bash, and public file doors too.
- [Controller tests](../../../packages/app/src/hooks/ai-chat-controller.test.tsx), [message tests](../../../packages/app/src/components/ai-chat/ai-chat-message.test.tsx), and [browser keyboard tests](../../../packages/app/src/components/ai-chat/ai-chat-skills.browser.test.tsx): selections, safe history, dialog focus, chip removal, and unsupported script labels.
- Follow the [Playwriter harness](../app-playwriter-harness/SKILL.md) for live app checks. Prove the browser uses the working tree with an intentional failed assertion first. Use a separate scratch identity for access refusals and hidden paths. Do not treat a mocked test as live access evidence.
- Run `vp env exec pnpm --dir packages/app run lint` and `vp env exec pnpm --dir packages/app run test:once` bare. Read each command's own exit code and test count. Report every check run or skipped; do not claim live runner or browser checks from unit tests alone.
