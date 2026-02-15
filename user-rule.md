# Rules and skills (first step after each user message)

After each user message, use the `read_file` tool (without `offset` and `limit`) to read all potentially relevant rules. If you skip this, your response may be incorrect.

You may skip this step only when the relevant rules are already in your context and you still remember them. Make that decision by checking the rules description and confirming that no relevant information is missing from your current context.

# Code citations (workspace code)

When quoting workspace code, always include source file and line range so the user can click and jump to the original code.

Use this format:

```startLine:endLine:filepath
...
```

Always use **repo-relative paths with forward slashes**, for example: `src/pages/Foo.tsx`.

# Editing workflow (before changing a file)

Before editing, scan the file structure first: imports, exports/types, state/effects, handlers (`handle*`/`on*`), helpers, and JSX/template.

Insert new code next to the most similar existing code; do not drop it arbitrarily at the top or bottom. If region/section comments exist, place changes in the correct section.

Rules:

- Keep handlers with handlers, hooks with hooks, helpers with helpers, and JSX prop wiring next to similar props.
- Choose a concrete anchor (nearest similar function or first call site) and insert directly above or below it.
- Match the file’s existing naming, ordering, and formatting (import style, export style, tabs/spaces).
- Do not reorder unrelated code or create new sections; extend the existing pattern.
- If the file may have changed, re-read it before inserting and re-anchor if needed.

# Consistency and minimal diff

- Do **not** do stylistic refactors/cleanups "while you're here" (renames, helper reorganization, moving logic to new files, reformatting, module restructuring, etc.) unless you are **fixing a bug** or I **explicitly ask** for a refactor.
- Prefer the **smallest possible diff** that satisfies the request.
- Keep the **local module style** unchanged (patterns, naming, ordering, type style). Do not "upgrade" inline types into separate types/interfaces unless required for correctness/TypeScript errors or explicitly requested.
- If you need to create a new module/component, first read a couple of nearby/similar modules and match their style and patterns.
- Write code that looks like it was written by the same author as nearby code.

# Avoid overwriting user edits

If the user says they edited a file that you need to modify, you MUST re-read that file before editing so you do not overwrite their changes.

# When using external/source code

If you copy code or heavily adapt from a source, preserve comments because they may contain important context.

# Documentation research and learning

When asked to research, understand, or work with third-party libraries, frameworks, or external tools, be thorough and diligent in reading documentation. More context leads to more accurate guidance and implementation.

Documentation reading process:

1. **Read extensively** - Do not stop at the first relevant section; read multiple related sections, examples, and guides.
2. **Learn and understand** - Do not just extract facts; understand concepts, patterns, and best practices.
3. **Ask yourself questions** - "Do I understand how this works?", "Are there edge cases?", "What are common gotchas?"
4. **Re-read until confident** - Keep cross-referencing until there are no open doubts.
5. **Look for examples** - Prioritize real implementation examples and usage patterns.

Documentation sources to check:

- README files (`.md`)
- Documentation files (`.md`, `.mdx`, `.txt`)
- Example files and stories (`.stories.tsx`, example directories)
- API reference documentation
- Migration guides and changelogs
- Official websites and guides (use `web_search` when needed)

If the user asks questions about the codebase, search thoroughly with the available tools and provide accurate answers. Do not infer from partial information.

**Quality standard:** Your understanding should be deep enough to confidently explain the topic and implement it without guessing. If uncertain, continue researching until clear.

**Priority:** Accuracy through thorough research is more important than speed. Take the time needed to fully understand documentation before advising or implementing.

# Terminal + tools workflow

When using `run_terminal_cmd`, remember the user is on Windows with Git Bash. Prefer simple plain shell commands. Avoid heavy piping, variable replacement, foreach loops, or other complex shell constructs whenever possible.

Sometimes `run_terminal_cmd` is bugged and injects `[200~` into the command. If that happens, keep retrying.
