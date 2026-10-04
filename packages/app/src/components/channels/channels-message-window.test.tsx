import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import type { PaginationResult } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { useChannelsMessageWindow, type ChannelsMessage } from "./channels-message-window.ts";

afterEach(cleanup);

function message(sequence: number, replies = false, body = "Saved message"): ChannelsMessage {
	return {
		message: {
			_id: `message-${sequence}` as app_convex_Id<"channels_messages">,
			_creationTime: sequence,
			channelId: "channel" as app_convex_Id<"channels">,
			organizationId: "organization" as app_convex_Id<"organizations">,
			workspaceId: "workspace" as app_convex_Id<"organizations_workspaces">,
			authorUserId: "user" as app_convex_Id<"users">,
			channelSequence: sequence,
			mainSequence: replies ? null : sequence,
			threadSequence: replies ? sequence : null,
			threadRootId: replies ? ("root" as app_convex_Id<"channels_messages">) : null,
			replyTo: null,
			body,
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
		authorName: "Member",
		mentionNames: [],
		fileMentions: [],
		attachments: [],
		replyPreview: null,
		thread: null,
	};
}

function fixture(replies = false, body = "Saved message") {
	const client = new ConvexReactClient("https://channels.test");
	const callbacks = new Set<() => void>();
	const subscriptions = vi.fn();
	let sequence = 500;
	let pageLoading = false;
	let pageError = false;
	const snapshots = new Map<
		string,
		| ChannelsMessage
		| PaginationResult<ChannelsMessage>
		| { messages: ChannelsMessage[]; lastMainSequence: number; lastReplySequence: number }
	>();
	const watches = vi.spyOn(client, "watchQuery").mockImplementation((query, args = {}, _options = {}) => {
		const name = getFunctionName(query);
		const input = args as { anchorSequence?: number; paginationOpts?: { cursor: string | null }; messageId?: string };
		return {
			onUpdate(callback) {
				subscriptions(name, input);
				callbacks.add(callback);
				return () => callbacks.delete(callback);
			},
			localQueryResult() {
				const isPage = name.endsWith("_page");
				if (isPage && pageError) throw new Error("Page unavailable");
				if (isPage && pageLoading) return undefined;
				const key = JSON.stringify({ name, input, sequence });
				const saved = snapshots.get(key);
				if (saved) return saved;
				if (name.endsWith("get_message")) {
					const row = message(Number(input.messageId?.split("-")[1] ?? 1), replies, body);
					snapshots.set(key, row);
					return row;
				}
				const offset = Number(input.paginationOpts?.cursor ?? 0);
				const anchor = input.anchorSequence ?? sequence + 1;
				const rows = Array.from({ length: Math.min(50, Math.max(0, anchor - 1 - offset)) }, (_, index) =>
					message(anchor - 1 - offset - index, replies, body),
				);
				const result = isPage
					? {
							page: rows,
							isDone: (rows.at(-1)?.message.channelSequence ?? 0) <= 1,
							continueCursor: String(offset + 50),
						}
					: { messages: rows, lastMainSequence: sequence, lastReplySequence: sequence };
				snapshots.set(key, result);
				return result;
			},
			journal: () => undefined,
			localQueryLogs: () => undefined,
		};
	});
	function Probe(props: { enabled: boolean }) {
		const window = useChannelsMessageWindow({
			membershipId: "membership" as app_convex_Id<"organizations_workspaces_users">,
			target: replies
				? { rootMessageId: "root" as app_convex_Id<"channels_messages"> }
				: { channelId: "channel" as app_convex_Id<"channels"> },
			enabled: props.enabled,
		});
		return (
			<>
				<output aria-label="Rows">{window.rows.map((row) => row.message.channelSequence).join(",")}</output>
				<output aria-label="New">{window.newCount}</output>
				<output aria-label="Error">{window.error}</output>
				<button onClick={window.older}>Older</button>
				<button onClick={window.latest}>Latest</button>
				<button onClick={() => window.setEditingMessage(message(1, replies, body))}>Edit first</button>
			</>
		);
	}
	const view = render(
		<ConvexProvider client={client}>
			<Probe enabled />
		</ConvexProvider>,
	);
	const update = (values: { sequence?: number; loading?: boolean; error?: boolean; enabled?: boolean }) =>
		act(() => {
			sequence = values.sequence ?? sequence;
			pageLoading = values.loading ?? pageLoading;
			pageError = values.error ?? pageError;
			if (values.enabled !== undefined)
				view.rerender(
					<ConvexProvider client={client}>
						<Probe enabled={values.enabled} />
					</ConvexProvider>,
				);
			for (const callback of callbacks) callback();
		});
	const rows = () => screen.getByLabelText("Rows").textContent!.split(",").filter(Boolean).map(Number);
	return { client, watches, subscriptions, update, rows };
}

describe("useChannelsMessageWindow", () => {
	test("keeps five main pages and a separate live head", async () => {
		const f = fixture();
		try {
			expect(f.rows()).toHaveLength(50);
			for (let index = 0; index < 7; index++) fireEvent.click(screen.getByText("Older"));
			expect(f.rows(), "main history must keep at most five pages").toHaveLength(250);
			const saved = f.rows();
			f.update({ sequence: 503 });
			expect(f.rows()).toEqual(saved);
			expect(screen.getByLabelText("New").textContent).toBe("3");
			fireEvent.click(screen.getByText("Latest"));
			expect(f.rows().at(-1)).toBe(503);
			expect(f.rows()).toHaveLength(50);
		} finally {
			cleanup();
			await f.client.close();
		}
	});
	test("keeps two thread pages and pins the message being edited", async () => {
		const f = fixture(true);
		try {
			for (let index = 0; index < 4; index++) fireEvent.click(screen.getByText("Older"));
			expect(f.rows(), "thread history must keep at most two pages").toHaveLength(100);
			fireEvent.click(screen.getByText("Edit first"));
			expect(f.rows()[0]).toBe(1);
			expect(f.rows()).toHaveLength(101);
			fireEvent.click(screen.getByText("Older"));
			expect(f.rows()[0]).toBe(1);
		} finally {
			cleanup();
			await f.client.close();
		}
	});
	test("keeps cached pages while reconnecting and clears them when disabled", async () => {
		const f = fixture();
		try {
			fireEvent.click(screen.getByText("Older"));
			const saved = f.rows();
			const subscriptions = f.subscriptions.mock.calls.length;
			f.update({ loading: true });
			expect(f.rows()).toEqual(saved);
			expect(f.subscriptions.mock.calls, "reconnect must keep the same page subscriptions").toHaveLength(subscriptions);
			f.update({ loading: false, error: true });
			expect(screen.getByLabelText("Error").textContent).toBe("Page unavailable");
			f.update({ enabled: false });
			expect(f.rows(), "disabled access must clear all message rows").toEqual([]);
		} finally {
			cleanup();
			await f.client.close();
		}
	});
	test("drops pages before retained payload exceeds three MiB", async () => {
		const f = fixture(false, "x".repeat(16_000));
		try {
			for (let index = 0; index < 5; index++) fireEvent.click(screen.getByText("Older"));
			expect(f.rows().length, "history plus the live head must fit three MiB").toBeLessThanOrEqual(100);
		} finally {
			cleanup();
			await f.client.close();
		}
	});
});
