import "@/app.css";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { MyPopover, MyPopoverContent, MyPopoverTrigger } from "@/components/my-popover.tsx";
import { FileEditorCommentsComposer } from "./file-editor-comments-composer.tsx";

afterEach(() => {
	cleanup();
});

describe("FileEditorCommentsComposer", () => {
	test("Escape in the composer closes the popover around it", async () => {
		render(
			<MyPopover>
				<MyPopoverTrigger>
					<button type="button">Add comment</button>
				</MyPopoverTrigger>
				<MyPopoverContent aria-label="Comment">
					<FileEditorCommentsComposer
						controlRef={null}
						autoFocus="end"
						submitTooltip="Send"
						submitDisabled
						ariaLabel="Comment text"
					/>
				</MyPopoverContent>
			</MyPopover>,
		);

		await userEvent.click(screen.getByRole("button", { name: "Add comment" }));
		const composer = await screen.findByLabelText("Comment text");
		await waitFor(() => expect(document.activeElement).toBe(composer));

		await userEvent.keyboard("{Escape}");

		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Comment" })).toBeNull());
	});
});
