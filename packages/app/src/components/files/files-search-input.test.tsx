import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FilesSearchInput, type FilesSearchInput_Props } from "./files-search-input.tsx";

vi.mock("convex/react", async (importOriginal) => ({
	...(await importOriginal<typeof import("convex/react")>()),
	useConvex: () => ({ query: async () => [] }),
	useQueries: (queries: Record<string, { args: { clause?: { text: string } } }>) =>
		queries.folders ? { folders: test_folder_page(queries.folders.args.clause!.text) } : {},
}));

/** The saved folders a `file.path` value completes from. */
const test_folder_page = (text: string) => ({
	page: ["/Projects/tasks", "/archive", "/tasks"]
		.filter((path) => path.toLowerCase().includes(text.toLowerCase()))
		.map((path) => ({ kind: "folder", nodeId: `id${path}`, path })),
	isDone: true,
	continueCursor: "",
});

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: { useContext: () => ({ membershipId: "test-membership" }) },
}));

const props: FilesSearchInput_Props = {
	initialQuery: "",
	isSearchLoading: false,
	searchMatchCount: null,
	hasMoreMatches: false,
	onSearchQueryChange: () => {},
	onSubmit: () => true,
};

describe("FilesSearchInput", () => {
	afterEach(cleanup);

	test("updates chips and text when another route query arrives", async () => {
		const onChange = vi.fn();
		const view = render(
			<FilesSearchInput {...props} initialQuery="file.path:/old draft" onSearchQueryChange={onChange} />,
		);
		view.rerender(<FilesSearchInput {...props} initialQuery="metadata.status:open notes" onSearchQueryChange={onChange} />);
		expect(screen.queryByRole("button", { name: "Remove filter file.path:/old" })).toBeNull();
		expect(screen.getByRole("button", { name: "Remove filter metadata.status:open" })).toBeTruthy();
		expect(screen.getByRole("combobox").getAttribute("value")).toBe("notes");
		await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("metadata.status:open notes"));
	});

	test("its own debounced query does not turn a typed filter into a chip", async () => {
		function Consumer() {
			const [query, setQuery] = useState("");
			return <FilesSearchInput {...props} initialQuery={query} onSearchQueryChange={setQuery} />;
		}
		render(<Consumer />);
		const input = screen.getByRole("combobox");
		fireEvent.change(input, { target: { value: "metadata.status:open" } });
		await new Promise((resolve) => setTimeout(resolve, 350));
		expect(screen.queryByRole("button", { name: "Remove filter metadata.status:open" })).toBeNull();
		expect(input.getAttribute("value")).toBe("metadata.status:open");
		fireEvent.keyDown(input, { key: "Enter" });
		expect(await screen.findByRole("button", { name: "Remove filter metadata.status:open" })).toBeTruthy();
	});

	test("clear removes filters and returns focus to the input", async () => {
		const onChange = vi.fn();
		render(<FilesSearchInput {...props} initialQuery="metadata.status:open notes" onSearchQueryChange={onChange} />);
		fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
		expect(screen.queryByRole("button", { name: "Remove filter metadata.status:open" })).toBeNull();
		expect(document.activeElement).toBe(screen.getByRole("combobox"));
		await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(""));
	});

	test("a committed filter shows its problem as soon as words are typed next to it", () => {
		render(<FilesSearchInput {...props} initialQuery="metadata.status:open" />);
		const input = screen.getByRole("combobox");
		const problem = "Search for words or one filter, not both. You can also add a folder, like file.path:/tasks";
		expect(screen.queryByText(problem)).toBeNull();
		fireEvent.change(input, { target: { value: "notes" } });
		expect(screen.getByText(problem, { selector: ".FilesSearchInput-error" })).toBeTruthy();
		fireEvent.change(input, { target: { value: "" } });
		expect(screen.queryByText(problem)).toBeNull();
	});

	describe.each(["sidebar", "palette"] as const)("%s suggestions", (variant) => {
		test("opens on entry, respects Escape while typing, and reopens with Ctrl+Space", async () => {
			const onChange = vi.fn();
			render(
				<FilesSearchInput {...props} variant={variant} initialQuery="metadata.status:open" onSearchQueryChange={onChange} />,
			);
			const input = screen.getByRole<HTMLInputElement>("combobox");
			act(() => input.focus());
			expect(await screen.findByRole("option", { name: "file.path" })).toBeTruthy();
			fireEvent.change(input, { target: { value: "notes" } });
			fireEvent.keyDown(input, { key: "Escape" });
			await waitFor(() => expect(input.getAttribute("aria-expanded")).toBe("false"));
			expect(input.value).toBe("notes");
			expect(screen.getByRole("button", { name: "Remove filter metadata.status:open" })).toBeTruthy();
			fireEvent.keyDown(input, { key: " " });
			fireEvent.change(input, { target: { value: "notes draft" } });
			expect(input.getAttribute("aria-expanded")).toBe("false");
			await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("metadata.status:open notes draft"));
			input.setSelectionRange(2, 2);
			fireEvent.keyDown(input, { key: " ", ctrlKey: true });
			expect(await screen.findByRole("option", { name: "file.path" })).toBeTruthy();
			expect(input.value).toBe("notes draft");
			expect(input.selectionStart).toBe(2);
			fireEvent.click(screen.getByRole("option", { name: "file.link" }));
			expect(input.value).toBe("notes draft file.link:");
			fireEvent.click(await screen.findByRole("option", { name: "public" }));
			expect(await screen.findByRole("button", { name: "Remove filter file.link:public" })).toBeTruthy();
			expect(input.value).toBe("notes draft ");
			await waitFor(() => expect(input.getAttribute("aria-expanded")).toBe("false"));
			fireEvent.click(screen.getByRole("button", { name: "Add search filter" }));
			expect(await screen.findByRole("option", { name: "file.path" })).toBeTruthy();
		});

		test("suggests public for file.link without any tree rows and names the chip file.link", async () => {
			render(<FilesSearchInput {...props} variant={variant} />);
			const input = screen.getByRole<HTMLInputElement>("combobox");
			act(() => input.focus());
			fireEvent.click(await screen.findByRole("option", { name: "file.link" }));
			expect(input.value).toBe("file.link:");
			fireEvent.click(await screen.findByRole("option", { name: "public" }));
			const remove = await screen.findByRole("button", { name: "Remove filter file.link:public" });
			expect(remove.closest(".FilesSearchInputFilterChip")?.textContent).toContain("file.link public");
		});

		test("completes a file.path value from the saved folders the search finds", async () => {
			render(<FilesSearchInput {...props} variant={variant} />);
			const input = screen.getByRole<HTMLInputElement>("combobox");
			act(() => input.focus());
			fireEvent.change(input, { target: { value: "file.path:tas" } });
			expect(await screen.findByRole("option", { name: "/Projects/tasks" })).toBeTruthy();
			expect(screen.getByRole("option", { name: "/tasks" })).toBeTruthy();
			expect(screen.queryByRole("option", { name: "/archive" })).toBeNull();
		});

		test("reopens on a new visit but keeps dismissal when returning from chips or results", async () => {
			function Consumer() {
				const resultsRef = useRef<HTMLDivElement>(null);
				return (
					<>
						<button>Outside search</button>
						<FilesSearchInput {...props} variant={variant} initialQuery="metadata.status:open" resultsRef={resultsRef} />
						<div ref={resultsRef}>
							<button>Search result</button>
						</div>
					</>
				);
			}
			render(<Consumer />);
			const input = screen.getByRole<HTMLInputElement>("combobox");
			act(() => input.focus());
			await screen.findByRole("option", { name: "file.path" });
			fireEvent.keyDown(input, { key: "Escape" });
			await waitFor(() => expect(input.getAttribute("aria-expanded")).toBe("false"));
			act(() => screen.getByRole("button", { name: "Remove filter metadata.status:open" }).focus());
			act(() => input.focus());
			expect(input.getAttribute("aria-expanded")).toBe("false");
			act(() => screen.getByRole("button", { name: "Search result" }).focus());
			act(() => input.focus());
			expect(input.getAttribute("aria-expanded")).toBe("false");
			act(() => screen.getByRole("button", { name: "Outside search" }).focus());
			act(() => input.focus());
			expect(await screen.findByRole("option", { name: "file.path" })).toBeTruthy();
		});

		test("Ctrl+Space leaves typed filters uncommitted and ignores IME composition", async () => {
			render(<FilesSearchInput {...props} variant={variant} />);
			const input = screen.getByRole<HTMLInputElement>("combobox");
			act(() => input.focus());
			await screen.findByRole("option", { name: "file.path" });
			fireEvent.keyDown(input, { key: "Escape" });
			await waitFor(() => expect(input.getAttribute("aria-expanded")).toBe("false"));
			fireEvent.change(input, { target: { value: "file.link:public" } });
			fireEvent.keyDown(input, { key: " ", ctrlKey: true, isComposing: true });
			expect(input.getAttribute("aria-expanded")).toBe("false");
			fireEvent.keyDown(input, { key: " ", ctrlKey: true, keyCode: 229 });
			expect(input.getAttribute("aria-expanded")).toBe("false");
			fireEvent.keyDown(input, { key: " ", ctrlKey: true });
			expect(await screen.findByRole("option", { name: "public" })).toBeTruthy();
			expect(input.value).toBe("file.link:public");
			expect(screen.queryByRole("button", { name: "Remove filter file.link:public" })).toBeNull();
		});
	});
});
