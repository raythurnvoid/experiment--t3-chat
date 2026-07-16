import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { MyInput } from "@/components/my-input.tsx";
import {
	FilesNameInputControl,
	files_name_input_select_stem,
	type FilesNameInputControl_Props,
} from "./files-name-input.tsx";

vi.hoisted(() => {
	// React only routes `textInput` events into onBeforeInput when the environment declares
	// TextEvent support at react-dom load time, so declare it before react-dom is imported.
	if (!("TextEvent" in window)) {
		Object.assign(window, { TextEvent: class TextEvent extends Event {} });
	}
});

function create_paste_event(text: string) {
	// Build the paste event manually so the test controls `clipboardData` in happy-dom.
	const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(pasteEvent, "clipboardData", { value: { getData: () => text } });
	return pasteEvent;
}

function create_text_input_event(text: string) {
	// Chromium fires a legacy `textInput` event for typing; React builds onBeforeInput from it.
	const textInputEvent = new Event("textInput", { bubbles: true, cancelable: true });
	Object.defineProperty(textInputEvent, "data", { value: text });
	return textInputEvent;
}

function TestNameInput(props: {
	kind: FilesNameInputControl_Props["kind"];
	initialValue: string;
	onValueChange?: (value: string) => void;
	onEditStart?: (element: HTMLInputElement) => void;
}) {
	const [value, setValue] = useState(props.initialValue);

	return (
		<MyInput>
			<FilesNameInputControl
				aria-label="Name"
				kind={props.kind}
				value={value}
				onEditStart={props.onEditStart}
				onValueChange={(nextValue) => {
					setValue(nextValue);
					props.onValueChange?.(nextValue);
				}}
			/>
		</MyInput>
	);
}

function render_name_input(props: Parameters<typeof TestNameInput>[0]) {
	render(<TestNameInput {...props} />);
	return screen.getByRole<HTMLInputElement>("textbox", { name: "Name" });
}

describe("files_name_input_select_stem", () => {
	test("selects only the basename for files with an extension", () => {
		const element = document.createElement("input");
		element.value = "speakers.mp4";

		files_name_input_select_stem({ element, kind: "file" });

		expect(element.selectionStart).toBe(0);
		expect(element.selectionEnd).toBe("speakers".length);
	});

	test("selects the whole value for files without an extension", () => {
		const element = document.createElement("input");
		element.value = "readme";

		files_name_input_select_stem({ element, kind: "file" });

		expect(element.selectionStart).toBe(0);
		expect(element.selectionEnd).toBe("readme".length);
	});

	test("selects the whole value for folders", () => {
		const element = document.createElement("input");
		element.value = "reports.2026";

		files_name_input_select_stem({ element, kind: "folder" });

		expect(element.selectionStart).toBe(0);
		expect(element.selectionEnd).toBe("reports.2026".length);
	});
});

describe("FilesNameInputControl", () => {
	afterEach(() => {
		cleanup();
	});

	test("normalizes a typed separator and keeps it out of the protected extension", async () => {
		const onValueChange = vi.fn();
		const input = render_name_input({ kind: "file", initialValue: "speakers.mp4", onValueChange });

		// Simulate typing a space at the end of the basename.
		input.focus();
		input.setSelectionRange("speakers".length, "speakers".length);
		fireEvent(input, create_text_input_event(" "));

		expect(input.value).toBe("speakers-.mp4");
		expect(onValueChange).toHaveBeenCalledWith("speakers-.mp4");

		// The caret lands after the inserted dash once the microtask restore runs.
		await Promise.resolve();
		expect(input.selectionStart).toBe("speakers-".length);
		expect(input.selectionEnd).toBe("speakers-".length);
	});

	test("lowercases typed characters and strips diacritics", () => {
		const input = render_name_input({ kind: "file", initialValue: "speakers.mp4" });

		input.focus();
		input.setSelectionRange("speakers".length, "speakers".length);
		fireEvent(input, create_text_input_event("É"));

		expect(input.value).toBe("speakerse.mp4");
	});

	test("swallows a typed separator at the start of the name", () => {
		const onValueChange = vi.fn();
		const input = render_name_input({ kind: "file", initialValue: "speakers.mp4", onValueChange });

		input.focus();
		input.setSelectionRange(0, 0);
		fireEvent(input, create_text_input_event("-"));

		expect(input.value).toBe("speakers.mp4");
		expect(onValueChange).not.toHaveBeenCalled();
	});

	test("normalizes pasted text and keeps the extension", async () => {
		const onValueChange = vi.fn();
		const input = render_name_input({ kind: "file", initialValue: "speakers.mp4", onValueChange });

		input.focus();
		input.setSelectionRange(0, "speakers".length);
		fireEvent(input, create_paste_event("My Video"));

		expect(input.value).toBe("my-video.mp4");
		expect(onValueChange).toHaveBeenCalledWith("my-video.mp4");

		// The caret lands after the inserted fragment once the microtask restore runs.
		await Promise.resolve();
		expect(input.selectionStart).toBe("my-video".length);
		expect(input.selectionEnd).toBe("my-video".length);
	});

	test("pasting a full file name over the basename replaces the extension too", () => {
		const input = render_name_input({ kind: "file", initialValue: "speakers.mp4" });

		input.focus();
		input.setSelectionRange(0, "speakers".length);
		fireEvent(input, create_paste_event("backup.webm"));

		expect(input.value).toBe("backup.webm");
	});

	test("ignores a paste with no accepted characters", () => {
		const onValueChange = vi.fn();
		const input = render_name_input({ kind: "file", initialValue: "speakers.mp4", onValueChange });

		input.focus();
		input.setSelectionRange(0, 0);
		fireEvent(input, create_paste_event("!!!"));

		expect(input.value).toBe("speakers.mp4");
		expect(onValueChange).not.toHaveBeenCalled();
	});

	test("keeps the extension dot when a deletion leaves a trailing basename separator", () => {
		const onValueChange = vi.fn();
		const input = render_name_input({ kind: "file", initialValue: "speakers-2.mp4", onValueChange });

		// Simulate backspace deleting `2`; deletions reach the control through onChange.
		fireEvent.change(input, { target: { value: "speakers-.mp4" } });

		expect(input.value).toBe("speakers-.mp4");
		expect(onValueChange).toHaveBeenCalledWith("speakers-.mp4");
	});

	test("sanitizes a whole replaced value, including the extension case", () => {
		const input = render_name_input({ kind: "file", initialValue: "speakers.mp4" });

		fireEvent.change(input, { target: { value: "My File.MP4" } });

		expect(input.value).toBe("my-file.mp4");
	});

	test("sanitizes folder names without extension handling", () => {
		const input = render_name_input({ kind: "folder", initialValue: "notes" });

		fireEvent.change(input, { target: { value: "My Folder" } });

		expect(input.value).toBe("my-folder");
	});

	test("sanitizes the whole value after IME composition ends", () => {
		const input = render_name_input({ kind: "file", initialValue: "notes.md" });

		// Composition mutates the real input before compositionend fires.
		input.value = "héllo wörld.md";
		fireEvent.compositionEnd(input);

		expect(input.value).toBe("hello-world.md");
	});

	test("calls onEditStart before sanitizing an edit", () => {
		const onEditStart = vi.fn();
		const input = render_name_input({ kind: "file", initialValue: "speakers.mp4", onEditStart });

		fireEvent.change(input, { target: { value: "speakers-1.mp4" } });
		fireEvent(input, create_paste_event("clip"));

		expect(onEditStart).toHaveBeenCalledTimes(2);
		expect(onEditStart).toHaveBeenCalledWith(input);
	});
});
