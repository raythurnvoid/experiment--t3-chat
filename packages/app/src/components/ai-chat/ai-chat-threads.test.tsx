import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { app_convex_Doc } from "@/lib/app-convex-client.ts";
import { ai_chat_UNREAD_DOT_GRACE_MS } from "@/lib/ai-chat.ts";

// The real module creates a live ConvexReactClient at import (needs VITE_CONVEX_URL).
vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex_api: {},
}));

// Network boundary: the infinite-scroll sentinel and menus do not need a Convex client.
vi.mock("convex/react", () => ({
	useQuery: () => undefined,
}));

vi.mock("@/components/main-app-sidebar-toggle.tsx", () => ({
	MainAppSidebarToggle: function MainAppSidebarToggle() {
		return <div />;
	},
}));

const { AiChatThreads } = await import("./ai-chat-threads.tsx");

function makeThread(args: {
	id: string;
	title: string;
	lastMessageAt?: number;
	readAt?: number;
}): app_convex_Doc<"ai_chat_threads"> {
	return {
		_id: args.id,
		_creationTime: 1,
		organizationId: "organization_1",
		workspaceId: "workspace_1",
		clientGeneratedId: `client_${args.id}`,
		title: args.title,
		archived: false,
		starred: false,
		runtime: "aisdk_5",
		stateId: null,
		createdBy: "user_1",
		updatedBy: "user_1",
		updatedAt: 1,
		lastMessageAt: args.lastMessageAt,
		readAt: args.readAt,
	} as unknown as app_convex_Doc<"ai_chat_threads">;
}

function renderThreads(args: {
	threads: Array<app_convex_Doc<"ai_chat_threads">>;
	selectedThreadId?: string | null;
}) {
	return render(
		<AiChatThreads
			state="expanded"
			paginatedThreads={{
				unarchived: { results: args.threads, status: "Exhausted", isLoading: false, loadMore: () => {} },
				archived: null,
			}}
			streamingTitleByThreadId={{}}
			selectedThreadId={args.selectedThreadId ?? null}
			onSelectThread={() => {}}
			onToggleFavouriteThread={() => {}}
			onBranchThread={() => {}}
			onArchiveThread={() => {}}
			onRemoveOptimisticThread={() => {}}
			onNewChat={() => {}}
		/>,
	);
}

describe("AiChatThreads unread dot", () => {
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	test("shows a dot when the newest message is past the read cursor", () => {
		renderThreads({
			threads: [makeThread({ id: "thread_unread", title: "Unread chat", lastMessageAt: 200, readAt: 100 })],
		});

		expect(screen.getByLabelText("Unread")).toBeTruthy();
	});

	test("shows no dot when the read cursor covers the newest message", () => {
		renderThreads({
			threads: [makeThread({ id: "thread_read", title: "Read chat", lastMessageAt: 100, readAt: 100 })],
		});

		expect(screen.queryByLabelText("Unread")).toBeNull();
	});

	test("shows no dot on the open chat, because it is being read right now", () => {
		renderThreads({
			threads: [makeThread({ id: "thread_open", title: "Open chat", lastMessageAt: 200, readAt: 100 })],
			selectedThreadId: "thread_open",
		});

		expect(screen.queryByLabelText("Unread")).toBeNull();
	});

	test("shows no dot for threads that never received a message", () => {
		renderThreads({
			threads: [makeThread({ id: "thread_empty", title: "Empty chat" })],
		});

		expect(screen.queryByLabelText("Unread")).toBeNull();
	});

	test("delays a fresh dot by the remaining grace, and shows an old one immediately", () => {
		const now = 1_000_000;
		vi.useFakeTimers();
		vi.setSystemTime(now);

		renderThreads({
			threads: [
				makeThread({ id: "thread_fresh", title: "Fresh chat", lastMessageAt: now - 2_000, readAt: 1 }),
				makeThread({ id: "thread_old", title: "Old chat", lastMessageAt: now - 60_000, readAt: 1 }),
			],
		});

		const dots = screen.getAllByLabelText("Unread");
		const delays = dots.map((dot) => (dot as HTMLElement).style.animationDelay);
		// Sorted newest first by the component, so the fresh thread comes first.
		expect(delays[0]).toBe(`${ai_chat_UNREAD_DOT_GRACE_MS - 2_000}ms`);
		expect(delays[1]).toBe("0ms");
	});
});
