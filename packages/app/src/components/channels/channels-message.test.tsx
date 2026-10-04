import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { ChannelsMessage } from "./channels-message.tsx";

vi.mock(import("convex/react"), async (importOriginal) => ({ ...(await importOriginal()), useQuery: () => undefined }));
vi.mock("@/components/app-auth.tsx", () => ({ AppAuthProvider: { useAuthenticated: () => ({ userId: "author" }) } }));
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({
			membershipId: "membership",
			organizationId: "organization",
			workspaceId: "workspace",
			organizationName: "qa",
			workspaceName: "home",
		}),
	},
}));

afterEach(cleanup);

function fixture() {
	const props: ComponentProps<typeof ChannelsMessage> = {
		row: {
			message: {
				_id: "message" as app_convex_Id<"channels_messages">,
				_creationTime: 1,
				organizationId: "organization" as app_convex_Id<"organizations">,
				workspaceId: "workspace" as app_convex_Id<"organizations_workspaces">,
				channelId: "channel" as app_convex_Id<"channels">,
				authorUserId: "author" as app_convex_Id<"users">,
				channelSequence: 1,
				mainSequence: 1,
				threadSequence: null,
				threadRootId: null,
				replyTo: null,
				body: "Saved text",
				mentionUserIds: [],
				fileMentionIds: [],
				fileQuotes: [],
				attachments: [],
				hasAttachments: false,
				clientMessageId: "client-message",
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
		},
		grouped: false,
		unread: true,
		tabIndex: 0,
		sequence: 1,
		canPost: true,
		canManage: false,
		resolvable: true,
		onReply: vi.fn(),
		onThread: vi.fn(),
		onJump: vi.fn(),
		onEdit: vi.fn(),
		onDelete: vi.fn(),
		onReaction: vi.fn(),
		onUnread: vi.fn(),
		onCopyLink: vi.fn(),
		onResolve: vi.fn(),
	};
	return props;
}

describe("ChannelsMessage", () => {
	test("an unreadable file quote keeps plain text without a file name, link, or markup", () => {
		const props = fixture();
		props.row.message.body = 'Before [@ id="file:0"] [file-quote id="0"] after';
		props.row.fileMentions = [{ kind: "unavailable" }];
		props.row.message.fileQuotes = [{ fileNodeId: null, text: '<img src="x" onerror="alert(1)"> Selected text' }];
		const { container } = render(<ChannelsMessage {...props} />);
		expect(container.textContent).toContain("File unavailable");
		expect(container.textContent).toContain(props.row.message.fileQuotes[0]!.text);
		expect(container.querySelector(".FileQuote a")).toBeNull();
		expect(container.querySelector(".FileQuote img"), "selected text must stay plain text").toBeNull();
		expect(container.querySelector(".FileQuote")?.getAttribute("data-file-quote-state")).toBe("unavailable");
	});

	test("uses current mention names and sanitizes message Markdown", () => {
		const props = fixture();
		props.row.message.body = '[@ id="user:0"] [unsafe](javascript:alert(1)) <script>alert(1)</script>';
		props.row.mentionNames = ["Ana [click](javascript:alert(2))"];
		const { container } = render(<ChannelsMessage {...props} />);
		expect(container.textContent).toContain("@Ana [click](javascript:alert(2))");
		expect(container.querySelector("script"), "message text must not become a script").toBeNull();
		expect(container.querySelector('a[href^="javascript:"]'), "message text must not create an unsafe link").toBeNull();
	});

	test("keeps a deleted root readable without its body or write actions", () => {
		const props = fixture();
		props.row.message.deletedAt = 2;
		props.row.message.body = "Removed private text";
		const { container } = render(<ChannelsMessage {...props} />);
		expect(screen.getByText("This message was deleted")).toBeTruthy();
		expect(container.textContent).not.toContain("Removed private text");
		expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
		fireEvent.keyDown(screen.getByRole("article"), { key: "e" });
		fireEvent.keyDown(screen.getByRole("article"), { key: "Delete" });
		expect(props.onEdit).not.toHaveBeenCalled();
		expect(props.onDelete).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Reply in thread" }));
		expect(props.onThread).toHaveBeenCalledWith("message");
	});

	test("jumps from an inline reply and keeps keyboard actions on the focused message", () => {
		const props = fixture();
		props.row.message.replyTo = { messageId: props.row.message._id, quote: "Chosen text" };
		props.row.replyPreview = {
			authorName: "Ben",
			excerpt: "Chosen text",
			targetDeleted: false,
			targetThreadRootId: null,
		};
		render(<ChannelsMessage {...props} />);
		fireEvent.click(screen.getByRole("button", { name: "Ben: Chosen text" }));
		expect(props.onJump).toHaveBeenCalledWith("message", null);
		fireEvent.keyDown(screen.getByRole("article"), { key: "r" });
		expect(props.onReply).toHaveBeenCalledWith(props.row, null);
		fireEvent.keyDown(screen.getByRole("button", { name: "Reply" }), { key: "e" });
		expect(props.onEdit).not.toHaveBeenCalled();
		fireEvent.keyDown(screen.getByRole("article"), { key: "e" });
		expect(props.onEdit).toHaveBeenCalledWith(props.row);
	});
});
