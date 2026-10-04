import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ChannelsSearchView } from "./channels-search.tsx";

const mocks = vi.hoisted(() => ({
	page: { results: [], status: "Exhausted", loadMore: vi.fn() },
	error: null as Error | null,
}));
vi.mock("convex/react", async (importOriginal) => ({
	...(await importOriginal<typeof import("convex/react")>()),
	usePaginatedQuery: () => {
		if (mocks.error) throw mocks.error;
		return mocks.page;
	},
}));
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: { useContext: () => ({ membershipId: "member" }) },
}));
vi.mock("@/lib/app-channels-context.tsx", () => ({
	AppChannelsProvider: { useContext: () => ({ channelList: { results: [] } }) },
}));
vi.mock("./channels-people.ts", () => ({ useChannelsPeople: () => ({ people: [] }) }));
vi.mock("./channels-feed.tsx", () => ({ ChannelsFeedMessage: () => null }));

beforeEach(() => {
	mocks.error = null;
	mocks.page.status = "Exhausted";
	mocks.page.loadMore.mockClear();
});
afterEach(cleanup);

describe("ChannelsSearchView", () => {
	test("keeps native validity live, reveals errors on submit, and submits corrected words", () => {
		const onSearch = vi.fn();
		render(<ChannelsSearchView filters={{}} onSearch={onSearch} />);
		const words = screen.getByRole("searchbox", { name: "Search words" }) as HTMLInputElement;
		expect(words.validity.valid).toBe(false);
		expect(screen.queryByText("Enter search words")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		expect(screen.getByText("Enter search words")).toBeTruthy();
		expect(onSearch).not.toHaveBeenCalled();
		fireEvent.change(words, { target: { value: "  working words  " } });
		expect(words.validity.valid).toBe(true);
		expect(screen.queryByText("Enter search words")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		expect(onSearch).toHaveBeenCalledWith({
			q: "working words",
			channel: undefined,
			from: undefined,
			attachments: undefined,
			since: undefined,
			until: undefined,
		});
	});

	test("refuses an inverted UTC range", () => {
		mocks.page.status = "CanLoadMore";
		const onSearch = vi.fn();
		render(
			<ChannelsSearchView filters={{ q: "words", since: "2026-10-04", until: "2026-10-03" }} onSearch={onSearch} />,
		);
		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		expect(screen.getByText("Since must be before Until")).toBeTruthy();
		expect(onSearch).not.toHaveBeenCalled();
	});

	test("loads another page when no readable result came back", () => {
		mocks.page.status = "CanLoadMore";
		render(<ChannelsSearchView filters={{ q: "words" }} onSearch={vi.fn()} />);
		expect(screen.getByText("No readable matches in this page")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Load more results" }));
		expect(mocks.page.loadMore).toHaveBeenCalledWith(50);
	});

	test("keeps filters and retries a failed search", () => {
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			mocks.error = new Error("Search failed");
			render(<ChannelsSearchView filters={{ q: "words" }} onSearch={vi.fn()} />);
			expect(screen.getByRole("searchbox", { name: "Search words" }).getAttribute("value")).toBe("words");
			expect(screen.getByRole("alert").textContent).toContain("Could not search messages");
			mocks.error = null;
			fireEvent.click(screen.getByRole("button", { name: "Retry" }));
			expect(screen.queryByRole("alert")).toBeNull();
			expect(screen.getByText("No readable matches in this page")).toBeTruthy();
		} finally {
			errorLog.mockRestore();
		}
	});
});
