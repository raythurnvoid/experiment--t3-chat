import "@/app.css";
import "../../node_modules/monaco-editor/esm/vs/editor/browser/widget/codeEditor/editor.css";
import "./files/file-editor/file-editor-diff/file-editor-diff.css";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { MyModal, MyModalHeading, MyModalPopover } from "./my-modal.tsx";
import { MyPopover, MyPopoverContent, MyPopoverTrigger } from "./my-popover.tsx";

function renderShell() {
	return render(
		<div id="root">
			<div data-testid="content" style={{ height: 900 }} />
			<div id="app_tiptap_hoisting_container" />
			<div id="app_monaco_hoisting_container" className="monaco-editor">
				<div className="FileEditorDiffWidgetAcceptDiscard" style={{ position: "fixed" }}>
					<button type="button" className="FileEditorDiffWidgetAcceptDiscard-accept-button">
						Accept change
					</button>
				</div>
			</div>
			<div id="app_hoisting_container" />
		</div>,
	);
}

describe("App portal stacking", () => {
	afterEach(() => cleanup());

	test("paints a modal above Monaco overflow controls", async () => {
		const shell = renderShell();
		const editorButton = screen.getByRole("button", { name: "Accept change" });
		render(
			<MyModal defaultOpen>
				<MyModalPopover style={{ height: 180 }}>
					<MyModalHeading>Instructions and skills</MyModalHeading>
				</MyModalPopover>
			</MyModal>,
			{ container: shell.getByTestId("content") },
		);
		const dialog = await screen.findByRole("dialog", { name: "Instructions and skills" });
		const bounds = dialog.getBoundingClientRect();
		const widget = editorButton.parentElement!;
		widget.style.left = `${bounds.left + 40}px`;
		widget.style.top = `${bounds.top + 80}px`;
		await waitFor(() => expect(editorButton.closest("[inert]")).not.toBeNull());
		const inertAncestor = editorButton.closest<HTMLElement>("[inert]")!;
		// Inert hides elements from hit testing, but does not change their paint order.
		// Unmask this fixture briefly so the hit test checks which surface is on top.
		inertAncestor.inert = false;
		try {
			const top = document.elementFromPoint(bounds.left + 50, bounds.top + 90);
			expect(dialog.contains(top), top?.outerHTML).toBe(true);
		} finally {
			inertAncestor.inert = true;
		}
	});

	test("keeps an absolute popover next to its trigger when the portal follows tall content", async () => {
		const shell = renderShell();
		render(
			<MyPopover placement="bottom-start">
				<MyPopoverTrigger>
					<button type="button" style={{ margin: 40 }}>
						Open details
					</button>
				</MyPopoverTrigger>
				<MyPopoverContent>Source details</MyPopoverContent>
			</MyPopover>,
			{ container: shell.getByTestId("content") },
		);
		const trigger = screen.getByRole("button", { name: "Open details" });
		await userEvent.click(trigger);
		const popover = await screen.findByText("Source details");
		await waitFor(() => {
			const triggerBounds = trigger.getBoundingClientRect();
			const popoverBounds = popover.getBoundingClientRect();
			expect(popoverBounds.left).toBeCloseTo(triggerBounds.left, 0);
			expect(popoverBounds.top).toBeCloseTo(triggerBounds.bottom + 4, 0);
		});
	});
});
