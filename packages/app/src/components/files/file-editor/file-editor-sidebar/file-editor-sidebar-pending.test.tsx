import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { toast } from "sonner";

import type { app_convex_Doc, app_convex_Id } from "@/lib/app-convex-client.ts";

const { tenantContextMock, useQueryMock, useStableQueryMock, actionMock, mutationMock, truncatePathForWidthMock } =
	vi.hoisted(() => ({
		tenantContextMock: vi.fn(),
		useQueryMock: vi.fn(),
		useStableQueryMock: vi.fn(),
		actionMock: vi.fn(),
		mutationMock: vi.fn(),
		truncatePathForWidthMock: vi.fn((args: { path: string }) => args.path),
	}));

// Network boundary: the real hooks talk to a live Convex client; tests feed query data directly.
vi.mock("convex/react", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
	useConvex: () => ({ action: actionMock, mutation: mutationMock }),
}));

// The real useStableQuery routes through convex/react useQuery; mocking it separately lets tests
// feed the tree query on its own.
vi.mock("@/hooks/convex-hooks.ts", () => ({
	useStableQuery: (...args: unknown[]) => useStableQueryMock(...args),
}));

// Spy target: tests assert on toast.error calls.
vi.mock("sonner", () => ({
	toast: { error: vi.fn() },
}));

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
			list_files_pending_updates: "list_files_pending_updates",
			upsert_file_pending_update: "upsert_file_pending_update",
			save_file_pending_update: "save_file_pending_update",
			apply_file_pending_move: "apply_file_pending_move",
			discard_file_pending_structural: "discard_file_pending_structural",
		},
		files_nodes: {
			list_tree: "list_tree",
		},
	},
}));

// Keep the real module and fake only the expensive headless-tiptap decoders: map each branch's
// stored fake string straight to canned Markdown so the action handlers see deterministic
// staged/unstaged content.
vi.mock("@/lib/files.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/files.ts")>()),
	files_yjs_doc_create_from_array_buffer_update: (update: unknown) => update,
	files_yjs_doc_get_markdown: ({ yjsDoc }: { yjsDoc: unknown }) => ({ _yay: yjsDoc as string }),
}));

// The real implementation measures text with Pretext font metrics that happy-dom cannot provide;
// tests also spy on it to assert the measured width/font.
vi.mock("@/lib/file-paths.ts", () => ({
	files_truncate_path_for_width: (args: { path: string; width: number; font: string; letterSpacing: number }) =>
		truncatePathForWidthMock(args),
}));

// The real MyLink is a TanStack Router Link and needs a RouterProvider; the stub renders a plain
// anchor with the resolved href.
vi.mock("@/components/my-link.tsx", () => ({
	MyLink: function MyLink(props: {
		to: string;
		params?: Record<string, string>;
		search?: Record<string, string>;
		className?: string;
		"aria-label"?: string;
		title?: string;
		children?: ReactNode;
	}) {
		let href = props.to;
		for (const [key, value] of Object.entries(props.params ?? {})) {
			href = href.replace(`$${key}`, value);
		}
		const query = props.search ? `?${new URLSearchParams(props.search).toString()}` : "";
		return (
			<a href={`${href}${query}`} aria-label={props["aria-label"]} title={props.title}>
				<span className={props.className}>{props.children}</span>
			</a>
		);
	},
}));

import { FileEditorSidebarPending } from "./file-editor-sidebar-pending.tsx";

function makePendingUpdate(args: {
	id: string;
	fileNodeId: string;
	staged?: string;
	unstaged?: string;
	pendingMove?: { destParentId: string; destName: string; fromPath: string; replacesNodeId?: string };
	copiedFrom?: { nodeId: string; path: string; archivesSourceOnAccept?: boolean };
	eagerCreated?: { committedSequence: number };
}): app_convex_Doc<"files_pending_updates"> {
	return {
		_id: args.id,
		_creationTime: 0,
		organizationId: "organization_1",
		workspaceId: "workspace_1",
		userId: "user_1",
		fileNodeId: args.fileNodeId,
		// Structural-only rows leave all 4 Yjs fields unset, like the server does.
		...(args.staged != null && args.unstaged != null
			? {
					baseYjsSequence: 0,
					baseYjsUpdate: "" as never,
					stagedBranchYjsUpdate: args.staged as never,
					unstagedBranchYjsUpdate: args.unstaged as never,
				}
			: {}),
		...(args.pendingMove ? { pendingMove: args.pendingMove } : {}),
		...(args.copiedFrom ? { copiedFrom: args.copiedFrom } : {}),
		...(args.eagerCreated ? { eagerCreated: args.eagerCreated } : {}),
		size: 0,
		updatedAt: 1,
	} as unknown as app_convex_Doc<"files_pending_updates">;
}

function makeNode(args: {
	id: string;
	path: string;
	kind?: "file" | "folder";
	parentId?: string;
}): app_convex_Doc<"files_nodes"> {
	return {
		_id: args.id,
		_creationTime: 0,
		path: args.path,
		name: args.path.split("/").pop() ?? args.path,
		kind: args.kind ?? "file",
		parentId: args.parentId ?? "root",
	} as unknown as app_convex_Doc<"files_nodes">;
}

const MEMBERSHIP_ID = "membership_1" as app_convex_Id<"organizations_workspaces_users">;

beforeEach(() => {
	tenantContextMock.mockReturnValue({
		membershipId: MEMBERSHIP_ID,
		organizationId: "organization_1",
		organizationName: "team",
		workspaceId: "workspace_1",
		workspaceName: "home",
	});
	actionMock.mockReset();
	actionMock.mockResolvedValue({ _yay: null });
	mutationMock.mockReset();
	mutationMock.mockResolvedValue({ _yay: null });
	truncatePathForWidthMock.mockReset();
	truncatePathForWidthMock.mockImplementation((args: { path: string }) => args.path);
	useQueryMock.mockReset();
	useStableQueryMock.mockReset();
	vi.mocked(toast.error).mockClear();
});

afterEach(() => {
	cleanup();
});

describe("FileEditorSidebarPending", () => {
	test("renders an empty state when there are no pending updates", () => {
		useQueryMock.mockReturnValue([]);
		useStableQueryMock.mockReturnValue([]);

		render(<FileEditorSidebarPending />);

		expect(screen.getByText("No pending changes")).toBeTruthy();
	});

	test("renders items sorted by path with full path visible", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_z", fileNodeId: "node_z", staged: "s", unstaged: "u" }),
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "s", unstaged: "u" }),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_z", path: "zebra/notes.md" }),
			makeNode({ id: "node_a", path: "alpha/intro.md" }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		const paths = Array.from(container.querySelectorAll(".FileEditorSidebarPending-item-path-text")).map(
			(element) => element.textContent,
		);
		expect(paths).toEqual(["alpha/intro.md", "zebra/notes.md"]);
	});

	test("path link opens the file in the diff editor and preserves the full path metadata", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "s", unstaged: "u" }),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "alpha/deeply/nested/intro.md" })]);

		const { container } = render(<FileEditorSidebarPending />);

		const link = screen.getByRole("link", { name: "alpha/deeply/nested/intro.md" });
		const href = link?.getAttribute("href");
		expect(href).toContain("/w/team/home/files");
		expect(href).toContain("nodeId=node_a");
		expect(href).toContain("view=diff_editor");
		expect(link.getAttribute("aria-label")).toBe("alpha/deeply/nested/intro.md");
		expect(link.getAttribute("title")).toBe("alpha/deeply/nested/intro.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-path-text")?.textContent).toBe(
			"alpha/deeply/nested/intro.md",
		);
	});

	test("truncates visible path text while preserving full path metadata", () => {
		const path = "alpha/deeply/nested/intro.md";
		const truncatedPath = "alpha/de…/intro.md";
		const clientWidthSpy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(80);
		truncatePathForWidthMock.mockReturnValue(truncatedPath);
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "s", unstaged: "u" }),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path })]);

		const { container } = render(<FileEditorSidebarPending />);

		const link = screen.getByRole("link", { name: path });
		const pathText = container.querySelector(".FileEditorSidebarPending-item-path-text");
		expect(pathText?.textContent).toBe(truncatedPath);
		expect(link.getAttribute("aria-label")).toBe(path);
		expect(link.getAttribute("title")).toBe(path);
		expect(truncatePathForWidthMock).toHaveBeenCalledWith({
			path,
			width: 80,
			font: expect.stringContaining("system-ui"),
			letterSpacing: 0,
		});

		clientWidthSpy.mockRestore();
	});

	test("Accept stages the unstaged content then saves", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "STAGED_MD", unstaged: "UNSTAGED_MD" }),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "alpha/intro.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept"));

		await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(2));
		expect(actionMock).toHaveBeenNthCalledWith(1, "upsert_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_a",
			stagedMarkdown: "UNSTAGED_MD",
			unstagedMarkdown: "UNSTAGED_MD",
		});
		expect(actionMock).toHaveBeenNthCalledWith(2, "save_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_a",
		});
	});

	test("a stale save resolves silently without an error toast", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "STAGED_MD", unstaged: "UNSTAGED_MD" }),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "alpha/intro.md" })]);
		actionMock.mockReset();
		// The upsert lands, then another tab's save advances the row before this save runs; the
		// reactive query renders the real state, so no error and no success announcement.
		actionMock.mockResolvedValueOnce({ _yay: null }).mockResolvedValue({ _nay: { message: "Stale save" } });

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept"));

		await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(2));
		expect(toast.error).not.toHaveBeenCalled();
		expect(screen.getByRole("status").textContent).toBe("");
	});

	test("Discard reverts the unstaged content back to staged", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "STAGED_MD", unstaged: "UNSTAGED_MD" }),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "alpha/intro.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard"));

		await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(1));
		expect(actionMock).toHaveBeenNthCalledWith(1, "upsert_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_a",
			stagedMarkdown: "STAGED_MD",
			unstagedMarkdown: "STAGED_MD",
		});
	});

	test("Accept all accepts and saves every pending update", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "STAGED_A", unstaged: "UNSTAGED_A" }),
			makePendingUpdate({ id: "pu_b", fileNodeId: "node_b", staged: "STAGED_B", unstaged: "UNSTAGED_B" }),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_a", path: "alpha/intro.md" }),
			makeNode({ id: "node_b", path: "beta/readme.md" }),
		]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept all"));

		// 2 rows x (upsert + save) = 4 action calls
		await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(4));
		expect(actionMock).toHaveBeenCalledWith("upsert_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_a",
			stagedMarkdown: "UNSTAGED_A",
			unstagedMarkdown: "UNSTAGED_A",
		});
		expect(actionMock).toHaveBeenCalledWith("save_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_a",
		});
		expect(actionMock).toHaveBeenCalledWith("upsert_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_b",
			pendingUpdateId: "pu_b",
			stagedMarkdown: "UNSTAGED_B",
			unstagedMarkdown: "UNSTAGED_B",
		});
		expect(actionMock).toHaveBeenCalledWith("save_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_b",
			pendingUpdateId: "pu_b",
		});
	});

	test("Discard all reverts every pending update to staged", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "STAGED_A", unstaged: "UNSTAGED_A" }),
			makePendingUpdate({ id: "pu_b", fileNodeId: "node_b", staged: "STAGED_B", unstaged: "UNSTAGED_B" }),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_a", path: "alpha/intro.md" }),
			makeNode({ id: "node_b", path: "beta/readme.md" }),
		]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard all"));

		// 2 rows x upsert = 2 action calls, no save
		await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(2));
		expect(actionMock).toHaveBeenCalledWith("upsert_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_a",
			stagedMarkdown: "STAGED_A",
			unstagedMarkdown: "STAGED_A",
		});
		expect(actionMock).toHaveBeenCalledWith("upsert_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_b",
			pendingUpdateId: "pu_b",
			stagedMarkdown: "STAGED_B",
			unstagedMarkdown: "STAGED_B",
		});
	});

	test("Discard all waits out a rate-limited row and retries it", async () => {
		vi.useFakeTimers();
		try {
			useQueryMock.mockReturnValue([
				makePendingUpdate({
					id: "pu_move",
					fileNodeId: "node_a",
					pendingMove: { destParentId: "root", destName: "a.md", fromPath: "/a.md" },
				}),
			]);
			useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);
			mutationMock.mockReset();
			mutationMock
				.mockResolvedValueOnce({ _nay: { message: "Rate limit exceeded" } })
				.mockResolvedValue({ _yay: null });

			render(<FileEditorSidebarPending />);
			fireEvent.click(screen.getByText("Discard all"));
			expect(mutationMock).toHaveBeenCalledTimes(1);

			// Flush the rate-limited result so the 5s retry timer gets scheduled, then fire it.
			await act(async () => {});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(5_000);
			});

			expect(mutationMock).toHaveBeenCalledTimes(2);
			expect(mutationMock).toHaveBeenLastCalledWith("discard_file_pending_structural", {
				membershipId: MEMBERSHIP_ID,
				nodeId: "node_a",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	test("Accept all retries a row whose mutation throws once", async () => {
		vi.useFakeTimers();
		try {
			useQueryMock.mockReturnValue([
				makePendingUpdate({
					id: "pu_move",
					fileNodeId: "node_a",
					pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
				}),
			]);
			useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);
			mutationMock.mockReset();
			// A Convex write conflict surfaces as a THROWN error, not a `_nay` result.
			mutationMock.mockRejectedValueOnce(new Error("Documents changed while this mutation was being run"));
			mutationMock.mockResolvedValue({ _yay: null });

			render(<FileEditorSidebarPending />);
			fireEvent.click(screen.getByText("Accept all"));
			expect(mutationMock).toHaveBeenCalledTimes(1);

			// Flush the rejection so the 5s retry timer gets scheduled, then fire it.
			await act(async () => {});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(5_000);
			});
			await act(async () => {});

			expect(mutationMock).toHaveBeenCalledTimes(2);
			expect(mutationMock).toHaveBeenLastCalledWith("apply_file_pending_move", {
				membershipId: MEMBERSHIP_ID,
				nodeId: "node_a",
			});
			expect(toast.error).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	test("Accept all counts a row whose mutation keeps throwing in the failure toast", async () => {
		vi.useFakeTimers();
		try {
			useQueryMock.mockReturnValue([
				makePendingUpdate({
					id: "pu_move",
					fileNodeId: "node_a",
					pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
				}),
			]);
			useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);
			mutationMock.mockReset();
			mutationMock.mockRejectedValue(new Error("Documents changed while this mutation was being run"));

			render(<FileEditorSidebarPending />);
			fireEvent.click(screen.getByText("Accept all"));

			// Initial call + 6 retries, each behind a 5s backoff.
			for (let attempt = 0; attempt < 6; attempt++) {
				await act(async () => {});
				await act(async () => {
					await vi.advanceTimersByTimeAsync(5_000);
				});
			}
			await act(async () => {});

			expect(mutationMock).toHaveBeenCalledTimes(7);
			expect(toast.error).toHaveBeenCalledWith("Failed to accept 1 of 1 pending changes");
		} finally {
			vi.useRealTimers();
		}
	});

	test("Accept all treats a row's stale save as benign, not a failure", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "STAGED_A", unstaged: "UNSTAGED_A" }),
			makePendingUpdate({ id: "pu_b", fileNodeId: "node_b", staged: "STAGED_B", unstaged: "UNSTAGED_B" }),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_a", path: "alpha/intro.md" }),
			makeNode({ id: "node_b", path: "beta/readme.md" }),
		]);
		actionMock.mockReset();
		// Another tab's save advances node_a's row before this bulk save runs; the reactive query
		// renders the real state, so the row is benign — not a failure, no error toast.
		actionMock.mockImplementation((fn: unknown, args: { nodeId?: string }) =>
			fn === "save_file_pending_update" && args.nodeId === "node_a"
				? Promise.resolve({ _nay: { message: "Stale save" } })
				: Promise.resolve({ _yay: null }),
		);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept all"));

		// 2 rows x (upsert + save) = 4 action calls
		await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(4));
		await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Accepted 2 pending changes"));
		expect(toast.error).not.toHaveBeenCalled();
	});

	test("move row renders from → dest without an accordion or diff link", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_move",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "node_docs", destName: "a.md", fromPath: "/a.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md" }),
			makeNode({ id: "node_docs", path: "/docs", kind: "folder" }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		const link = screen.getByRole("link", { name: "/a.md → /docs/a.md" });
		const href = link.getAttribute("href");
		expect(href).toContain("nodeId=node_a");
		expect(href).not.toContain("view=diff_editor");
		expect(link.getAttribute("title")).toBe("/a.md → /docs/a.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-move-label-from")?.textContent).toBe("/a.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-move-label-to")?.textContent).toBe("/docs/a.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Moved");
		expect(container.querySelector("details")).toBeNull();
		expect(screen.getByText("Accept")).toBeTruthy();
	});

	test("added row shows the green Added caption and path and keeps the diff link", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_copy",
				fileNodeId: "node_a",
				staged: "s",
				unstaged: "u",
				copiedFrom: { nodeId: "node_src", path: "/recorded.md" },
				eagerCreated: { committedSequence: 0 },
			}),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/copy.md" }),
			makeNode({ id: "node_src", path: "/source.md" }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Added");
		expect(container.querySelector(".FileEditorSidebarPending-item-path-text-added")?.textContent).toBe("/copy.md");
		const link = screen.getByRole("link", { name: "/copy.md" });
		expect(link.getAttribute("href")).toContain("view=diff_editor");
		expect(container.querySelector("details")).toBeTruthy();
	});

	test("replace-copy row shows the Replaced caption without the green path", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_replace_copy",
				fileNodeId: "node_a",
				staged: "s",
				unstaged: "u",
				copiedFrom: { nodeId: "node_src", path: "/source.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/target.md" })]);

		const { container } = render(<FileEditorSidebarPending />);

		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Replaced");
		expect(container.querySelector(".FileEditorSidebarPending-item-path-text-added")).toBeNull();
	});

	test("replace-move row shows the from → to label with the Replaced caption and keeps the diff link", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_replace_move",
				fileNodeId: "node_a",
				staged: "s",
				unstaged: "u",
				copiedFrom: { nodeId: "node_src", path: "/recorded.md", archivesSourceOnAccept: true },
			}),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/target.md" }),
			makeNode({ id: "node_src", path: "/source.md" }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		// The live source path wins over the recorded one; source red → target green.
		const link = screen.getByRole("link", { name: "/source.md → /target.md" });
		expect(link.getAttribute("href")).toContain("nodeId=node_a");
		expect(link.getAttribute("href")).toContain("view=diff_editor");
		expect(container.querySelector(".FileEditorSidebarPending-item-move-label-from")?.textContent).toBe("/source.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-move-label-to")?.textContent).toBe("/target.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Replaced");
		expect(container.querySelector(".FileEditorSidebarPending-item-path-text-added")).toBeNull();
		expect(container.querySelector("details")).toBeTruthy();
	});

	test("replace-move row falls back to the recorded source path when the node is gone", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_replace_move",
				fileNodeId: "node_a",
				staged: "s",
				unstaged: "u",
				copiedFrom: { nodeId: "node_gone", path: "/recorded.md", archivesSourceOnAccept: true },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/target.md" })]);

		const { container } = render(<FileEditorSidebarPending />);

		expect(container.querySelector(".FileEditorSidebarPending-item-move-label-from")?.textContent).toBe("/recorded.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-move-label-to")?.textContent).toBe("/target.md");
	});

	test("plain edit rows show the Modified caption without the green path", () => {
		useQueryMock.mockReturnValue([makePendingUpdate({ id: "pu_edit", fileNodeId: "node_a", staged: "s", unstaged: "u" })]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);

		const { container } = render(<FileEditorSidebarPending />);

		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Modified");
		expect(container.querySelector(".FileEditorSidebarPending-item-path-text-added")).toBeNull();
	});

	test("mixed row keeps the accordion and shows the from → dest move label", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_mixed",
				fileNodeId: "node_a",
				staged: "s",
				unstaged: "u",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);

		const { container } = render(<FileEditorSidebarPending />);

		const link = screen.getByRole("link", { name: "/a.md → /b.md" });
		expect(link.getAttribute("href")).toContain("view=diff_editor");
		expect(link.getAttribute("title")).toBe("/a.md → /b.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-move-label-from")?.textContent).toBe("/a.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-move-label-to")?.textContent).toBe("/b.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Moved");
		expect(container.querySelector("details")).toBeTruthy();
		expect(screen.getByText("Accept")).toBeTruthy();
	});

	test("move row ignores a declared target that left the destination path", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_move",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "node_docs", destName: "a.md", fromPath: "/a.md", replacesNodeId: "node_dest" },
			}),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md" }),
			makeNode({ id: "node_docs", path: "/docs", kind: "folder" }),
			// The declared target moved away after the proposal; nothing occupies /docs/a.md, so
			// accepting is a plain move and no file gets replaced.
			makeNode({ id: "node_dest", path: "/docs/renamed.md" }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Moved");
	});

	test("move row names the live occupant of the destination over a stale declared target", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_move",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "node_docs", destName: "dest.md", fromPath: "/a.md", replacesNodeId: "node_t" },
			}),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md" }),
			makeNode({ id: "node_docs", path: "/docs", kind: "folder" }),
			// The declared target moved to /elsewhere.md after the proposal while a different
			// active file took /docs/dest.md; accepting archives that occupant, so name it.
			makeNode({ id: "node_t", path: "/elsewhere.md" }),
			makeNode({ id: "node_o", path: "/docs/dest.md" }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Replaces dest.md");
	});

	test("move row onto an occupied destination shows Replaces, a free one shows Moved", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_occupied",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "node_docs", destName: "b.md", fromPath: "/a.md" },
			}),
			makePendingUpdate({
				id: "pu_free",
				fileNodeId: "node_c",
				pendingMove: { destParentId: "node_docs", destName: "free.md", fromPath: "/c.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md" }),
			makeNode({ id: "node_c", path: "/c.md" }),
			makeNode({ id: "node_docs", path: "/docs", kind: "folder" }),
			makeNode({ id: "node_b", path: "/docs/b.md" }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		const captions = Array.from(container.querySelectorAll(".FileEditorSidebarPending-item-caption")).map(
			(element) => element.textContent,
		);
		expect(captions).toEqual(["Replaces b.md", "Moved"]);
	});

	test("folder move row shows Replaces only for an empty folder occupant", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_folder_empty",
				fileNodeId: "node_dir_a",
				pendingMove: { destParentId: "root", destName: "empty-dst", fromPath: "/dir-a" },
			}),
			makePendingUpdate({
				id: "pu_folder_full",
				fileNodeId: "node_dir_b",
				pendingMove: { destParentId: "root", destName: "full-dst", fromPath: "/dir-b" },
			}),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_dir_a", path: "/dir-a", kind: "folder" }),
			makeNode({ id: "node_dir_b", path: "/dir-b", kind: "folder" }),
			makeNode({ id: "node_empty_dst", path: "/empty-dst", kind: "folder" }),
			makeNode({ id: "node_full_dst", path: "/full-dst", kind: "folder" }),
			makeNode({ id: "node_full_child", path: "/full-dst/keep.md", parentId: "node_full_dst" }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		// rename() semantics: only the empty folder occupant is replaced on accept.
		const captions = Array.from(container.querySelectorAll(".FileEditorSidebarPending-item-caption")).map(
			(element) => element.textContent,
		);
		expect(captions).toEqual(["Replaces empty-dst", "Moved"]);
	});

	test("move row onto an occupant with its own pending move shows Moved, not Replaces", () => {
		useQueryMock.mockReturnValue([
			// /a.md → /b.md while /b.md has its own pending move away: accept forces B's move
			// first, so nothing is left at /b.md to replace.
			makePendingUpdate({
				id: "pu_chain_a",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
			makePendingUpdate({
				id: "pu_chain_b",
				fileNodeId: "node_b",
				pendingMove: { destParentId: "root", destName: "c.md", fromPath: "/b.md" },
			}),
			// /d.md → /e.md where /e.md has no pending move: accept still replaces it.
			makePendingUpdate({
				id: "pu_replace",
				fileNodeId: "node_d",
				pendingMove: { destParentId: "root", destName: "e.md", fromPath: "/d.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md" }),
			makeNode({ id: "node_b", path: "/b.md" }),
			makeNode({ id: "node_d", path: "/d.md" }),
			makeNode({ id: "node_e", path: "/e.md" }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		const captions = Array.from(container.querySelectorAll(".FileEditorSidebarPending-item-caption")).map(
			(element) => element.textContent,
		);
		// Rows sort by path: /a.md, /b.md, /d.md.
		expect(captions).toEqual(["Moved", "Moved", "Replaces e.md"]);
	});

	test("mixed replace row shows the Replaces caption instead of Added", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_mixed",
				fileNodeId: "node_a",
				staged: "s",
				unstaged: "u",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md", replacesNodeId: "node_dest" },
				eagerCreated: { committedSequence: 0 },
			}),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md" }),
			makeNode({ id: "node_dest", path: "/b.md" }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Replaces b.md");
		expect(screen.queryByText("Added")).toBeNull();
	});

	test("move Accept applies the pending move with a single mutation", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_move",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept"));

		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(1));
		expect(mutationMock).toHaveBeenCalledWith("apply_file_pending_move", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
		});
		expect(actionMock).not.toHaveBeenCalled();
	});

	test("a move-step conflict stops the mixed chain and surfaces the error", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_mixed",
				fileNodeId: "node_a",
				staged: "STAGED_MD",
				unstaged: "UNSTAGED_MD",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);
		mutationMock.mockReset();
		// Missing or settled rows resolve as no-op `_yay`, so a `_nay` is a real conflict.
		mutationMock.mockResolvedValue({ _nay: { message: "Path already exists" } });

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept"));

		// The failed move stops the chain: no content save, an error toast, no success announcement.
		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(1));
		expect(actionMock).not.toHaveBeenCalled();
		expect(toast.error).toHaveBeenCalledWith("Path already exists");
		expect(screen.getByRole("status").textContent).toBe("");
	});

	test("move Discard issues a single structural discard", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_move",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard"));

		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(1));
		expect(mutationMock).toHaveBeenCalledWith("discard_file_pending_structural", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
		});
		expect(actionMock).not.toHaveBeenCalled();
	});

	test("a structural discard conflict surfaces the error toast", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_move",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);
		mutationMock.mockReset();
		// The discard is idempotent (missing or settled rows resolve `_yay`), so a `_nay` is a
		// real conflict the user must see.
		mutationMock.mockResolvedValue({ _nay: { message: "Discard conflict" } });

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard"));

		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(1));
		expect(toast.error).toHaveBeenCalledWith("Discard conflict");
	});

	test("Discard all counts a structural discard conflict as a failure", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_move",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);
		mutationMock.mockReset();
		mutationMock.mockResolvedValue({ _nay: { message: "Discard conflict" } });

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard all"));

		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Failed to discard 1 of 1 pending changes"));
		expect(mutationMock).toHaveBeenCalledTimes(1);
	});

	test("copy Discard issues only the structural discard, never the content-revert upsert", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_copy",
				fileNodeId: "node_a",
				staged: "STAGED_MD",
				unstaged: "UNSTAGED_MD",
				copiedFrom: { nodeId: "node_src", path: "/source.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/copy.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard"));

		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(1));
		expect(mutationMock).toHaveBeenCalledWith("discard_file_pending_structural", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
		});
		expect(actionMock).not.toHaveBeenCalled();
	});

	test("replace-move Discard issues only the structural discard", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_replace_move",
				fileNodeId: "node_a",
				staged: "STAGED_MD",
				unstaged: "UNSTAGED_MD",
				copiedFrom: { nodeId: "node_src", path: "/source.md", archivesSourceOnAccept: true },
			}),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/target.md" }),
			makeNode({ id: "node_src", path: "/source.md" }),
		]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard"));

		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(1));
		expect(mutationMock).toHaveBeenCalledWith("discard_file_pending_structural", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
		});
		expect(actionMock).not.toHaveBeenCalled();
	});

	test("eagerly created file Discard issues only the structural discard", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_added",
				fileNodeId: "node_a",
				staged: "STAGED_MD",
				unstaged: "UNSTAGED_MD",
				eagerCreated: { committedSequence: 0 },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/new.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard"));

		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(1));
		expect(mutationMock).toHaveBeenCalledWith("discard_file_pending_structural", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
		});
		expect(actionMock).not.toHaveBeenCalled();
	});

	test("copy Accept keeps the existing upsert + save pair", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_copy",
				fileNodeId: "node_a",
				staged: "STAGED_MD",
				unstaged: "UNSTAGED_MD",
				copiedFrom: { nodeId: "node_src", path: "/source.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/copy.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept"));

		await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(2));
		expect(actionMock).toHaveBeenNthCalledWith(1, "upsert_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_copy",
			stagedMarkdown: "UNSTAGED_MD",
			unstagedMarkdown: "UNSTAGED_MD",
		});
		expect(actionMock).toHaveBeenNthCalledWith(2, "save_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_copy",
		});
		expect(mutationMock).not.toHaveBeenCalled();
	});

	test("mixed Accept applies the move first, then accepts and saves the content", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_mixed",
				fileNodeId: "node_a",
				staged: "STAGED_MD",
				unstaged: "UNSTAGED_MD",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept"));

		await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(2));
		expect(mutationMock).toHaveBeenCalledTimes(1);
		expect(mutationMock).toHaveBeenCalledWith("apply_file_pending_move", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
		});
		expect(actionMock).toHaveBeenNthCalledWith(1, "upsert_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_mixed",
			stagedMarkdown: "UNSTAGED_MD",
			unstagedMarkdown: "UNSTAGED_MD",
		});
		expect(actionMock).toHaveBeenNthCalledWith(2, "save_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_mixed",
		});
		expect(mutationMock.mock.invocationCallOrder[0] ?? 0).toBeLessThan(actionMock.mock.invocationCallOrder[0] ?? 0);
	});

	test("mixed Discard reverts the content first, then discards the move", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_mixed",
				fileNodeId: "node_a",
				staged: "STAGED_MD",
				unstaged: "UNSTAGED_MD",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard"));

		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(1));
		expect(actionMock).toHaveBeenCalledTimes(1);
		expect(actionMock).toHaveBeenCalledWith("upsert_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_mixed",
			stagedMarkdown: "STAGED_MD",
			unstagedMarkdown: "STAGED_MD",
		});
		expect(mutationMock).toHaveBeenCalledWith("discard_file_pending_structural", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
		});
		expect(actionMock.mock.invocationCallOrder[0] ?? 0).toBeLessThan(mutationMock.mock.invocationCallOrder[0] ?? 0);
	});

	test("mixed Discard stops before the structural discard when the content revert fails", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_mixed",
				fileNodeId: "node_a",
				staged: "STAGED_MD",
				unstaged: "UNSTAGED_MD",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);
		actionMock.mockReset();
		// A failed revert must not discard the move: a retry needs the row intact.
		actionMock.mockResolvedValue({ _nay: { message: "Revert failed" } });

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard"));

		await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(1));
		expect(mutationMock).not.toHaveBeenCalled();
		expect(toast.error).toHaveBeenCalledWith("Revert failed");
	});

	test("copy and eager mixed Discards run the structural discard and skip the content revert", async () => {
		useQueryMock.mockReturnValue([
			// Mixed rows whose structural discard hard-deletes or fully removes the row: the
			// content revert would hit a dead id, so only the structural discard may run.
			makePendingUpdate({
				id: "pu_mixed_copy",
				fileNodeId: "node_a",
				staged: "STAGED_A",
				unstaged: "UNSTAGED_A",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
				copiedFrom: { nodeId: "node_src", path: "/source.md" },
			}),
			makePendingUpdate({
				id: "pu_mixed_eager",
				fileNodeId: "node_c",
				staged: "STAGED_C",
				unstaged: "UNSTAGED_C",
				pendingMove: { destParentId: "root", destName: "d.md", fromPath: "/c.md" },
				eagerCreated: { committedSequence: 0 },
			}),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md" }),
			makeNode({ id: "node_c", path: "/c.md" }),
		]);

		render(<FileEditorSidebarPending />);
		for (const button of screen.getAllByText("Discard")) {
			fireEvent.click(button);
		}

		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(2));
		expect(mutationMock).toHaveBeenCalledWith("discard_file_pending_structural", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
		});
		expect(mutationMock).toHaveBeenCalledWith("discard_file_pending_structural", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_c",
		});
		expect(actionMock).not.toHaveBeenCalled();
	});

	test("Accept all routes each row through its kind dispatcher", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_content", fileNodeId: "node_a", staged: "STAGED_A", unstaged: "UNSTAGED_A" }),
			makePendingUpdate({
				id: "pu_move",
				fileNodeId: "node_b",
				pendingMove: { destParentId: "root", destName: "c.md", fromPath: "/b.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md" }),
			makeNode({ id: "node_b", path: "/b.md" }),
		]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept all"));

		// content row → upsert + save; move row → one mutation
		await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(2));
		expect(mutationMock).toHaveBeenCalledTimes(1);
		expect(mutationMock).toHaveBeenCalledWith("apply_file_pending_move", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_b",
		});
		expect(actionMock).toHaveBeenCalledWith("upsert_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_content",
			stagedMarkdown: "UNSTAGED_A",
			unstagedMarkdown: "UNSTAGED_A",
		});
		expect(actionMock).toHaveBeenCalledWith("save_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_content",
		});
	});

	test("Accept all runs a folder swap cycle as one sequential unit", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_folder_a",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "root", destName: "fsc-b", fromPath: "/fsc-a" },
			}),
			makePendingUpdate({
				id: "pu_folder_b",
				fileNodeId: "node_b",
				pendingMove: { destParentId: "root", destName: "fsc-a", fromPath: "/fsc-b" },
			}),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/fsc-a", kind: "folder" }),
			makeNode({ id: "node_b", path: "/fsc-b", kind: "folder" }),
		]);
		// Hold the first accept open: the cycle partner must wait for it, not run in parallel.
		let resolveFirst: (value: { _yay: null }) => void = () => {};
		mutationMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveFirst = resolve;
				}),
		);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept all"));

		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(1));
		expect(mutationMock).toHaveBeenNthCalledWith(1, "apply_file_pending_move", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_b",
		});
		// Flush microtasks: the second accept must NOT begin while the first is open.
		await act(async () => {
			await Promise.resolve();
		});
		expect(mutationMock).toHaveBeenCalledTimes(1);

		await act(async () => {
			resolveFirst({ _yay: null });
		});
		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(2));
		expect(mutationMock).toHaveBeenNthCalledWith(2, "apply_file_pending_move", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
		});
		expect(actionMock).not.toHaveBeenCalled();
	});

	test("Discard all routes each row through its kind dispatcher", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_content", fileNodeId: "node_a", staged: "STAGED_A", unstaged: "UNSTAGED_A" }),
			makePendingUpdate({
				id: "pu_copy",
				fileNodeId: "node_b",
				staged: "STAGED_B",
				unstaged: "UNSTAGED_B",
				copiedFrom: { nodeId: "node_src", path: "/source.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md" }),
			makeNode({ id: "node_b", path: "/b.md" }),
		]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard all"));

		// content row → content-revert upsert; copy row → one structural discard mutation
		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(1));
		expect(actionMock).toHaveBeenCalledTimes(1);
		expect(actionMock).toHaveBeenCalledWith("upsert_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_content",
			stagedMarkdown: "STAGED_A",
			unstagedMarkdown: "STAGED_A",
		});
		expect(mutationMock).toHaveBeenCalledWith("discard_file_pending_structural", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_b",
		});
	});
});
