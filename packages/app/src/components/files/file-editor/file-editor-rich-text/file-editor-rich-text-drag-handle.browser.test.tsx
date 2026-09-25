import "@/app.css";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { EditorContent, useEditor } from "@tiptap/react";
import { afterEach, describe, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { nonCollaborativeExtensions } from "./extensions.ts";
import { FileEditorRichTextDragHandle } from "./file-editor-rich-text-drag-handle.tsx";

function TestEditor() {
	const editor = useEditor({
		extensions: nonCollaborativeExtensions,
		content: "<p>First block</p><p>Second block</p>",
		injectCSS: false,
		immediatelyRender: true,
	});

	return (
		<div style={{ padding: "48px" }}>
			<EditorContent editor={editor} />
			<FileEditorRichTextDragHandle editor={editor} />
		</div>
	);
}

async function openSubmenu(name: string) {
	render(<TestEditor />);
	await userEvent.hover(await screen.findByText("First block"));
	await userEvent.click(await screen.findByRole("button", { name: "Block menu" }));
	await userEvent.click(await screen.findByRole("menuitem", { name }));
	return await screen.findByRole("menu", { name });
}

afterEach(() => {
	cleanup();
});

describe("FileEditorRichTextDragHandle", () => {
	// The browser project runs the React Compiler like the app. So this test also catches a list the
	// compiler keeps stale, like the old useFn render functions did.
	test("the Color check moves to the clicked color while the menu stays open", async () => {
		const menu = await openSubmenu("Color");
		const colors = within(menu).getByRole("group", { name: "Color" });
		const purple = within(colors).getByRole("menuitemradio", { name: "Purple" });

		expect(within(colors).getByRole("menuitemradio", { name: "Default" }).getAttribute("aria-checked")).toBe("true");

		await userEvent.click(purple);

		await waitFor(() => expect(purple.getAttribute("aria-checked")).toBe("true"));
		expect(within(colors).getByRole("menuitemradio", { name: "Default" }).getAttribute("aria-checked")).toBe("false");
		expect(
			within(within(menu).getByRole("group", { name: "Background" }))
				.getByRole("menuitemradio", { name: "Default" })
				.getAttribute("aria-checked"),
		).toBe("true");
		expect(menu.isConnected).toBe(true);
	});

	test("the Turn into check moves to the new block type while the menu stays open", async () => {
		const menu = await openSubmenu("Turn into");
		const heading = within(menu).getByRole("menuitemradio", { name: "Heading 1" });

		expect(within(menu).getByRole("menuitemradio", { name: "Text" }).getAttribute("aria-checked")).toBe("true");

		await userEvent.click(heading);

		await waitFor(() => expect(heading.getAttribute("aria-checked")).toBe("true"));
		expect(within(menu).getByRole("menuitemradio", { name: "Text" }).getAttribute("aria-checked")).toBe("false");
	});

	test("Turn into Quote checks only Quote, not Text for the paragraph inside it", async () => {
		const menu = await openSubmenu("Turn into");
		const quote = within(menu).getByRole("menuitemradio", { name: "Quote" });

		await userEvent.click(quote);

		await waitFor(() => expect(quote.getAttribute("aria-checked")).toBe("true"));
		expect(within(menu).getAllByRole("menuitemradio", { checked: true })).toEqual([quote]);
	});
});
