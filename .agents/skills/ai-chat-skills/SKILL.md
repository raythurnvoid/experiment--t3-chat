---
name: ai-chat-skills
description: Spec for workspace AGENTS.md and ordinary Agent Skills in app chat. Use when changing skill discovery, frontmatter parsing, folder instruction scope, normal skill reads, pending file visibility, or chat context.
---

# Source files

- [Skill paths](../../../packages/app/convex/ai_chat_context.ts): bounded discovery, membership checks, and pending path visibility.
- [Request context](../../../packages/app/server/ai-chat-context.ts): root rules, metadata catalog, ancestor reads, and per-turn dedupe.
- [Parser and limits](../../../packages/app/server/ai-chat-skills.ts): strict YAML metadata parsing.
- [Chat route](../../../packages/app/convex/ai_chat.ts): feature gate, context creation, tool registration, history, and final answer step.
- [Tools](../../../packages/app/server/server-ai-tools.ts) and [Bash filesystem](../../../packages/app/server/bash-utils.ts): ordinary file reads and scoped guidance in tool results.
- [Normal chunk reads](../../../packages/app/convex/files_nodes.ts) and [content actions](../../../packages/app/convex/files_nodes_content.ts): pending text and path reads, access checks, and bounded fallback reads.
- [Chat agent spec](../ai-chat-agent/SKILL.md), [pending changes spec](../files-agent-pending-updates/SKILL.md), and [access-control spec](../access-control/SKILL.md).

# Scope and feature gate

This feature reads files in the current app workspace. It does not read the host repository or personal skill folders.

`AI_CHAT_WORKSPACE_INSTRUCTIONS_ENABLED` is optional. Only the exact value `true` enables it. Read it once at module root. The chat route skips context creation when it is off. Normal file tools remain available under their usual mode permissions.

`.agents` is an ordinary visible folder. Discover skills only at `/.agents/skills/<name>/SKILL.md`. These are app-relative paths. App folders named `tmp` or `.mounts` are ordinary folders too; they are distinct from the shell's temporary and mounted filesystems.

File names use the normal shared file policy. A new bare `readme` or `README` becomes `README.md`. `agents.md` and `skill.md` become `AGENTS.md` and `SKILL.md`; `.agents` keeps that spelling. Existing literal targets retain their identity. Do not rename files while reading them.

# Ordinary file behavior

Skills, resources, and instructions use the same current-user pending view as ordinary reads:

- Pending text is visible under the normal stale-content rules.
- Pending moves and renames change visible paths. A moved folder carries its descendants.
- Pending deletes hide files and folder descendants.
- Eager-created files are visible before their first save.
- Another user's pending moves and content do not change the current user's view.
- New reads recheck normal file access. Missing and restricted sources are unavailable.

Discovery checks active membership and `content.read`, then filters restricted files before returning paths. It scans exact saved `SKILL.md` names and the nodes used by the pending path overlay. The latter also finds ordinary files renamed to `SKILL.md`. It projects each candidate through the normal overlay before checking the skill path shape.

Do not add source versions, saved-only readers, special resource IDs, or a separate skill file cache. There are no selected skills, loaded-skill state, or private script results. There is no skill picker or Instructions and skills dialog.

# Skill format and catalog

The [Agent Skills specification](https://agentskills.io/specification) permits lowercase Unicode names. This app requires ASCII `a-z`, `0-9`, and single hyphens because of its workspace path rules. Names have 1–64 characters and must match the parent folder exactly. Explain that the ASCII limit is an app choice.

`SKILL.md` starts with fenced YAML frontmatter. A UTF-8 BOM and Windows line endings are accepted. Parse YAML 1.2 core. Reject errors, warnings, duplicate keys, unsupported tags, and excessive aliases. Require `name` and a nonempty `description` of at most 1,024 characters. Optional `compatibility` is nonempty and at most 500 characters. Also accept string `license`, string-to-string `metadata`, and string `allowed-tools`. Ignore unknown fields. These fields never grant permissions or add tools.

The parser returns only `name` and `description`. The model catalog contains these fields and the ordinary file path. Invalid readable entries get a path and a short repair warning. Do not include skill bodies, optional metadata, runtime labels, or resource inventories in the catalog.

Read the frontmatter through the ordinary bounded prefix mode. If chunks cannot serve it, use the normal bounded content action. No new skill reader is needed. Readable sources that cannot be read receive a warning. Deleted or restricted sources are omitted. Catalog limits always produce a clear incomplete warning.

# Prompt and tool flow

1. Each turn starts with the base app prompt, current root `/AGENTS.md`, and the skill catalog. No nested rule body or skill body enters this initial prompt.
2. The agent chooses relevant skills and reads their whole `SKILL.md` with Bash. It reads referenced files only as needed. Relative resource paths start at the skill folder. Scripts use existing supported tools; there is no skill-only runtime or automatic script translation.
3. Before editing, shell writes, or code-runner file work, the agent inspects the target and destination folders with normal tools. Moves and copies consider both source and destination rules.
4. The Bash filesystem records actual app paths used during shell execution. Clear these records immediately before execution and copy them immediately after it. Cwd checks, shell safety probes, and cleanup must not add scopes. Safety probes use an unobserved lookup, including in nested shells and xargs. Listing a folder does not load rules from its children.
5. For each used app path, read only root-to-target `AGENTS.md` files. Include a directory's own rules. Label each returned body with its source path and folder scope. Attach guidance outside shell stdout/stderr. A read error after a successful operation adds a warning and preserves that operation's result.
6. The request context holds only user/workspace scope, a map of delivered instruction path to text, and the delivered byte count. Recheck file access and text before dedupe. Skip the same text at the same path. Changed text can be returned again. Identical text under two paths keeps both scope labels.
7. `read_instructions` accepts an optional output byte cap. It counts the JSON-serialized returned string, including escaping, and reserves space for a limit warning. Never mark omitted instruction text as delivered. The caller must retain accepted guidance unchanged.
8. A new turn refreshes root rules and the catalog. Prior ordinary tool results remain normal chat history, including text from sources later changed or deleted. Do not scrub or privately reinject those results.

App rules and the user's request take priority over file guidance. Deeper `AGENTS.md` rules take priority only within their own folder scope. If guidance is incomplete, the prompt asks the agent to read the needed file before continuing in that scope.

The old `load_skill`, `read_skill_resource`, and `run_skill_script` tools are removed. Completed historical tool parts remain readable as generic tool history. No data migration or erasure is required.

# Limits

Caps are UTF-8 bytes unless stated otherwise. Never present a cut skill as complete.

| Item | Limit |
| --- | --- |
| Skill catalog | 100 entries and 32 KiB serialized metadata |
| Candidate named files / pending docs | 1,000 each |
| Skill frontmatter | 8 KiB, plus bounded fence/BOM read space |
| Supported complete skill or normal full read | 64 KiB |
| One automatically loaded `AGENTS.md` | 32 KiB |
| Instruction text delivered per turn | 64 KiB |
| App paths recorded per Bash call | 100 |
| Expanded instruction paths per tool call | 128 |
| Large ordinary file page | At most 500 lines, within the ordinary byte limit |

A valid frontmatter prefix can appear in the catalog even when the full body is too large. The prompt makes the full-read limit explicit. The agent must report that an oversized skill could not be loaded in full. Ordinary large-file reads use continuation pages or a clear long-line refusal.

The tool layer also bounds serialized inputs and outputs across the request. It admits work before execution and preserves a success receipt if a completed write has an oversized preview. These storage and output budgets are separate from the instruction-text cap.

# Verification

- [Discovery tests](../../../packages/app/convex/ai_chat_context.test.ts): exact paths, pending renames and moved folders, pending text and eager creates, deletes, access refusals, and catalog limits.
- [Context tests](../../../packages/app/server/ai-chat-context.test.ts): root-only startup, metadata-only catalog, ancestor order, path/text dedupe, parallel byte budgets, output refusal, and safe read errors.
- [Parser tests](../../../packages/app/server/ai-chat-skills.test.ts): valid metadata, malformed YAML, aliases, app name rules, and UTF-8 frontmatter limits.
- [Gate tests](../../../packages/app/convex/ai_chat_context_gate.test.ts) and [route tests](../../../packages/app/convex/ai_chat_context_route.test.ts): optional feature flag and actual stream setup.
- Tool and Bash tests cover complete reads, continuation, actual app path records, successful writes with guidance warnings, and unknown completed tool history.
- Use the [Playwriter harness](../app-playwriter-harness/SKILL.md) for live auto-use, pending file edits, ancestor-only guidance, history reload, and removal of the picker. Keep QA fixtures in the personal scratch folder unless they are maintained harness fixtures.
- Run focused tests first, then the required app lint and full test pass for this shared surface. Report live checks separately from mocked tests.
