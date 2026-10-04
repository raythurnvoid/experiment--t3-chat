import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ChannelsActivity, ChannelsFeedMessage, ChannelsThreads } from "./channels-feed.tsx";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

const mocks = vi.hoisted(() => ({
	channel: null as unknown,
	inbox: { results: [] as unknown[], status: "Exhausted", loadMore: vi.fn() },
	threads: { results: [] as unknown[], status: "Exhausted", loadMore: vi.fn() },
}));
vi.mock("convex/react", async (importOriginal) => ({
	...(await importOriginal<typeof import("convex/react")>()),
	useQuery: () => mocks.channel,
}));
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({ membershipId: "member", organizationName: "team", workspaceName: "home" }),
	},
}));
vi.mock("@/components/app-auth.tsx", () => ({ AppAuthProvider: { useAuthenticated: () => ({ userId: "viewer" }) } }));
vi.mock("./channels-people.ts", () => ({
	useChannelsPeople: () => ({ people: [] }),
	useChannelsDirectName: () => "Ana",
}));
vi.mock("./channels-message.tsx", () => ({
	ChannelsMessageContent: (props: { row: { message: { body: string } } }) => <p>{props.row.message.body}</p>,
}));
vi.mock("@/lib/app-channels-context.tsx", () => ({
	AppChannelsProvider: {
		useContext: () => ({
			inbox: mocks.inbox,
			threads: mocks.threads,
			inboxUnreadCount: 1,
			threadsUnreadCount: 1,
			inboxHasMore: mocks.inbox.status === "CanLoadMore",
			threadsHasMore: mocks.threads.status === "CanLoadMore",
		}),
	},
}));
vi.mock("@tanstack/react-router", () => ({
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
});
afterEach(cleanup);

describe("ChannelsFeedMessage", () => {
	test("opens post roots in their thread and removes the whole preview after access loss", () => {
		const row = message();
		mocks.channel = { channel: { kind: "file", layout: "posts" }, file: { path: "/notes.md" } };
		const view = render(<ChannelsFeedMessage row={row} people={[]} unread />);
		expect(screen.getByRole("link", { name: "Open context" }).getAttribute("href")).toContain("thread=root");
		expect(screen.getByTitle("Unread")).toBeTruthy();
		mocks.channel = null;
		view.rerender(<ChannelsFeedMessage row={row} people={[]} unread />);
		expect(screen.queryByText("Checked preview"), "lost channel access must remove the cached preview").toBeNull();
		expect(screen.queryByText("/notes.md")).toBeNull();
	});
});

describe("ChannelsActivity", () => {
	test("continues an empty readable page and uses its inbox root in the context link", () => {
		mocks.inbox.status = "CanLoadMore";
		const view = render(<ChannelsActivity compact />);
		fireEvent.click(screen.getByRole("button", { name: "Load more activity" }));
		expect(mocks.inbox.loadMore).toHaveBeenCalledWith(50);
		mocks.inbox.results = [
			{ item: { _id: "item", kind: "mention", threadRootId: "post" }, message: message(), unread: true },
		];
		view.rerender(<ChannelsActivity compact key="loaded" />);
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
		fireEvent.click(screen.getByRole("button", { name: "Load more threads" }));
		expect(mocks.threads.loadMore).toHaveBeenCalledWith(50);
	});
});
