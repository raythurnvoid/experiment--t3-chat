import "@/app.css";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { getFunctionName } from "convex/server";
import { Channels } from "./channels.tsx";
import { ChannelsSearchView } from "./channels-search.tsx";
import {
	AppChannelsProvider,
	channels_navigation_state,
	type ChannelsNavigationMode,
} from "@/lib/app-channels-context.tsx";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

const model = vi.hoisted(() => ({
	id: "aaaaaaaaaaaaaaaaaaaa",
	version: 0,
	revision: 1,
	hidden: true,
	channelReady: true,
	listeners: new Set<() => void>(),
	mutate: vi.fn(),
	delayNavigation: false,
	resumeNavigation: null as (() => void) | null,
	activePages: new Map<string, number>(),
	search: vi.fn(),
	deniedFile: false,
	locked: false,
}));
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: { useContext: () => ({ membershipId: "member", organizationName: "qa", workspaceName: "home" }) },
}));
vi.mock("@/components/app-auth.tsx", () => ({ AppAuthProvider: { useAuthenticated: () => ({ userId: "viewer" }) } }));
vi.mock("@/components/app-hotkeys.tsx", () => ({ AppHotkeysProvider: { useHotkey: () => {} } }));
vi.mock("./channels-people.ts", () => ({ useChannelsDirectName: () => "Ana", useChannelsProfiles: () => [] }));
vi.mock("./channels-conversation.tsx", () => ({ ChannelsConversation: () => <p>Selected conversation</p> }));
vi.mock("@/lib/storage.ts", async (importOriginal) => {
	const { useState } = await import("react");
	return {
		...(await importOriginal<typeof import("@/lib/storage.ts")>()),
		useAppLocalStorageStateValue: (key: string) =>
			useState(key.includes("channels_open") ? true : key.includes("sidebar_width") ? 240 : null),
	};
});
vi.mock("@/lib/app-convex-client.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/app-convex-client.ts")>()),
	app_convex: { mutation: (...args: unknown[]) => model.mutate(...args) },
}));
vi.mock("convex/react", async (importOriginal) => {
	const { useEffect, useSyncExternalStore } = await import("react");
	const channel = { _id: model.id, kind: "direct", participantUserIds: ["viewer", "ana"], createdBy: "viewer" };
	const empty: never[] = [];
	const direct = [{ state: "readable", memberId: "channel-member", channel }];
	const fileChannel = { _id: "bbbbbbbbbbbbbbbbbbbb", kind: "file", fileNodeId: "file-node", createdBy: "viewer" };
	const files = [{ state: "readable", memberId: "file-member", channel: fileChannel }];
	const locked = [{ state: "locked", memberId: "locked-member", kind: "direct" }];
	const people = [{ userId: "ana", displayName: "Ana", avatarUrl: null }];
	function useVersion() {
		useSyncExternalStore(
			(callback) => {
				model.listeners.add(callback);
				return () => model.listeners.delete(callback);
			},
			() => model.version,
		);
	}
	return {
		...(await importOriginal<typeof import("convex/react")>()),
		useConvexConnectionState: () => ({ isWebSocketConnected: true }),
		useQueries: () => ({
			summary: { state: "delayed", accessScopeKey: "access", mentionChannels: 0, unreadInbox: 0, unreadThreads: 0 },
		}),
		useQuery: (query: Parameters<typeof getFunctionName>[0], args: unknown) => {
			useVersion();
			if (args === "skip") return undefined;
			if (
				getFunctionName(query).endsWith(":get_channel") &&
				typeof args === "object" &&
				args !== null &&
				"channelId" in args &&
				args.channelId === fileChannel._id
			)
				return model.deniedFile ? null : { channel: fileChannel, file: { name: "notes.md", path: "/notes.md" } };
			if (getFunctionName(query).endsWith(":get_channel"))
				return model.channelReady ? { channel, canManage: false, canPost: true } : undefined;
			if (getFunctionName(query).endsWith(":get_channel_state"))
				return {
					activity: { lastChannelSequence: 1 },
					member: {
						_id: "channel-member",
						userId: "viewer",
						level: "member",
						notify: "all",
						starred: false,
						hidden: model.hidden,
						visibilityRevision: model.revision,
					},
					readSequence: 1,
					unread: false,
					mentionCount: 0,
				};
			return null;
		},
		usePaginatedQuery: (
			query: Parameters<typeof getFunctionName>[0],
			args: { section?: string; kind?: string } | "skip",
			options: { initialNumItems: number },
		) => {
			useVersion();
			const section = args !== "skip" ? args.section : undefined;
			useEffect(() => {
				if (!section) return;
				expect(options.initialNumItems).toBe(50);
				model.activePages.set(section, (model.activePages.get(section) ?? 0) + 1);
				return () => {
					model.activePages.set(section, model.activePages.get(section)! - 1);
				};
			}, [section, options.initialNumItems]);
			return {
				results:
					model.locked &&
					args !== "skip" &&
					(getFunctionName(query).includes("list_my_channel_kind") ||
						getFunctionName(query).includes("search_my_private_channels") ||
						args.section === "direct")
						? locked
						: args !== "skip" && getFunctionName(query).includes("list_my_channel_kind")
							? args.kind === "direct"
								? direct
								: files
							: args !== "skip" && getFunctionName(query).includes("search_workspace_members")
								? people
								: args !== "skip" && args.section === "direct" && !model.hidden
									? direct
									: empty,
				status: "Exhausted",
				loadMore: () => {},
			};
		},
	};
});

function changed() {
	model.version++;
	model.listeners.forEach((callback) => callback());
}
function App() {
	return (
		<AppChannelsProvider membershipId={"member" as app_convex_Id<"organizations_workspaces_users">}>
			<div style={{ width: 1200, height: 800 }}>
				<Outlet />
			</div>
		</AppChannelsProvider>
	);
}
const root = createRootRoute({ component: App });
const route = createRoute({
	getParentRoute: () => root,
	path: "/w/qa/home/messages/$channelId",
	component: Conversation,
});
const other = createRoute({ getParentRoute: () => root, path: "/other", component: () => <p>Other page</p> });
const searchRoute = createRoute({
	getParentRoute: () => root,
	path: "/search",
	component: () => <ChannelsSearchView filters={{ q: "words" }} onSearch={model.search} />,
});
let router: ReturnType<typeof makeRouter>;
function makeRouter(path: string) {
	return createRouter({
		routeTree: root.addChildren([route, other, searchRoute]),
		history: createMemoryHistory({ initialEntries: [path] }),
	});
}
function navigate(mode: ChannelsNavigationMode = "open") {
	return router.navigate({ href: `/w/qa/home/messages/${model.id}`, state: channels_navigation_state(mode) });
}
function Conversation() {
	const { channelId } = route.useParams();
	return (
		<Channels
			channelId={channelId}
			search={{}}
			onNavigate={(_id, _search, mode = "open") => {
				if (model.delayNavigation && mode === "alreadyOpened")
					model.resumeNavigation = () => {
						void navigate(mode);
					};
				else void navigate(mode);
			}}
		/>
	);
}
const opens = () =>
	model.mutate.mock.calls.filter(([query]) => getFunctionName(query).endsWith(":open_direct_channel_by_id"));
async function closeConversation() {
	fireEvent.click(await screen.findByRole("button", { name: "Actions for Ana" }));
	fireEvent.click(await screen.findByRole("menuitem", { name: "Close conversation" }));
	await waitFor(() => expect(model.hidden).toBe(true));
}
beforeEach(() => {
	model.version = 0;
	model.revision = 1;
	model.hidden = true;
	model.channelReady = true;
	model.delayNavigation = false;
	model.resumeNavigation = null;
	model.mutate.mockReset();
	model.activePages.clear();
	model.search.mockClear();
	model.deniedFile = false;
	model.locked = false;
	model.mutate.mockImplementation(async (query, args) => {
		const name = getFunctionName(query);
		if (name.endsWith(":hide_direct_channel")) {
			model.hidden = true;
			model.revision++;
			changed();
			return { _yay: null };
		}
		if (name.endsWith(":open_direct_channel")) {
			model.hidden = false;
			model.revision++;
			changed();
			return { _yay: { channelId: model.id } };
		}
		if (name.endsWith(":open_direct_channel_by_id")) {
			const opened = args.expectedVisibilityRevision === model.revision;
			if (opened) {
				model.hidden = false;
				model.revision++;
				changed();
			}
			return { _yay: { opened } };
		}
		return { _yay: null };
	});
});
afterEach(() => {
	cleanup();
	model.listeners.clear();
	vi.restoreAllMocks();
});

test("real Router opens first and same-URL choices once, but never replays after Close or invalidate", async () => {
	router = makeRouter(`/w/qa/home/messages/${model.id}`);
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(opens()).toHaveLength(1));
	await closeConversation();
	await act(async () => {
		await router.invalidate();
		await router.load();
		await router.preloadRoute({ to: "/w/qa/home/messages/$channelId", params: { channelId: model.id } });
	});
	expect(opens()).toHaveLength(1);
	expect(model.hidden).toBe(true);
	await act(async () => {
		await navigate();
	});
	await waitFor(() => expect(opens()).toHaveLength(2));
	expect(model.hidden).toBe(false);
	await act(async () => {
		await router.navigate({ href: "/other" });
		router.history.back();
	});
	await waitFor(() => expect(opens()).toHaveLength(3));
	await closeConversation();
	await act(async () => {
		router.history.forward();
	});
	await screen.findByText("Other page");
	await act(async () => {
		router.history.go(-1);
	});
	await waitFor(() => expect(opens()).toHaveLength(4));
});

test("Close cancels an arrival waiting for selected access and passive entries open on Back", async () => {
	model.hidden = false;
	model.channelReady = false;
	router = makeRouter(`/w/qa/home/messages/${model.id}`);
	render(<RouterProvider router={router} />);
	await closeConversation();
	act(() => {
		model.channelReady = true;
		changed();
	});
	await screen.findByText("Selected conversation");
	expect(opens()).toHaveLength(0);
	await act(async () => {
		await navigate("passive");
	});
	expect(opens()).toHaveLength(0);
	await act(async () => {
		await router.navigate({ href: "/other" });
		router.history.back();
	});
	await waitFor(() => expect(opens()).toHaveLength(1));
});

test("Message someone continuation cannot reopen a DM closed after its first mutation", async () => {
	model.delayNavigation = true;
	router = makeRouter(`/w/qa/home/messages/${model.id}`);
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(opens()).toHaveLength(1));
	fireEvent.click(await screen.findByRole("button", { name: "Message someone" }));
	fireEvent.click(await screen.findByRole("checkbox", { name: "Ana" }));
	fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
	await waitFor(() => expect(model.resumeNavigation).not.toBeNull());
	await closeConversation();
	await act(async () => {
		model.resumeNavigation!();
	});
	await waitFor(() => expect(router.state.status).toBe("idle"));
	expect(opens()).toHaveLength(1);
	expect(model.hidden).toBe(true);
	await act(async () => {
		await navigate();
	});
	await waitFor(() => expect(opens()).toHaveLength(2));
});

test("Close wins after an open captured a revision, with no fresh-revision retry", async () => {
	model.hidden = false;
	const resume = Promise.withResolvers<void>();
	const mutate = model.mutate.getMockImplementation()!;
	model.mutate.mockImplementation(async (query, args) => {
		if (getFunctionName(query).endsWith(":open_direct_channel_by_id")) await resume.promise;
		return mutate(query, args);
	});
	router = makeRouter(`/w/qa/home/messages/${model.id}`);
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(opens()).toHaveLength(1));
	expect(opens()[0]![1].expectedVisibilityRevision).toBe(1);
	await closeConversation();
	await act(async () => {
		resume.resolve();
		await resume.promise;
	});
	expect(model.hidden).toBe(true);
	await act(async () => {
		await router.invalidate();
	});
	expect(opens()).toHaveLength(1);
});

test("collapse, hiding and the drawer keep only the visible section owners mounted", async () => {
	model.hidden = false;
	router = makeRouter(`/w/qa/home/messages/${model.id}`);
	const view = render(<RouterProvider router={router} />);
	await waitFor(() => expect([...model.activePages.values()]).toEqual([1, 1, 1, 1]));
	fireEvent.click(screen.getByRole("button", { name: "Starred" }));
	expect(model.activePages.get("starred")).toBe(0);
	fireEvent.click(screen.getByRole("button", { name: "Hide channels" }));
	expect([...model.activePages.values()]).toEqual([0, 0, 0, 0]);
	// The selected conversation stays mounted when its navigation rows are absent.
	expect(screen.getByText("Selected conversation")).toBeTruthy();
	const shell = view.container.querySelector<HTMLElement>('[style*="1200px"]')!;
	shell.style.width = "700px";
	await waitFor(() => expect(view.container.querySelector('[data-layout="single"]')).toBeTruthy());
	// The test conversation replaces its header, so open the drawer through the shell's hotkey-free empty view.
	act(() => {
		model.channelReady = false;
		changed();
	});
	fireEvent.click(await screen.findByRole("button", { name: "Open channels" }));
	await waitFor(() => expect([...model.activePages.values()]).toEqual([0, 1, 1, 1]));
	shell.style.width = "1200px";
	await waitFor(() => expect(view.container.querySelector('[data-layout="wide"]')).toBeTruthy());
	expect(screen.getAllByRole("complementary", { name: "Channels" })).toHaveLength(1);
	expect([...model.activePages.values()]).toEqual([0, 1, 1, 1]);
	fireEvent.click(screen.getByRole("button", { name: "Hide channels" }));
	await waitFor(() => expect([...model.activePages.values()]).toEqual([0, 0, 0, 0]));
});

test("message search keeps closed DM and file choices and never opens them", async () => {
	router = makeRouter("/search");
	render(<RouterProvider router={router} />);
	fireEvent.click(await screen.findByRole("button", { name: "Filters" }));
	fireEvent.click(await screen.findByRole("combobox", { name: "Channel" }));
	fireEvent.click(await screen.findByRole("button", { name: "Direct messages" }));
	fireEvent.click(await screen.findByRole("option", { name: "Ana" }));
	expect(model.hidden).toBe(true);
	expect(opens()).toHaveLength(0);
	fireEvent.click(await screen.findByRole("combobox", { name: "Channel" }));
	fireEvent.click(await screen.findByRole("button", { name: "Files" }));
	fireEvent.click(await screen.findByRole("option", { name: "/notes.md" }));
	act(() => {
		model.deniedFile = true;
		changed();
	});
	await waitFor(() => expect(screen.getByRole("combobox", { name: "Channel" }).textContent).toContain("Unavailable"));
	fireEvent.click(screen.getByRole("button", { name: "Search" }));
	expect(model.search).toHaveBeenCalledWith(expect.objectContaining({ channel: "bbbbbbbbbbbbbbbbbbbb" }));
	expect(opens()).toHaveLength(0);
});

test("locked sidebar and filter rows keep keyboard access and refuse in place", async () => {
	model.locked = true;
	router = makeRouter(`/w/qa/home/messages/${model.id}`);
	render(<RouterProvider router={router} />);
	const locked = await screen.findByRole("button", { name: "No access" });
	locked.focus();
	await userEvent.keyboard("{Enter}");
	expect(locked.closest("[data-member-id]")?.textContent).toContain("Permission denied");
	expect(router.state.location.pathname).toBe(`/w/qa/home/messages/${model.id}`);
	await act(async () => {
		await router.navigate({ href: "/search" });
	});
	fireEvent.click(await screen.findByRole("button", { name: "Filters" }));
	fireEvent.click(await screen.findByRole("combobox", { name: "Channel" }));
	for (const kind of ["Channels", "Direct messages", "Files"]) {
		fireEvent.click(await screen.findByRole("button", { name: kind }));
		const option = await screen.findByRole("option", { name: "No access" });
		const keyboardOwner =
			kind === "Channels"
				? screen.getByRole("combobox", { name: "Find channel" })
				: option.closest<HTMLElement>(".MySelectPopover")!;
		keyboardOwner.focus();
		await userEvent.keyboard("{ArrowDown}{End}");
		expect(option.hasAttribute("data-active-item"), kind).toBe(true);
		await userEvent.keyboard("{Enter}");
		expect(screen.getByRole("status").textContent).toBe("Permission denied");
		expect(screen.getByRole("combobox", { name: "Channel" }).textContent).toContain("All readable channels");
		expect(screen.getByRole("option", { name: "No access" })).toBeTruthy();
	}
});
