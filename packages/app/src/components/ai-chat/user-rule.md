# Code citations (workspace code)

When writing code snippets from the workspace, remember to reference the file and the line numbers to let the user click on the code block and be redirected to the source.

The format is:

```startLine:endLine:filepath
...
```

Always use **repo-relative paths with forward slashes**, e.g. `src/pages/Foo.tsx`

# Editing workflow (before you change a file)

Before editing, scan the file to understand its layout: imports, exports/types, state/effects, handlers (handle*/on*), helpers, and JSX/template. Add new code next to the most similar code; don't drop it at the top or bottom. If there are region/section comments, place code inside the correct one.

Rules:

- Handlers with handlers; hooks with hooks; helpers with helpers; prop wiring next to similar props in JSX.
- Pick a concrete anchor (nearest similar function or the first call site) and insert immediately above/below it.
- Match the file’s naming, ordering, and formatting (imports style, export style, tabs/spaces).
- Don’t reorder unrelated code or create new sections; extend the existing pattern.
- If the file may have changed, re-read it before inserting and re-anchor if needed.

# Avoid “improvements” (consistency > aesthetics)

- Do **not** do stylistic refactors/cleanups “while you’re here” (renames, reorganizing helpers, moving logic into new files, reformatting, changing module structure, etc.) unless you are **fixing a bug** or I **explicitly ask** for a refactor.
- Prefer the **smallest possible diff** that accomplishes the requested change.
- Keep the **local module style** as-is (patterns, naming, ordering, types style). Don’t “upgrade” inline types into separate types/interfaces unless it’s required for correctness/TypeScript errors or explicitly requested.
- If you need to create a new module/component, first read a couple nearby/similar modules and match their style and patterns.
- Write code that looks like has been written by the same author of other code in the file or nearby files.

# When using external/source code

When copying or you need to heavily inspire from code from a source, preserve the comments as well as they might contain valuable information.

# Avoid overwriting user edits

If the user tells you that he edited the content of a file you need to edit you MUST read the content of the file again to avoid overriding the user edits.

# Documentation research and learning

**Documentation Research and Learning**: When asked to research, understand, or work with 3rd party libraries, frameworks, or external tools, you must be thorough and diligent in reading available documentation. More information leads to more accurate responses and better implementation guidance.

**Documentation Reading Process**:

1. **Read extensively** - Don’t stop at the first relevant section. Read multiple related sections, examples, and guides.
2. **Learn and understand** - Don’t just extract information; actually comprehend the concepts, patterns, and best practices.
3. **Ask yourself questions** - “Do I understand how this works?”, “Are there edge cases?”, “What are the common gotchas?”
4. **Re-read until confident** - Continue reading and cross-referencing until you have no doubts about your understanding.
5. **Look for examples** - Prioritize finding real code examples and usage patterns.

**Documentation Sources to Check**:

- README files (.md)
- Documentation files (.md, .mdx, .txt)
- Example files and stories (.stories.tsx, example directories)
- API reference documentation
- Migration guides and changelogs
- Official websites and guides (use web_search when needed)

If the user asks questions about the codebase is very important to thoroughly search in the codebase with your tools at your disposal and provide accurate information; do not infer the response from partial information.

**Quality Standard**: Your understanding should be deep enough that you could confidently explain the concepts to someone else and implement solutions without guessing. If you’re uncertain about any aspect, continue researching until you achieve clarity.

**Priority**: Accuracy through thorough research is more valuable than speed. Take the time needed to truly understand the documentation before providing guidance or implementation suggestions.

# Terminal + tools workflow

When using the `run_terminal_cmd` tool, remember I’m on Windows and I use Git Bash. Avoid piping commands as much as possible; avoid variable replacement; avoid foreach or any complex things; prefer simple plain shell commands.

Sometimes using the `run_terminal_cmd` tool fails because the tool is bugged and it introduces `[200~` in the command; you need to keep trying, it will eventually work.

# Rules and skills

After the user sends a message, you need to use the `read_file` tool by omitting the `offset` and `limit` parameter to read all potentially related rules; if you don’t do it, your response will be incorrect. You can skip this step only if you already have the rules content related to the task in your context and you still remember it. To determine if you can skip the step, read the rules description and check that you have the information in your context.
