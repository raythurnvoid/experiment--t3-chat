# Frontend App Code Patterns

Use this reference for `packages/app/src/**` React components and frontend lib utilities.

## Anchors

- `packages/app/src/lib/my-focus.ts`
- `packages/app/src/lib/storage.ts`
- `packages/app/src/lib/dom-utils.ts`
- `packages/app/src/lib/date.ts`
- `packages/app/src/lib/currency.ts`
- `packages/app/src/lib/files.ts`
- Nearby component files under `packages/app/src/components/**`

## Naming

- Function names are snake_case for public and module-private functions. Do not introduce bare camelCase helper functions in `src/lib` modules.
- CamelCase belongs to React components and classes. Use `useX` names for hooks.
- Exported prefixes follow the domain vocabulary, not necessarily the filename. `date.ts` and `currency.ts` use `format_*`; file-domain exports use established `files_*` vocabulary. Do not invent filename-derived export prefixes such as `file_paths_*` when the domain prefix is already `files_*`.
- Fixed exported constants should use uppercase names, such as `APP_FONT_FAMILY`. The lower-snake `app_*` examples are functions, objects, or non-constant values, not a reason to lowercase immutable constants.
- In new focused lib modules, do not add the exported domain prefix to private helper symbols just because the public API has it. For example, prefer private helpers such as `segment_graphemes` or `find_max_fitting` inside a `files_*` module.
- Existing files can have stronger local private-helper conventions, such as `my_focus_get_rows` in `my-focus.ts`; follow those only when editing inside that existing convention.
- Exported names should carry enough domain context for import-site clarity. Keep implementation details module-private until another module imports them.

## Placement

- Prefer a small focused frontend lib module over adding to a heavy hub when the behavior is separable. For example, browser DOM or measurement utilities fit better in focused modules such as `my-focus.ts` or `dom-utils.ts` than in broad feature hubs.
- Keep browser-only DOM, layout, storage, and measurement code in `packages/app/src/lib/**` or component code. Do not move it to `packages/app/shared/**`, which must stay portable across browser and server runtimes.
- Keep pure app-only helpers with their browser integration when splitting them would create unnecessary cross-boundary churn.
- In React component files, keep one-caller rendering glue local. Extract a shared component only after there is a second real caller or the local component becomes meaningfully complex.

## Helper Granularity

- Inline one-off helpers unless a helper removes real duplication, names a boundary, or prevents a concrete bug.
- Keep small helpers when they hide an external-system detail, browser API detail, parser boundary, or repeated search/measurement loop.
- Avoid pass-through helpers that only rename arguments or forward values.

## Types

- Inline one-off callback and object types at the parameter or local declaration. Do not add a private alias such as `Fits` just to shorten a single function signature.
- Use named types for exported API, repeated prop/class-name/context/result shapes, recursive structures, derived external API types, or app concepts that are clearer with a concrete name.

## Comments

- Use JSDoc for comments that document a function's purpose, contract, parameters, or return behavior immediately above the function definition.
- Use ordinary `//` comments for non-obvious branches, loops, and statements inside a function body.

## Public Function Shape

- Multi-argument public functions usually take a single `args` object. Examples include `files_download_blob`, node path validation helpers, and app storage helpers.
- Do not destructure an `args` object at the top of a function or create aliases only to shorten property access. Keep `args.foo` explicit unless a local value does real work beyond renaming.
- Prefer behavior verbs already used in nearby code. Reuse established words such as `truncate`, `format`, `normalize`, `validate`, `parse`, `serialize`, and `copy` before coining a new term.

## Tests

- Co-locate frontend lib tests next to the module, such as `files.test.ts` beside `files.ts`.
- Group utility tests by public function with `describe("<public_function>", ...)`.
- Test public behavior rather than private helpers.
- Keep component tests focused on integration behavior, accessible metadata, routing, and user-visible outcomes.
