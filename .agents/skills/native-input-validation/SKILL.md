---
name: native-input-validation
description: Use when implementing or modifying app input validation that should leverage browser-native HTML validity, CSS pseudo-classes like :invalid or :user-invalid, custom validity messages, validation tooltips, MyInput invalid styling, or form/rename input error behavior.
---

# Native Input Validation

Use browser-native validity as the DOM state that drives input styling. Keep product validation rules in domain helpers or component logic, and project the resulting error message onto the input with the Constraint Validation API.

## Core Pattern

1. Prefer native attributes when they express the rule directly: `required`, `minLength`, `maxLength`, `pattern`, `min`, `max`, `step`, and `type`.
2. Use `setCustomValidity(message)` for domain rules that native attributes cannot express.
3. Keep the error message in React state or derived component state; do not treat the DOM input as the source of truth.
4. Apply `setCustomValidity(errorMessage ?? "")` after the input element exists, usually in `useLayoutEffect`.
5. Clear custom validity when the input becomes inactive, unmounts, blurs to restore, or the user edits after an error.
6. Let shared input CSS style invalid controls through `:invalid`, `:user-invalid`, or `[aria-invalid="true"]`.

```tsx
useLayoutEffect(() => {
	const inputElement = inputElementRef.current;
	if (!inputElement) {
		return;
	}

	inputElement.setCustomValidity(isActive ? (errorMessage ?? "") : "");
	return () => {
		inputElement.setCustomValidity("");
	};
}, [isActive, errorMessage]);
```

## Error Display

- Use app-owned tooltip/helper text for visible messages when native browser bubbles would conflict with the design.
- Do not call `reportValidity()` unless the product explicitly wants the browser's native validation popup.
- Keep tooltip visibility tied to app state, while `setCustomValidity` drives `input.validity.valid` and CSS.
- Prefer a single message source so the tooltip text and `validationMessage` cannot drift.

## Clearing Rules

Clear custom validity in every path where the stale invalid state should stop affecting the DOM:

- On change/input after a displayed error.
- On blur when the flow aborts instead of submitting.
- On successful submit or state transition out of edit mode.
- In effect cleanup.

```tsx
const handleInputChange = useFn<NonNullable<ComponentProps<"input">["onChange"]>>((event) => {
	if (errorMessage) {
		event.currentTarget.setCustomValidity("");
		clearErrorMessage();
	}

	props.onChange?.(event);
});
```

## MyInput Styling

Before adding feature-level invalid styling, check `packages/app/src/components/my-input.css`. Invalid border, outline, and shadow behavior should live in `MyInput` unless the feature has a truly unique visual requirement.

Prefer selectors that let the input own its state:

```css
.MyInput:has([aria-invalid="true"], :invalid, :user-invalid) .MyInputBox {
	border-color: var(--color-red-09);
	outline-color: var(--color-red-09);
	box-shadow: none;
}
```

Avoid sidebar/page-specific overrides for generic invalid borders. Feature CSS may still control placement, tooltip layout, readonly display, or other feature-specific structure.

## Accessibility

- Let native invalid state exist on real `input`, `textarea`, or `select` elements whenever possible.
- Add `aria-invalid` only when native validity cannot represent the invalid state, or when the control is not a native form control.
- Connect visible helper/error text with `aria-describedby` when the component has a stable helper/error element.
- Do not make readonly display inputs focusable unless the user can act on them. Use `tabIndex={-1}` or render plain text for display-only states.

## Abstraction Rule

Do not add a shared helper or prop for the first isolated validation case. Add one only when at least two call sites repeat the same lifecycle code and the abstraction stays smaller than the repeated code.

A good helper is narrow and DOM-native:

```tsx
useNativeCustomValidity(inputRef, isActive ? errorMessage : undefined);
```

Avoid helpers that own product validation, tooltip state, submit behavior, focus policy, or cross-component lifecycle. Those decisions are usually feature-specific and become leaky when hidden behind a generic input prop.

## Verification

For browser QA, inspect the real DOM state:

```js
const input = document.querySelector("input");
({
	valid: input.validity.valid,
	validationMessage: input.validationMessage,
	borderColor: getComputedStyle(input.closest(".MyInput").querySelector(".MyInputBox")).borderColor,
	outlineColor: getComputedStyle(input.closest(".MyInput").querySelector(".MyInputBox")).outlineColor,
	boxShadow: getComputedStyle(input.closest(".MyInput").querySelector(".MyInputBox")).boxShadow,
});
```

Verify both sides of the lifecycle:

- Invalid value sets `validity.valid === false` and shows the app error message.
- Editing, blur-abort, successful submit, or leaving edit mode clears the custom validity.
- The shared input invalid styles are visible without feature-specific border overrides.
