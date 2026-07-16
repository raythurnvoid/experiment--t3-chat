import type { ComponentProps } from "react";
import { memo } from "react";
import type { ExtractStrict } from "type-fest";

import { MyInputControl, type MyInputControl_Props } from "@/components/my-input.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { files_find_file_stem_end_index, files_normalize_name_input, type files_TreeItem } from "@/lib/files.ts";

function get_protected_extension_start(args: {
	kind: files_TreeItem["kind"];
	value: string;
	selectionStart: number;
	selectionEnd: number;
}) {
	// Locate the extension separator so live basename edits can ignore the protected suffix.
	const extensionStart = args.value.lastIndexOf(".");
	if (
		args.kind === "file" &&
		extensionStart !== -1 &&
		args.selectionStart <= extensionStart &&
		args.selectionEnd <= extensionStart
	) {
		// Ignore extension separator adjacency when the edit is fully inside the basename.
		return extensionStart;
	}

	// Normalize edits that touch the extension against the full remaining value.
	return args.value.length;
}

function normalize_name_input_value(args: { kind: files_TreeItem["kind"]; value: string }) {
	const extensionStart = args.kind === "file" ? args.value.lastIndexOf(".") : -1;
	if (extensionStart !== -1) {
		// Sanitize the basename and the extension separately so a deletion that leaves a
		// trailing basename separator (`speakers-.mp4`) cannot swallow the extension dot.
		const baseName = files_normalize_name_input({
			kind: args.kind,
			previousText: "",
			insertedText: args.value.slice(0, extensionStart),
			nextText: "",
		});
		const extension = files_normalize_name_input({
			kind: args.kind,
			previousText: ".",
			insertedText: args.value.slice(extensionStart + 1),
			nextText: "",
		});
		return `${baseName}.${extension}`;
	}

	// Sanitize the whole current value for folders and extension-less file drafts.
	return files_normalize_name_input({
		kind: args.kind,
		previousText: "",
		insertedText: args.value,
		nextText: "",
	});
}

/**
 * Select the basename of the current input value, keeping the extension outside the
 * selection so typing replaces only the basename and preserves the file type.
 */
export function files_name_input_select_stem(args: { element: HTMLInputElement; kind: files_TreeItem["kind"] }) {
	const selectionEnd =
		args.kind === "file"
			? files_find_file_stem_end_index({ fileName: args.element.value })
			: args.element.value.length;
	if (selectionEnd > 0 && selectionEnd < args.element.value.length) {
		args.element.setSelectionRange(0, selectionEnd);
		return;
	}

	args.element.select();
}

export type FilesNameInputControl_Props = Omit<
	MyInputControl_Props,
	ExtractStrict<keyof MyInputControl_Props, "onBeforeInput" | "onChange" | "onCompositionEnd" | "onPaste">
> & {
	kind: files_TreeItem["kind"];
	/** Receives the sanitized value on every user edit; mirror it into the controlled `value`. */
	onValueChange: (value: string) => void;
	/** Called at the start of every user edit, before the value is sanitized. */
	onEditStart?: (element: HTMLInputElement) => void;
};

/**
 * `MyInputControl` for file and folder names that live-normalizes edits with the project
 * naming rules: typed and pasted text is sanitized in place (lowercase, dashes for
 * unsupported characters, no separator runs) and the file extension is protected from
 * basename edits. Must be used within `MyInput`, like `MyInputControl`.
 */
export const FilesNameInputControl = memo(function FilesNameInputControl(props: FilesNameInputControl_Props) {
	const { kind, onValueChange, onEditStart, ...rest } = props;

	const syncInputValue = useFn((element: HTMLInputElement, nextValue: string, nextSelectionStart?: number) => {
		if (element.value !== nextValue) {
			// Update the DOM immediately because beforeinput/paste handlers prevent the browser default.
			element.value = nextValue;
		}

		// Mirror the same value into the consumer's controlled state.
		onValueChange(nextValue);

		if (nextSelectionStart === undefined) {
			return;
		}

		queueMicrotask(() => {
			if (document.activeElement !== element) {
				return;
			}

			// Restore the caret after React has reconciled the controlled value.
			const safeSelectionStart = Math.min(nextSelectionStart, element.value.length);
			element.setSelectionRange(safeSelectionStart, safeSelectionStart);
		});
	});

	const replaceInputSelection = useFn((element: HTMLInputElement, insertedText: string) => {
		// Read the current selection so typed and pasted text replace the same range natively.
		const selectionStart = element.selectionStart ?? element.value.length;
		const selectionEnd = element.selectionEnd ?? element.value.length;
		const nextTextEnd = get_protected_extension_start({
			kind,
			value: element.value,
			selectionStart,
			selectionEnd,
		});
		const replacementEnd =
			kind === "file" && selectionEnd === nextTextEnd && insertedText.includes(".")
				? element.value.length
				: selectionEnd;
		// Let full file names such as `foo/bar.md` replace the protected extension instead of appending another suffix.
		// Normalize only the inserted fragment, using the surrounding text for separator adjacency.
		const normalizedInsertedText = files_normalize_name_input({
			kind,
			previousText: element.value.slice(0, selectionStart),
			insertedText,
			nextText: element.value.slice(selectionEnd, nextTextEnd),
		});
		// Rebuild the full control value with the sanitized replacement.
		const nextValue =
			element.value.slice(0, selectionStart) + normalizedInsertedText + element.value.slice(replacementEnd);
		if (nextValue === element.value) {
			return;
		}

		// Place the caret at the end of the inserted normalized fragment.
		syncInputValue(element, nextValue, selectionStart + normalizedInsertedText.length);
	});

	const applyInputValue = useFn((element: HTMLInputElement) => {
		// Preserve the current caret as closely as possible when the fallback sanitizer rewrites the value.
		const selectionStart = element.selectionStart ?? element.value.length;
		const nextValue = normalize_name_input_value({
			kind,
			value: element.value,
		});

		// Push the fully sanitized fallback value into the DOM and the consumer's state.
		syncInputValue(element, nextValue, selectionStart);
	});

	const handleBeforeInput = useFn<NonNullable<ComponentProps<"input">["onBeforeInput"]>>((event) => {
		const nativeEvent = event.nativeEvent as InputEvent;
		if (nativeEvent.isComposing) {
			// Wait for compositionend so IME text normalizes as one completed fragment.
			return;
		}

		const insertedText = nativeEvent.data;
		if (insertedText == null || insertedText === "") {
			// Let non-text beforeinput operations such as deletion use the normal input path.
			return;
		}

		// Replace the browser insertion with our sanitized insertion.
		event.preventDefault();
		onEditStart?.(event.currentTarget);
		replaceInputSelection(event.currentTarget, insertedText);
	});

	const handlePaste = useFn<NonNullable<ComponentProps<"input">["onPaste"]>>((event) => {
		const pastedText = event.clipboardData.getData("text/plain");
		if (pastedText === "") {
			return;
		}

		// Route pasted text through the same insertion helper because it can contain many characters.
		event.preventDefault();
		onEditStart?.(event.currentTarget);
		replaceInputSelection(event.currentTarget, pastedText);
	});

	const handleCompositionEnd = useFn<NonNullable<ComponentProps<"input">["onCompositionEnd"]>>((event) => {
		// Sanitize the whole control after composition mutates the real input.
		onEditStart?.(event.currentTarget);
		applyInputValue(event.currentTarget);
	});

	const handleChange = useFn<NonNullable<ComponentProps<"input">["onChange"]>>((event) => {
		// Keep onChange as a fallback for browser paths not covered by beforeinput or paste.
		onEditStart?.(event.currentTarget);
		applyInputValue(event.currentTarget);
	});

	return (
		<MyInputControl
			{...rest}
			onBeforeInput={handleBeforeInput}
			onChange={handleChange}
			onCompositionEnd={handleCompositionEnd}
			onPaste={handlePaste}
		/>
	);
});
