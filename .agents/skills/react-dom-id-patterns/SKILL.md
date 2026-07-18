---
name: react-dom-id-patterns
description: Use when implementing or reviewing React component-owned DOM ids, htmlFor/id pairs, aria-labelledby, aria-describedby, radio/checkbox group names, or reusable accessible form/control item ids in the app.
---

# Use React IDs Without Rewriting Them

Use `useId()` directly for component-owned runtime ids. Do not strip or sanitize React ids; colons are valid in `id`, `htmlFor`, `aria-labelledby`, `aria-describedby`, and `name` attributes.

Keep global static ids under the separate root `AGENTS.md` contract: declare each string in `AppElementId` and use the literal with `satisfies AppElementId` at DOM API call sites. Do not apply that static-id contract to runtime ids created with `useId()`.

Existing `useUiId(...)` call sites and separate `useId().replace(/:/g, "")` call sites are older patterns. Do not copy them into new component-owned DOM ids; use `useId()` directly. Do not migrate unrelated call sites as cleanup. When DOM-id work already touches one, migrate it only if the id is not persisted or used by an external selector contract.

# Pattern

Build a root id once in the owning parent, then derive child ids by appending readable segments with template literals.

```tsx
const groupName = `ComponentName-${useId()}`;
```

For repeated child items, generate the item id inside the child component from the parent id/name:

```tsx
const optionId = `${name}-option-${useId()}`;
const inputId = `${optionId}-input`;
const descriptionId = `${optionId}-description`;
```

Use semantic suffixes for the actual element role or purpose: `input`, `radio`, `checkbox`, `label`, `description`, `helper`, `error`, `trigger`, `panel`.

# Accessibility Wiring

- Use a real `<label htmlFor={inputId}>` for the primary label text.
- Use `aria-describedby={descriptionId}` for secondary/help/error text.
- Avoid putting long descriptions inside the accessible name when they are better as descriptions.
- For radio groups, keep the shared `name` in the parent and pass it to every option. Let each option generate its own `id`.
- Keep ids visible and local. Do not add a runtime helper just to join id segments.
