---
name: native-input-validation
description: Use when implementing or modifying app input validation that should leverage browser-native HTML validity, CSS pseudo-classes like :invalid or :user-invalid, custom validity messages, validation tooltips, MyInput invalid styling, or form/rename input error behavior.
---

# Native Validity Is The DOM Source Of Truth

Use browser-native validity as the DOM validity state. Keep product validation rules in domain helpers or component logic, and project the resulting error message onto the input with the Constraint Validation API. Use app state to decide when an error becomes visible; `MyInput` maps `displayValidationMessage` to `.userInvalid` for red styling.

# Core Pattern

1. Prefer native attributes when they express the rule directly: `required`, `minLength`, `maxLength`, `pattern`, `min`, `max`, `step`, and `type`.
2. Use `setCustomValidity(message)` for domain rules that native attributes cannot express.
3. Keep the display validation message in React state or derived component state; do not treat the DOM input as the source of truth.
4. With `MyInput`, pass `validationMessage` to `MyInputControl` or `MyInputTextAreaControl`; the control applies `setCustomValidity(validationMessage ?? "")` so DOM validity is accurate immediately, even before the display validation message is revealed.
5. With `MyInput`, pass `displayValidationMessage` to `MyInput`; the root applies `.userInvalid` only when the error is visible.
6. On input, recompute live validation. If a live field error is already visible, replace it with the new result instead of hiding it. Clear server or submit errors once editing makes them stale. Clear live and display state when the field leaves the active flow; the shared control clears custom validity on unmount.
7. Let shared input CSS style visible invalid states through `.userInvalid`, while preserving `[aria-invalid="true"]` as a supported styling hook for non-native controls and legacy callers. Do not use plain `:invalid` or `:user-invalid` for app-controlled red borders when an input validates before the error should be shown.
8. `dom_get_native_validation_message(input)` exists in `@/lib/dom-utils.ts` but has no current call sites. Use it only when a feature intentionally wants the browser's native constraint message. Otherwise, keep using domain messages for product rules and shared/backend boundaries.

```tsx
<MyInput displayValidationMessage={displayValidationMessage}>
	<MyInputArea>
		<MyInputBox />
		<MyInputControl validationMessage={validationMessage} required minLength={3} onInput={handleInput} />
	</MyInputArea>
	<MyInputHelperText>{displayValidationMessage ?? helperText}</MyInputHelperText>
</MyInput>
```

This example does not create an accessible description relationship by itself. See the accessibility limitation below.

# Value Model

Use precise names for the different values a form field may have:

- `rawValue`: the browser input value before app-owned normalization.
- `draftValue`: the input value after live normalization that intentionally preserves typing affordances, such as a trailing separator needed to show a specific validation error.
- `canonicalValue`: the stable app representation used for dirty checks, rejected-value cache keys, and submit equivalence.
- `submittedValue`: the validated value sent to the backend.

Prefer `canonicalValue` over `compareValue`, `effectiveValue`, or generic `normalizedValue` when the value represents the app-normalized identity of a field. `normalizedValue` is too broad when a form also has draft normalization.

Keep presentation-only values, such as character-count length, outside validators. Read them in the field wrapper after validation has applied any draft normalization to the DOM value.

When a field wrapper already derives `canonicalValue`, do not return the same value from validation under another name. If validation passes, submit the canonical value owned by the wrapper.

Return an explicit validation result object, even when it currently only contains `validationMessage`. Keep the object narrow; do not include presentation-only values or duplicated canonical/submitted values.

When a reusable field wrapper exposes validation state upward, name the callback `onValidationStateChange` and pass `{ validationMessage, canonicalValue }`. For wrapper props, use `draftValueLength` for counters, `helperText` for non-authoritative helper copy, and `isHelperTextInvalid` for helper error styling. Use `validationMessage` for the live/native validity message, `displayValidationMessage` for the message currently shown in the UI, and `submitValidationMessage` for form-level submit errors shown through a field.

# Error Display

- Use app-owned tooltip/helper text for visible messages when native browser bubbles would conflict with the design.
- Do not call `reportValidity()` unless the product explicitly wants the browser's native validation popup.
- Keep tooltip/helper visibility tied to app state, while `validationMessage` drives `input.validity.valid` through `MyInputControl`.
- Prefer a single message source so the tooltip text and `validationMessage` cannot drift.
- Keep canonical-value derivation outside field validators. Pass the canonical value and any rejected-value message map into validation so the validator owns message precedence while the caller owns canonicalization.

# Deferred Error Reveal

For text inputs that validate while the user types, separate live validation from visible validation:

- Validate on input when validity affects button state, counters, normalization, or downstream submit readiness.
- Project every live app validation result into the control `validationMessage` prop immediately, so `input.validity.valid`, `form.checkValidity()`, and invalid events reflect the real field state before blur.
- Prefer native constraints for simple rules even when the helper text is deferred. `required`, `minLength`, and similar attributes can make `validity.valid` and `:invalid` update while the user types; that is acceptable when the UI does not surface the error until blur or submit.
- When a feature intentionally uses browser-owned constraint copy, read it with `dom_get_native_validation_message(input)` before running custom/domain message selection. The helper temporarily clears app custom validity so a stale custom message does not hide the native one. This is available infrastructure, not a current common call-site pattern.
- Store the validation message in a ref when the message is only needed for blur/submit reveal.
- Keep one display validation message per field, for example `displayValidationMessage`.
- Keep `validationMessage` separate from `displayValidationMessage`; the former drives native DOM validity through the control, the latter drives helper text and `.userInvalid` through the root.
- Track whether the user actually edited the field before revealing the display validation message. Focus-only interactions, such as opening a modal and pressing Cancel, may blur an untouched required input; keep `validationMessage` live for state and accessibility, but do not copy it into `displayValidationMessage` until the field is dirty.
- Use `form.checkValidity()` when the form should ask native constraint validation whether any child control is invalid without showing browser validation popups. Use `reportValidity()` only when native browser popups are explicitly desired.
- Do not rely on the browser firing `invalid` when a field blurs. Reveal app helper text from blur/submit handlers; native `invalid` events are for constraint-validation attempts such as form validation.
- Apply the `userInvalid` class only when the app-owned error is visible. This mirrors native `:user-invalid` naming while keeping live native validity separate from visual error timing.
- Keep `[aria-invalid="true"]` supported in shared input CSS for non-native controls and legacy callers, but do not add `aria-invalid` to native inputs just to style the error.
- On input, mark the field dirty, update the live ref and validity state. Refresh the display validation message only if that field is already showing an error.
- On blur or failed submit, reveal the error by copying the live ref into UI state only when the field is dirty or the product explicitly wants submit-time errors for untouched fields.
- On successful submit, modal close, target switch, or flow reset, clear both the live ref and UI state.

```tsx
const isNameDirtyRef = useRef(false);
const [validationMessage, setValidationMessage] = useState<string | undefined>();
const [displayValidationMessage, setDisplayValidationMessage] = useState<string | undefined>();

const validateInput = useFn((input: HTMLInputElement) => {
	const result = validateName(input); // { validationMessage?: string }

	setValidationMessage(result.validationMessage);
	if (displayValidationMessage !== undefined) {
		setDisplayValidationMessage(result.validationMessage);
	}

	return result;
});

const handleInput = useFn<InputEventHandler<HTMLInputElement>>((event) => {
	isNameDirtyRef.current = true;
	validateInput(event.currentTarget);
});

const handleBlur = useFn<FocusEventHandler<HTMLInputElement>>((event) => {
	const result = validateInput(event.currentTarget);
	if (isNameDirtyRef.current) {
		setDisplayValidationMessage(result.validationMessage);
	}
});

<MyInput displayValidationMessage={displayValidationMessage}>
	<MyInputArea>
		<MyInputBox />
		<MyInputControl validationMessage={validationMessage} onInput={handleInput} onBlur={handleBlur} />
	</MyInputArea>
</MyInput>;
```

# Reset And Revalidation Rules

Do not blindly clear live validity on input. Revalidate the edited value so `input.validity`, `form.checkValidity()`, button state, and the visible message stay consistent.

On input, clear server or submit errors that the edit invalidates. If a live field error is already visible, replace the displayed message with the new validation result. Clear both live and displayed state when the field leaves the active flow: successful submit, modal close, target switch, reset, or unmount.

```tsx
const handleInput = useFn<NonNullable<ComponentProps<"input">["onInput"]>>((event) => {
	const nextMessage = validateInput(event.currentTarget).validationMessage;
	setValidationMessage(nextMessage);
	if (displayValidationMessage !== undefined) {
		setDisplayValidationMessage(nextMessage);
	}
});
```

# MyInput Styling

Before adding feature-level invalid styling, check `packages/app/src/components/my-input.css`. Invalid border and outline behavior should live in `MyInput` unless the feature has a truly unique visual requirement.

For fields built with `MyInput`, keep generic validation wiring in the input primitive:

- Put the live validity message on `MyInputControl` or `MyInputTextAreaControl` with `validationMessage`.
- Put the visible error message on `MyInput` with `displayValidationMessage`.
- Do not call `setCustomValidity` from feature components unless they use a raw native control instead of `MyInputControl`.

Prefer selectors that let native validity own the true validity state while displayed error styling follows `.userInvalid`:

```css
.MyInputBox {
	.MyInput.userInvalid &,
	.MyInput:has(:where(.MyInputControl, .MyInputTextAreaControl)[aria-invalid="true"]) & {
		border-color: var(--color-red-09);
		outline-color: var(--color-red-09);
	}
}
```

Current migration debt: `FileNodeViewFolderCreateNodeModal` still calls `setCustomValidity` directly while rendering `MyInputControl`. Do not copy that pattern.

Avoid sidebar/page-specific overrides for generic invalid borders. Feature CSS may still control placement, tooltip layout, readonly display, or other feature-specific structure.

# Accessibility

- Let native invalid state exist on real `input`, `textarea`, or `select` elements whenever possible.
- Do not add `aria-invalid` to native form controls as a parallel validity signal; use native attributes and `setCustomValidity`.
- Add `aria-invalid` only for non-native controls that cannot participate in the Constraint Validation API.
- Connect visible helper/error text with `aria-describedby` when the component has a stable helper/error element.
- `MyInputHelperText` receives an internal helper id, but `MyInputControl` and `MyInputTextAreaControl` do not currently apply it through `aria-describedby`. Do not assume the relation is automatic. If a task requires it, extend the shared primitive or provide an explicit stable description id and verify the rendered DOM.
- Do not make readonly display inputs focusable unless the user can act on them. Use `tabIndex={-1}` or render plain text for display-only states.

# Abstraction Rule

Use the existing `MyInput` validation props before adding another shared helper. Add a new helper only when at least two raw-control call sites repeat the same lifecycle code and the abstraction stays smaller than the repeated code.

A possible future helper would be narrow and DOM-native. `useNativeCustomValidity` below is hypothetical, not a current export; add it only after two raw-control call sites need the same lifecycle.

```tsx
useNativeCustomValidity(inputRef, isActive ? errorMessage : undefined);
```

Avoid helpers that own product validation, tooltip state, submit behavior, focus policy, or cross-component lifecycle. Those decisions are usually feature-specific and become leaky when hidden behind a generic input prop.

# Verification

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
- Editing recomputes custom validity. Blur-abort, successful submit, flow reset, or leaving edit mode clears it.
- The shared input invalid styles are visible without feature-specific border overrides.
- If helper/error text should describe the control, inspect `aria-describedby`; the shared primitive does not wire its helper id automatically today.
