---
name: react-dom-id-patterns
description: Use when implementing or reviewing React component-owned DOM ids, htmlFor/id pairs, aria-labelledby, aria-describedby, radio/checkbox group names, or reusable accessible form/control item ids in the app.
---

# React DOM ID Patterns

Use `useId()` directly for component-owned runtime ids. Do not strip or sanitize React ids; colons are valid in `id`, `htmlFor`, `aria-labelledby`, `aria-describedby`, and `name` attributes.

## Pattern

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

## Accessibility Wiring

- Use a real `<label htmlFor={inputId}>` for the primary label text.
- Use `aria-describedby={descriptionId}` for secondary/help/error text.
- Avoid putting long descriptions inside the accessible name when they are better as descriptions.
- For radio groups, keep the shared `name` in the parent and pass it to every option. Let each option generate its own `id`.
- Keep ids visible and local. Do not add a runtime helper just to join id segments.
