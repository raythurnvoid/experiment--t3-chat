import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { app_convex_Id } from "@/lib/app-convex-client.ts";

const { tenantContextMock, queryStore, summaryQueryMock } = vi.hoisted(() => {
	const listeners = new Set<() => void>();
	const queryStore = {
		data: undefined as unknown,
		listeners,
		set(next: unknown) {
			queryStore.data = next;
			for (const listener of listeners) {
				listener();
			}
		},
	};
	return { tenantContextMock: vi.fn(), queryStore, summaryQueryMock: vi.fn() };
});

// Network boundary: the real hook talks to a live Convex client. The stub re-renders subscribed
// components when the data changes, like the real subscription does — the strip is memo() with no
// props, so a parent rerender alone would never reach it.
vi.mock("convex/react", async () => {
	const { useSyncExternalStore } = await import("react");
	return {
		useQuery: (query: unknown, args: unknown) => {
			summaryQueryMock(query, args);
			const summary = useSyncExternalStore(
				(listener) => {
					queryStore.listeners.add(listener);
					return () => queryStore.listeners.delete(listener);
				},
				() => queryStore.data,
			);
			return args === "skip" ? undefined : summary;
		},
	};
});

// Provider boundary: the real useContext throws without an AppTenantProvider mounted above.
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => tenantContextMock(),
	},
}));

// The real module creates a live ConvexReactClient at import (needs VITE_CONVEX_URL), and the
// codegen'd api object is a Proxy; plain-string function refs keep call assertions readable.
vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex_api: {
		files_pending_updates: {
			get_files_pending_updates_summary: "get_files_pending_updates_summary",
		},
	},
}));

// The real @/lib/storage.ts stays unmocked: the click test proves the whole round-trip through
// the storage parser whitelist against happy-dom's localStorage.
import { app_local_storage_get_value } from "@/lib/storage.ts";
import {
	FILE_EDITOR_SIDEBAR_TAB_ID_PENDING,
	FileEditorSidebarPendingStrip,
	FileEditorSidebarPendingTabBadge,
} from "./file-editor-sidebar-pending-strip.tsx";

const MEMBERSHIP_ID = "membership_1" as app_convex_Id<"organizations_workspaces_users">;

function makeSummary(count: number, truncated = false) {
	return { count, truncated };
}

beforeEach(() => {
	tenantContextMock.mockReturnValue({ membershipId: MEMBERSHIP_ID });
	queryStore.set(undefined);
	queryStore.listeners.clear();
	summaryQueryMock.mockReset();
	localStorage.clear();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("FileEditorSidebarPendingStrip", () => {
	test("renders nothing but the empty live region when there are no pending updates", () => {
		queryStore.set(makeSummary(0));

		render(<FileEditorSidebarPendingStrip />);

		expect(screen.queryByRole("button")).toBeNull();
		expect(screen.getByRole("status").textContent).toBe("");
	});

	test("renders no strip while the query is still loading", () => {
		queryStore.set(undefined);

		render(<FileEditorSidebarPendingStrip />);

		expect(screen.queryByRole("button")).toBeNull();
	});

	test("renders count, plural label, and review affordance", () => {
		queryStore.set(makeSummary(3));

		const { container } = render(<FileEditorSidebarPendingStrip />);

		expect(screen.getByRole("button", { name: "3 pending file changes, review" })).toBeTruthy();
		expect(container.querySelector(".FileEditorSidebarPendingStrip-count")?.textContent).toBe("3");
		expect(container.querySelector(".FileEditorSidebarPendingStrip-label")?.textContent).toBe("pending file changes");
		expect(container.querySelector(".FileEditorSidebarPendingStrip-review")?.textContent).toContain("Review");
	});

	test("uses the singular label for a single pending update", () => {
		queryStore.set(makeSummary(1));

		const { container } = render(<FileEditorSidebarPendingStrip />);

		expect(screen.getByRole("button", { name: "1 pending file change, review" })).toBeTruthy();
		expect(container.querySelector(".FileEditorSidebarPendingStrip-label")?.textContent).toBe("pending file change");
	});

	test("clicking the strip stores the pending tab as the selected sidebar tab", () => {
		queryStore.set(makeSummary(2));

		render(<FileEditorSidebarPendingStrip />);
		fireEvent.click(screen.getByRole("button"));

		expect(app_local_storage_get_value("app_state::files_last_tab")).toBe(FILE_EDITOR_SIDEBAR_TAB_ID_PENDING);
	});

	test("clicking the strip moves focus to the pending tab", () => {
		queryStore.set(makeSummary(2));

		render(
			<>
				<button id={FILE_EDITOR_SIDEBAR_TAB_ID_PENDING} type="button" />
				<FileEditorSidebarPendingStrip />
			</>,
		);
		fireEvent.click(screen.getByRole("button", { name: "2 pending file changes, review" }));

		expect(document.activeElement?.id).toBe(FILE_EDITOR_SIDEBAR_TAB_ID_PENDING);
	});

	test("announces the count through the polite live region", () => {
		queryStore.set(makeSummary(2));

		render(<FileEditorSidebarPendingStrip />);

		expect(screen.getByRole("status").textContent).toBe("2 pending file changes");
	});

	test("requests and shows the count for the current chat", () => {
		queryStore.set(makeSummary(1));

		const { container } = render(<FileEditorSidebarPendingStrip threadId="thread_a" />);

		expect(screen.getByRole("button", { name: "1 pending file change from this chat, review" })).toBeTruthy();
		expect(container.querySelector(".FileEditorSidebarPendingStrip-count")?.textContent).toBe("1");
		expect(container.querySelector(".FileEditorSidebarPendingStrip-label")?.textContent).toBe(
			"pending file change from this chat",
		);
		expect(screen.getByRole("status").textContent).toBe("1 pending file change from this chat");
		expect(summaryQueryMock).toHaveBeenCalledWith("get_files_pending_updates_summary", {
			membershipId: MEMBERSHIP_ID,
			threadId: "thread_a",
		});
	});

	test("with a threadId that touched nothing, renders no strip even when other rows exist", () => {
		queryStore.set(makeSummary(0));

		render(<FileEditorSidebarPendingStrip threadId="thread_a" />);

		expect(screen.queryByRole("button")).toBeNull();
		expect(screen.getByRole("status").textContent).toBe("");
	});

	test("shows a plus when the chat count reaches its work limit", () => {
		queryStore.set(makeSummary(3, true));
		render(<FileEditorSidebarPendingStrip threadId="thread_a" />);
		expect(screen.getByRole("button", { name: "3+ pending file changes from this chat, review" })).toBeTruthy();
		expect(screen.getByRole("status").textContent).toBe("3+ pending file changes from this chat");
	});

	test("with a null threadId (New chat state), renders no strip even when the workspace has rows", () => {
		queryStore.set(makeSummary(3));

		render(<FileEditorSidebarPendingStrip threadId={null} />);

		expect(screen.queryByRole("button")).toBeNull();
		expect(screen.getByRole("status").textContent).toBe("");
		expect(summaryQueryMock).toHaveBeenCalledWith("get_files_pending_updates_summary", "skip");
	});

	test("without a threadId, requests the workspace-wide count", () => {
		queryStore.set(makeSummary(3));

		const { container } = render(<FileEditorSidebarPendingStrip />);

		expect(screen.getByRole("button", { name: "3 pending file changes, review" })).toBeTruthy();
		expect(container.querySelector(".FileEditorSidebarPendingStrip-label")?.textContent).toBe("pending file changes");
		expect(summaryQueryMock).toHaveBeenCalledWith("get_files_pending_updates_summary", { membershipId: MEMBERSHIP_ID });
	});

	test("keeps the strip mounted with the leaving class for 150ms after the count drops to 0", () => {
		vi.useFakeTimers();
		queryStore.set(makeSummary(3));

		const { container } = render(<FileEditorSidebarPendingStrip />);

		act(() => {
			queryStore.set(makeSummary(0));
		});

		const leavingStrip = container.querySelector(".FileEditorSidebarPendingStrip");
		expect(leavingStrip).toBeTruthy();
		expect(leavingStrip?.classList.contains("FileEditorSidebarPendingStrip-leaving")).toBe(true);

		act(() => {
			vi.advanceTimersByTime(150);
		});

		expect(container.querySelector(".FileEditorSidebarPendingStrip")).toBeNull();
	});

	test("cancels the pending unmount when the count comes back within 150ms", () => {
		vi.useFakeTimers();
		queryStore.set(makeSummary(3));

		const { container } = render(<FileEditorSidebarPendingStrip />);

		act(() => {
			queryStore.set(makeSummary(0));
		});
		act(() => {
			vi.advanceTimersByTime(100);
		});
		act(() => {
			queryStore.set(makeSummary(1));
		});
		act(() => {
			vi.advanceTimersByTime(200);
		});

		const strip = container.querySelector(".FileEditorSidebarPendingStrip");
		expect(strip).toBeTruthy();
		expect(strip?.classList.contains("FileEditorSidebarPendingStrip-leaving")).toBe(false);
		expect(container.querySelector(".FileEditorSidebarPendingStrip-count")?.textContent).toBe("1");
	});
});

describe("FileEditorSidebarPendingTabBadge", () => {
	test("renders nothing when there are no pending updates", () => {
		queryStore.set(makeSummary(0));

		const { container } = render(<FileEditorSidebarPendingTabBadge />);

		expect(container.querySelector(".FileEditorSidebarPendingTabBadge")).toBeNull();
	});

	test("renders the pending update count", () => {
		queryStore.set(makeSummary(3));

		const { container } = render(<FileEditorSidebarPendingTabBadge />);

		expect(container.querySelector(".FileEditorSidebarPendingTabBadge")?.textContent).toBe("3");
	});

	test("keeps an incomplete zero count visible with a plus", () => {
		queryStore.set(makeSummary(0, true));
		const { container } = render(<FileEditorSidebarPendingTabBadge />);
		expect(container.querySelector(".FileEditorSidebarPendingTabBadge")?.textContent).toBe("0+");
	});
});
