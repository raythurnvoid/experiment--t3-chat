import "@/app.css";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { ChannelsConversation } from "./channels-conversation.tsx";
import type { ChannelsSearch } from "./channels.tsx";
import type { ChannelsMessage } from "./channels-message-window.ts";
import { app_local_storage_set_value } from "@/lib/storage.ts";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

vi.mock("convex/react", async (importOriginal) => ({
	...(await importOriginal<typeof import("convex/react")>()),
	useQuery: (query: FunctionReference<"query">, args: unknown) => {
		if (args === "skip") return undefined;
		const name = getFunctionName(query);
		if (name.endsWith("get_thread_by_root")) return { root: message(1) };
		if (name.endsWith("get_thread_state")) return { follower: null, unreadCount: 0 };
		if (name.endsWith("list_message_reactions")) return [];
		return { displayName: "Ana", avatarUrl: null };
	},
	usePaginatedQuery: () => ({ results: [], status: "Exhausted", isLoading: false, loadMore: vi.fn() }),
	useConvexConnectionState: () => ({ isWebSocketConnected: true }),
}));
vi.mock("@/lib/app-convex-client.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/app-convex-client.ts")>()),
	app_convex: { mutation: vi.fn(async () => ({ _yay: null })) },
}));
vi.mock("@/components/app-auth.tsx", () => ({ AppAuthProvider: { useAuthenticated: () => ({ userId: "author" }) } }));
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({
			membershipId: "membership",
			organizationId: "org",
			workspaceId: "workspace",
			organizationName: "qa",
			workspaceName: "home",
		}),
	},
}));
vi.mock("@/lib/files-tree-context.tsx", () => ({ FilesTreeProvider: { useFullList: () => undefined } }));
vi.mock("./channels-people.ts", () => ({ useChannelsDirectName: () => "Ana", useChannelsMentionPeople: () => [] }));
vi.mock("./channels-message-window.ts", () => ({
	useChannelsMessageWindow: (props: { target: { rootMessageId?: string } }) => {
		const [editingMessage, setEditingMessage] = useState<ChannelsMessage | null>(null);
		return {
			rows: props.target.rootMessageId ? replies : rows,
			loading: false,
			error: null,
			atLatest: true,
			hasOlder: false,
			hasNewer: false,
			newCount: 0,
			editingMessage,
			setEditingMessage,
			older: vi.fn(),
			newer: vi.fn(),
			latest: vi.fn(),
			jump: vi.fn(),
		};
	},
}));

function message(sequence: number, reply = false): ChannelsMessage {
	return {
		message: {
			_id: `message-${sequence}` as app_convex_Id<"channels_messages">,
			_creationTime: new Date(2026, 9, 4, 10, 42).getTime() + sequence * 1000,
			channelId: "channel" as app_convex_Id<"channels">,
			organizationId: "org" as app_convex_Id<"organizations">,
			workspaceId: "workspace" as app_convex_Id<"organizations_workspaces">,
			authorUserId: "author" as app_convex_Id<"users">,
			channelSequence: sequence,
			mainSequence: reply ? null : sequence,
			threadSequence: reply ? sequence : null,
			threadRootId: reply ? ("message-1" as app_convex_Id<"channels_messages">) : null,
			replyTo: null,
			body: `Saved message ${sequence}. ${"A longer line of text. ".repeat(6)}`,
			mentionUserIds: [],
			fileMentionIds: [],
			fileQuotes: [],
			attachments: [],
			hasAttachments: false,
			clientMessageId: String(sequence),
			revision: 1,
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
const rows = Array.from({ length: 50 }, (_, index) => message(index + 1));
const replies = [message(51, true), message(52, true)];

function fixture(): Pick<ComponentProps<typeof ChannelsConversation>, "channel" | "state"> {
	return {
		channel: {
			channel: {
				_id: "channel" as app_convex_Id<"channels">,
				_creationTime: 1,
				organizationId: "org" as app_convex_Id<"organizations">,
				workspaceId: "workspace" as app_convex_Id<"organizations_workspaces">,
				kind: "public",
				name: "general",
				topic: "Topic in details",
				layout: "messages",
				resolvableThreads: true,
				createdBy: "author" as app_convex_Id<"users">,
				createdAt: 1,
				archivedAt: null,
			},
			canPost: true,
			canManage: true,
			postRefusal: null,
			file: null,
		},
		state: {
			activity: {
				_id: "activity" as app_convex_Id<"channels_activity">,
				_creationTime: 1,
				channelId: "channel" as app_convex_Id<"channels">,
				organizationId: "org" as app_convex_Id<"organizations">,
				workspaceId: "workspace" as app_convex_Id<"organizations_workspaces">,
				lastChannelSequence: 50,
				lastMainSequence: 50,
				lastMessageAt: 1,
				memberCount: 1,
			},
			member: null,
			readSequence: 50,
			unread: false,
			mentionCount: 0,
		},
	};
}

function Conversation(props: { width: number; narrow: boolean }) {
	const [search, setSearch] = useState<ChannelsSearch>({});
	return (
		<div style={{ width: props.width, height: 700 }}>
			<ChannelsConversation
				{...fixture()}
				width={props.width}
				narrow={props.narrow}
				people={[]}
				search={search}
				onNavigate={(_id, search) => setSearch(search ?? {})}
				onDialog={() => {}}
			/>
		</div>
	);
}

afterEach(() => cleanup());

describe("ChannelsConversation", () => {
	test("message actions stay beside the row and opening More does not add height", async () => {
		await page.viewport(390, 844);
		const view = render(<Conversation width={340} narrow={true} />);
		await screen.findByRole("textbox", { name: "Message" });
		const row = view.container.querySelector<HTMLElement>("article")!;
		const actions = row.querySelector<HTMLElement>(".ChannelsMessage-actions")!;
		expect(
			actions.getBoundingClientRect().top - row.getBoundingClientRect().top,
			"message actions must share the top row on touch too",
		).toBeLessThanOrEqual(8);
		const height = row.getBoundingClientRect().height;
		await userEvent.click(screen.getAllByRole("button", { name: "More message actions" })[0]!);
		await screen.findByRole("menuitem", { name: "Quote reply" });
		expect(row.getBoundingClientRect().height).toBe(height);
		await userEvent.keyboard("{Escape}");
	});

	test("cancelling an edit restores an empty draft with Send disabled", async () => {
		await page.viewport(1000, 900);
		app_local_storage_set_value("app_state::channels_drafts::scope::membership", {});
		render(<Conversation width={900} narrow={false} />);
		const editor = await screen.findByRole("textbox", { name: "Message" });
		expect(editor.textContent).toBe("");
		await userEvent.click(screen.getAllByRole("article")[0]!);
		await userEvent.keyboard("e");
		const edit = await screen.findByRole("textbox", { name: "Edit message" });
		await waitFor(() => expect(edit.textContent).toContain("Saved message 1"));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Save edit (Enter)" }).hasAttribute("disabled")).toBe(false),
		);
		await userEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
		const draft = await screen.findByRole("textbox", { name: "Message" });
		expect(draft.textContent).toBe("");
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Send (Enter)" }).hasAttribute("disabled"),
				"an empty draft must disable Send after cancelling an edit",
			).toBe(true),
		);
	});

	test("More keeps the reaction picker open and quote reply moves focus into the editor", async () => {
		await page.viewport(1000, 900);
		const view = render(<Conversation width={900} narrow={false} />);
		const editor = await screen.findByRole("textbox", { name: "Message" });
		await userEvent.click(screen.getAllByRole("button", { name: "More message actions" })[0]!);
		await userEvent.click(screen.getByRole("menuitem", { name: "Add reaction" }));
		await waitFor(() => {
			const picker = view.container.querySelector<HTMLElement>('[aria-label="Choose a reaction"]')!;
			expect(picker.parentElement?.matches(":popover-open")).toBe(true);
			expect(picker.getBoundingClientRect().width).toBeGreaterThan(0);
		});
		await userEvent.keyboard("{Escape}");
		await userEvent.click(screen.getAllByRole("button", { name: "More message actions" })[0]!);
		await userEvent.click(screen.getByRole("menuitem", { name: "Quote reply" }));
		await screen.findByRole("button", { name: "Cancel reply" });
		await waitFor(() => expect(editor.contains(document.activeElement)).toBe(true));
	});

	test("opening and resizing a thread keeps the channel draft and scroll, with one thread scroll area", async () => {
		await page.viewport(1600, 900);
		app_local_storage_set_value("app_state::channels_thread_width", 380);
		app_local_storage_set_value("app_state::channels_drafts::scope::membership", {});
		const view = render(<Conversation width={1200} narrow={false} />);
		const editor = await screen.findByRole("textbox", { name: "Message" });
		await userEvent.fill(editor, "Keep this draft");
		const list = screen.getByRole("log", { name: "Messages in #general" });
		list.scrollTop = 140;
		const anchor = Array.from(list.querySelectorAll<HTMLElement>("article")).find(
			(row) => row.getBoundingClientRect().bottom > list.getBoundingClientRect().top,
		)!;
		const savedOffset = anchor.getBoundingClientRect().top - list.getBoundingClientRect().top;
		const threadAction = list.querySelectorAll<HTMLElement>("article")[5]!;
		threadAction.focus({ preventScroll: true });
		await userEvent.keyboard("t");
		await screen.findByRole("textbox", { name: "Thread reply" });
		expect(screen.getByRole("textbox", { name: "Message" })).toBe(editor);
		expect(editor.textContent).toBe("Keep this draft");
		expect(
			anchor.getBoundingClientRect().top - list.getBoundingClientRect().top,
			"opening a thread must keep the visible message in place",
		).toBe(savedOffset);
		const thread = view.container.querySelector<HTMLElement>('[data-pane="thread"]')!;
		await waitFor(() => expect(Math.abs(thread.getBoundingClientRect().width - 380)).toBeLessThan(2));
		const root = thread.querySelector<HTMLElement>("[data-thread-root]")!;
		expect(screen.getByRole("log", { name: "Thread replies" }).contains(root)).toBe(true);
		expect(getComputedStyle(root).overflowY, "the root must share the reply scroll").toBe("visible");
		view.rerender(<Conversation width={500} narrow={true} />);
		await waitFor(() => expect(thread.getBoundingClientRect().width).toBe(500));
		expect(view.container.contains(editor), "a narrow thread must keep the channel draft mounted").toBe(true);
		expect(getComputedStyle(list.closest<HTMLElement>(".MyPanel")!).display).toBe("none");
		await userEvent.click(screen.getByRole("button", { name: "Back to channel" }));
		await waitFor(() => expect(editor.getBoundingClientRect().width).toBeGreaterThan(400));
		await waitFor(() => expect(document.activeElement, "Back must return focus to its opener").toBe(threadAction));
		expect(editor.textContent).toBe("Keep this draft");
		expect(
			Math.abs(anchor.getBoundingClientRect().top - list.getBoundingClientRect().top - savedOffset),
			"Back must restore the channel's visible message after narrow reflow",
		).toBeLessThan(2);
	});
});
