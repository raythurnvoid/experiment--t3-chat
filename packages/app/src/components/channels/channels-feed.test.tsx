import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ChannelsActivity, ChannelsFeedMessage, ChannelsThreads } from "./channels-feed.tsx";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { getFunctionName } from "convex/server";

const mocks = vi.hoisted(() => {
	const listeners = new Set<() => void>();
	return {
		channel: null as unknown,
		reads: vi.fn(),
		inbox: { results: [] as unknown[], status: "Exhausted", loadMore: vi.fn() },
		threads: { results: [] as unknown[], status: "Exhausted", loadMore: vi.fn() },
		inboxVersion: 0,
		listeners,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
});
vi.mock("convex/react", async (importOriginal) => {
	const { useSyncExternalStore } = await import("react");
	return {
		...(await importOriginal<typeof import("convex/react")>()),
		useQuery: () => {
			mocks.reads();
			return mocks.channel;
		},
		usePaginatedQuery: (query: Parameters<typeof getFunctionName>[0]) => {
			// Subscribe like a live query, so `set_inbox_results` renders the mounted feed again.
			useSyncExternalStore(mocks.subscribe, () => mocks.inboxVersion);
			return getFunctionName(query).includes("list_my_inbox") ? mocks.inbox : mocks.threads;
		},
	};
});

function set_inbox_results(results: unknown[]) {
	mocks.inbox.results = results;
	mocks.inboxVersion += 1;
	act(() => mocks.listeners.forEach((listener) => listener()));
}

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({ membershipId: "member", organizationName: "team", workspaceName: "home" }),
	},
}));
vi.mock("@/components/app-auth.tsx", () => ({ AppAuthProvider: { useAuthenticated: () => ({ userId: "viewer" }) } }));
vi.mock("./channels-people.ts", () => ({
	useChannelsDirectName: () => "Ana",
}));
vi.mock("./channels-message.tsx", () => ({
	ChannelsMessageContent: (props: { row: { message: { body: string } } }) => <p>{props.row.message.body}</p>,
}));
vi.mock("@/lib/app-channels-context.tsx", () => ({
	AppChannelsProvider: {
		useContext: () => ({
			inboxUnreadCount: 1,
			threadsUnreadCount: 1,
			status: "delayed",
			followLink: () => {},
		}),
	},
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	Link: (props: {
		children: ReactNode;
		params: { channelId?: string };
		search?: { message?: string; thread?: string };
		onClick?: () => void;
	}) => (
		<a
			href={`/messages/${props.params.channelId ?? "activity"}?${new URLSearchParams(props.search as Record<string, string>)}`}
			onClick={props.onClick}
		>
			{props.children}
		</a>
	),
}));

function message(): ComponentProps<typeof ChannelsFeedMessage>["row"] {
	return {
		message: {
			_id: "root" as app_convex_Id<"channels_messages">,
			_creationTime: 1,
			organizationId: "org" as app_convex_Id<"organizations">,
			workspaceId: "ws" as app_convex_Id<"organizations_workspaces">,
			channelId: "channel" as app_convex_Id<"channels">,
			authorUserId: "author" as app_convex_Id<"users">,
			channelSequence: 1,
			mainSequence: 1,
			threadSequence: null,
			threadRootId: null,
			replyTo: null,
			body: "Checked preview",
			mentionUserIds: [],
			fileMentionIds: [],
			fileQuotes: [],
			attachments: [],
			hasAttachments: false,
			clientMessageId: "client",
			revision: 0,
			editedAt: null,
			deletedAt: null,
		},
		authorName: "Ana",
		mentionNames: [],
		fileMentions: [],
		attachments: [],
		replyPreview: null,
		thread: null,
	};
}

beforeEach(() => {
	mocks.channel = { channel: { kind: "public", name: "general", layout: "messages" } };
	mocks.inbox.results = [];
	mocks.inbox.status = "Exhausted";
	mocks.threads.results = [];
	mocks.threads.status = "Exhausted";
	mocks.inbox.loadMore.mockClear();
	mocks.threads.loadMore.mockClear();
	mocks.reads.mockClear();
});
afterEach(cleanup);

describe("ChannelsFeedMessage", () => {
	test("opens post roots in their thread and removes the whole preview after access loss", () => {
		const row = message();
		mocks.channel = { channel: { kind: "file", layout: "posts" }, file: { path: "/notes.md" } };
		const view = render(<ChannelsFeedMessage row={row} unread />);
		expect(screen.getByRole("link", { name: "Open context" }).getAttribute("href")).toContain("thread=root");
		expect(screen.getByTitle("Unread")).toBeTruthy();
		mocks.channel = null;
		// The mock query does not notify, so render a copy of the row, as a live query update would.
		view.rerender(<ChannelsFeedMessage row={{ ...row }} unread />);
		expect(screen.queryByText("Checked preview"), "lost channel access must remove the cached preview").toBeNull();
		expect(screen.queryByText("/notes.md")).toBeNull();
	});
});

describe("ChannelsActivity", () => {
	test("keeps a locked receipt without previews or child queries and repairs its focus", () => {
		mocks.inbox.results = [
			{
				state: "readable",
				item: { _id: "receipt", kind: "mention", threadRootId: null },
				message: message(),
				unread: true,
			},
		];
		render(<ChannelsActivity />);
		screen.getByRole("link", { name: "Open context" }).focus();
		expect(mocks.reads).toHaveBeenCalledTimes(1);
		set_inbox_results([{ state: "locked", inboxId: "receipt", kind: "mention" }]);
		expect(screen.queryByText("Checked preview")).toBeNull();
		expect(screen.queryByRole("link", { name: "Open context" })).toBeNull();
		expect(mocks.reads).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "No access" }));
		set_inbox_results([{ state: "unavailable", inboxId: "receipt", kind: "mention" }]);
		expect(screen.getByRole("button", { name: "Unavailable" })).toBeTruthy();
		expect(mocks.reads).toHaveBeenCalledTimes(1);
	});
	test("continues an empty readable page and uses its inbox root in the context link", () => {
		mocks.inbox.status = "CanLoadMore";
		const view = render(<ChannelsActivity />);
		fireEvent.click(screen.getByRole("button", { name: "Show more activity" }));
		expect(mocks.inbox.loadMore).toHaveBeenCalledWith(50);
		mocks.inbox.results = [
			{
				state: "readable",
				item: { _id: "item", kind: "mention", threadRootId: "post" },
				message: message(),
				unread: true,
			},
		];
		view.rerender(<ChannelsActivity key="loaded" />);
		expect(screen.getByRole("link", { name: "Open context" }).getAttribute("href")).toContain("thread=post");
		expect(screen.getByText("Mention")).toBeTruthy();
	});
});

describe("ChannelsThreads", () => {
	test("shows loading and keeps continuation on an empty page", () => {
		mocks.threads.status = "LoadingFirstPage";
		const view = render(<ChannelsThreads />);
		expect(screen.getByText("Loading threads…")).toBeTruthy();
		mocks.threads.status = "CanLoadMore";
		view.rerender(<ChannelsThreads key="next" />);
		fireEvent.click(screen.getByRole("button", { name: "Show more threads" }));
		expect(mocks.threads.loadMore).toHaveBeenCalledWith(50);
	});
});
