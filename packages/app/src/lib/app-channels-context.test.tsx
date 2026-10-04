import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AppChannelsProvider } from "./app-channels-context.tsx";
import { AppTenantProvider } from "./app-tenant-context.tsx";
import { app_convex_api, type app_convex_Id } from "./app-convex-client.ts";

vi.mock("@/lib/files-tree-context.tsx", () => ({
	FilesTreeProvider: (props: { children: ReactNode }) => props.children,
}));
vi.mock("@/lib/app-activities-context.tsx", () => ({
	AppActivitiesProvider: (props: { children: ReactNode }) => props.children,
}));
vi.mock("@/components/files/files-clipboard.tsx", () => ({
	FilesClipboardProvider: (props: { children: ReactNode }) => props.children,
}));

const results = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();
let client: ConvexReactClient;

function watch_key(name: string, args: Record<string, unknown>) {
	const { paginationOpts, ...rest } = args as { paginationOpts?: { cursor: string | null; endCursor?: string | null } };
	return JSON.stringify({
		name,
		...Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b))),
		cursor: paginationOpts?.cursor,
		endCursor: paginationOpts?.endCursor,
	});
}

function receive(name: string, args: Record<string, unknown>, result: unknown) {
	act(() => {
		const key = watch_key(name, args);
		results.set(key, result);
		listeners.get(key)?.forEach((callback) => callback());
	});
}

function Consumer() {
	const channels = AppChannelsProvider.useContext();
	return (
		<>
			<output aria-label="Mention channels">{channels.unreadMentions}</output>
			<output aria-label="Inbox count">
				{channels.inboxUnreadCount}
				{channels.inboxHasMore ? "+" : ""}
			</output>
			<output aria-label="Thread count">
				{channels.threadsUnreadCount}
				{channels.threadsHasMore ? "+" : ""}
			</output>
			<button onClick={() => channels.inbox.loadMore(50)}>More inbox</button>
		</>
	);
}

function Workspace(props: { membershipId: string }) {
	return (
		<ConvexProvider client={client}>
			<AppTenantProvider
				membershipId={props.membershipId as app_convex_Id<"organizations_workspaces_users">}
				workspaceId={"workspace" as app_convex_Id<"organizations_workspaces">}
				workspaceName="home"
				organizationId={"organization" as app_convex_Id<"organizations">}
				organizationName="team"
			>
				<Consumer />
			</AppTenantProvider>
		</ConvexProvider>
	);
}

beforeEach(() => {
	results.clear();
	listeners.clear();
	client = new ConvexReactClient("https://channels-test.convex.cloud");
	vi.spyOn(client, "watchQuery").mockImplementation((...[query, args = {}]) => {
		const key = watch_key(getFunctionName(query), args as Record<string, unknown>);
		return {
			onUpdate: (callback) => {
				const callbacks = listeners.get(key) ?? new Set<() => void>();
				callbacks.add(callback);
				listeners.set(key, callbacks);
				return () => callbacks.delete(callback);
			},
			localQueryResult: () => results.get(key) as never,
			localQueryLogs: () => undefined,
			journal: () => undefined,
		};
	});
});
afterEach(async () => {
	cleanup();
	await client.close();
	vi.restoreAllMocks();
});

describe("AppChannelsProvider", () => {
	test("shares loaded counts and the title outside Messages, then resets at a tenant change", () => {
		const view = render(<Workspace membershipId="membership_1" />);
		const args = { membershipId: "membership_1", paginationOpts: { cursor: null } };
		receive(getFunctionName(app_convex_api.channels.list_my_channels), args, {
			page: [{ _id: "channel_1" }, { _id: "channel_2" }],
			isDone: true,
			continueCursor: "",
		});
		for (const [channelId, mentionCount] of [
			["channel_1", 3],
			["channel_2", 1],
		] as const)
			receive(
				getFunctionName(app_convex_api.channels.get_channel_state),
				{ membershipId: "membership_1", channelId },
				{ mentionCount },
			);
		receive(getFunctionName(app_convex_api.channels_messages.list_my_inbox), args, {
			page: [{ unread: true }, { unread: false }],
			isDone: false,
			continueCursor: "next",
		});
		receive(getFunctionName(app_convex_api.channels_messages.list_my_threads), args, {
			page: [{ unread: true }],
			isDone: true,
			continueCursor: "",
		});
		expect(document.title, "title must count channels with mentions, not every mention").toBe("(2) Press");
		expect(screen.getByLabelText("Inbox count").textContent).toBe("1+");
		expect(screen.getByLabelText("Thread count").textContent).toBe("1");
		view.rerender(<Workspace membershipId="membership_2" />);
		expect(document.title).toBe("Press");
		expect(screen.getByLabelText("Inbox count").textContent).toBe("0");
		expect(screen.getByLabelText("Mention channels").textContent).toBe("0");
	});

	test("continues an empty inbox page with a cursor", () => {
		render(<Workspace membershipId="membership_1" />);
		receive(
			getFunctionName(app_convex_api.channels_messages.list_my_inbox),
			{ membershipId: "membership_1", paginationOpts: { cursor: null } },
			{ page: [], isDone: false, continueCursor: "next" },
		);
		expect(screen.getByLabelText("Inbox count").textContent).toBe("0+");
		fireEvent.click(screen.getByRole("button", { name: "More inbox" }));
		expect(
			[...listeners.keys()].some((key) => key.includes('"cursor":"next"')),
			"empty page must keep its continuation query",
		).toBe(true);
	});
});
