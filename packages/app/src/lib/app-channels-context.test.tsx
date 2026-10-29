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
const router = vi.hoisted(() => ({
	state: {
		location: { pathname: "/files", href: "/files", state: {} },
		resolvedLocation: { pathname: "/files", href: "/files", state: {} },
	},
	history: { subscribe: () => () => {} },
	subscribe: () => () => {},
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => router }));

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
			<output aria-label="Inbox count">{channels.inboxUnreadCount}</output>
			<output aria-label="Thread count">{channels.threadsUnreadCount}</output>
			<output aria-label="Status">{channels.status}</output>
			<output aria-label="Scope">{channels.accessScopeKey}</output>
			<button onClick={channels.retrySummary}>Retry</button>
		</>
	);
}

function Workspace(props: { membershipId: string }) {
	return (
		<ConvexProvider client={client}>
			<AppTenantProvider
				userId={"user_1" as app_convex_Id<"users">}
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
			localQueryResult: () => {
				const result = results.get(key);
				if (result instanceof Error) throw result;
				return result as never;
			},
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
	test("owns only one summary outside Messages and resets counts and access at a tenant change", () => {
		const view = render(<Workspace membershipId="membership_1" />);
		expect([...listeners].filter(([, callbacks]) => callbacks.size).map(([key]) => JSON.parse(key).name)).toEqual([
			"channels_notifications:get_summary",
		]);
		receive(
			getFunctionName(app_convex_api.channels_notifications.get_summary),
			{ membershipId: "membership_1" },
			{ state: "delayed", accessScopeKey: "scope1", mentionChannels: 2, unreadInbox: 750, unreadThreads: 100 },
		);
		expect(document.title, "title must count channels with mentions, not every mention").toBe("(2) Bonobo Senate");
		expect(screen.getByLabelText("Inbox count").textContent).toBe("750");
		expect(screen.getByLabelText("Thread count").textContent).toBe("100");
		view.rerender(<Workspace membershipId="membership_2" />);
		expect(document.title).toBe("Bonobo Senate");
		expect(screen.getByLabelText("Inbox count").textContent).toBe("");
		expect(screen.getByLabelText("Mention channels").textContent).toBe("");
		expect(screen.getByLabelText("Scope").textContent).toBe("");
		expect(
			[...listeners].filter(([, callbacks]) => callbacks.size).map(([key]) => JSON.parse(key).membershipId),
		).toEqual(["membership_2"]);
	});

	test("clears numbers during repair and contains query errors without losing the workspace", async () => {
		render(<Workspace membershipId="membership_1" />);
		const name = getFunctionName(app_convex_api.channels_notifications.get_summary);
		const args = { membershipId: "membership_1" };
		receive(name, args, {
			state: "delayed",
			accessScopeKey: "old",
			mentionChannels: 2,
			unreadInbox: 3,
			unreadThreads: 4,
		});
		receive(name, args, { state: "updating", accessScopeKey: "new" });
		expect(screen.getByLabelText("Inbox count").textContent).toBe("");
		expect(document.title).toBe("Bonobo Senate — Messages updating");
		expect(screen.getByLabelText("Scope").textContent).toBe("new");
		receive(name, args, new Error("query failed"));
		expect(screen.getByLabelText("Status").textContent).toBe("error");
		expect(screen.getByLabelText("Scope").textContent).toBe("");
		expect(document.title).toBe("Bonobo Senate");
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
		receive(name, args, null);
		expect(screen.getByLabelText("Status").textContent).toBe("unavailable");
		receive(name, args, {
			state: "delayed",
			accessScopeKey: "ready",
			mentionChannels: 0,
			unreadInbox: 0,
			unreadThreads: 0,
		});
		expect(screen.getByLabelText("Inbox count").textContent).toBe("0");
	});
});
