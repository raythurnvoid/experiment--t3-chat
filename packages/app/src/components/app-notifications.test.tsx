/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const {
	mutationMock,
	useQueriesMock,
	queriesUpdate,
	useQueryMock,
	usePaginatedQueryMock,
	openRunMock,
	channelContextMock,
} = vi.hoisted(() => {
	const listeners = new Set<() => void>();
	// Lets a test render the mounted component again, like a live `useQueries` update does.
	const queriesUpdate = {
		version: 0,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		notify: () => {
			queriesUpdate.version += 1;
			listeners.forEach((listener) => listener());
		},
	};
	return {
		mutationMock: vi.fn(),
		useQueriesMock: vi.fn(),
		queriesUpdate,
		useQueryMock: vi.fn(),
		usePaginatedQueryMock: vi.fn(),
		openRunMock: vi.fn(),
		channelContextMock: vi.fn(() => ({
			inboxUnreadCount: 0 as number | null,
			status: "delayed",
			retrySummary: vi.fn(),
		})),
	};
});

vi.mock("@/lib/app-channels-context.tsx", () => ({ AppChannelsProvider: { useContext: () => channelContextMock() } }));
vi.mock("@/components/channels/channels-feed.tsx", () => ({
	ChannelsFeedMessage: (props: { onOpen?: () => void }) => <button onClick={props.onOpen}>Open message context</button>,
}));
vi.mock("@/components/channels/channels-people.ts", () => ({ useChannelsProfiles: () => [] }));
vi.mock("@/components/app-auth.tsx", () => ({ AppAuthProvider: { useAuthenticated: () => ({ userId: "viewer" }) } }));

vi.mock("@/components/files/files-clipboard.tsx", () => ({
	FilesClipboardProvider: {
		useContext: () => ({ openRun: openRunMock }),
	},
}));

// The provider owns visibility. The modal has its own query and control tests.
vi.mock("@/components/files/files-pending-review.tsx", () => ({
	FilesPendingReviewModal: (props: { runId: string; kind?: string; onClose: () => void }) => (
		<div role="dialog" aria-label={`Review ${props.runId}`} data-kind={props.kind}>
			<button onClick={props.onClose}>Hide review</button>
		</div>
	),
}));

vi.mock("@/components/files/files-archive-modal.tsx", () => ({
	FilesArchiveRunModal: (props: { runId: string; onClose: () => void }) => (
		<div role="dialog" aria-label={`Archive job ${props.runId}`}>
			<button onClick={props.onClose}>Hide archive job</button>
		</div>
	),
}));

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => vi.fn(),
	Link: (props: { children?: ReactNode; onClick?: () => void }) => (
		<a href="#messages" onClick={props.onClick}>
			{props.children}
		</a>
	),
}));

vi.mock("convex/react", async () => {
	const { useSyncExternalStore } = await import("react");
	return {
		useQueries: (...args: unknown[]) => {
			useSyncExternalStore(queriesUpdate.subscribe, () => queriesUpdate.version);
			return useQueriesMock(...args);
		},
		useQuery: (...args: unknown[]) => useQueryMock(...args),
		usePaginatedQuery: (...args: unknown[]) => usePaginatedQueryMock(...args),
	};
});

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({
			membershipId: "membership_1",
			organizationName: "team",
			workspaceName: "home",
		}),
	},
}));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: {
		mutation: (...args: unknown[]) => mutationMock(...args),
	},
	app_convex_api: {
		files_pending_update_runs: {
			start: "files_pending_update_runs.start",
			append_items: "files_pending_update_runs.append_items",
			seal: "files_pending_update_runs.seal",
			get: "files_pending_update_runs.get",
		},
		files_transfer_status: { get: "files_transfer_status.get" },
		access_control: {
			get_current_user_workspace_permission: "access_control.get_current_user_workspace_permission",
		},
		activities: {
			archive_activity: "activities.archive_activity",
			archive_all_activities: "activities.archive_all_activities",
			request_stop: "activities.request_stop",
			retry_move_repair: "activities.retry_move_repair",
		},
		activities_feed: { list_page: "activities_feed.list_page" },
		notifications: {
			archive_all_notifications: "notifications.archive_all_notifications",
			archive_notification: "notifications.archive_notification",
			list_current_notifications: "notifications.list_current_notifications",
		},
		organizations: {
			list: "organizations.list",
		},
		users: {
			get_anagraphic: "users.get_anagraphic",
		},
		channels_messages: { list_my_inbox: "channels_messages.list_my_inbox" },
		channels: { get_channel: "channels.get_channel" },
	},
}));

vi.mock("@/hooks/utils-hooks.ts", () => ({
	useFn: <T,>(fn: T) => fn,
}));

vi.mock("@/components/my-popover.tsx", () => ({
	MyPopover: function MyPopover(props: { children?: ReactNode }) {
		return <>{props.children}</>;
	},
	// Keep the dialog role and the props, so a test can read the name the component gives the popover.
	MyPopoverContent: function MyPopoverContent(props: ComponentPropsWithRef<"div"> & { unmountOnHide?: boolean }) {
		const { unmountOnHide: _unmountOnHide, ...rest } = props;
		return <div role="dialog" {...rest} />;
	},
	MyPopoverTrigger: function MyPopoverTrigger(props: { children?: ReactNode }) {
		return <>{props.children}</>;
	},
}));

vi.mock("@/components/my-button.tsx", () => ({
	MyButton: function MyButton(props: ComponentPropsWithRef<"button"> & { variant?: string }) {
		const { children, variant: _variant, ...rest } = props;
		return (
			<button type="button" {...rest}>
				{children}
			</button>
		);
	},
}));

vi.mock("@/components/my-icon-button.tsx", () => ({
	MyIconButton: function MyIconButton(props: ComponentPropsWithRef<"button"> & { tooltip?: string; variant?: string }) {
		const { children, tooltip: _tooltip, variant: _variant, ...rest } = props;
		return (
			<button type="button" {...rest}>
				{children}
			</button>
		);
	},
	MyIconButtonIcon: function MyIconButtonIcon(props: { children?: ReactNode }) {
		return <span>{props.children}</span>;
	},
}));

vi.mock("@/components/my-icon.tsx", () => ({
	MyIcon: function MyIcon(props: { children?: ReactNode; className?: string }) {
		return <span className={props.className}>{props.children}</span>;
	},
}));

import { AppNotifications } from "./app-notifications.tsx";
import { AppActivitiesProvider } from "@/lib/app-activities-context.tsx";
import type { app_convex_Doc, app_convex_FunctionArgs, app_convex_Id } from "@/lib/app-convex-client.ts";

function TestNotifications(props: { show?: boolean; membershipId?: string; notificationKey?: string }) {
	const membershipId = props.membershipId ?? "membership_1";
	return (
		<AppActivitiesProvider
			key={membershipId}
			membershipId={membershipId as app_convex_Id<"organizations_workspaces_users">}
		>
			{props.show === false ? null : <AppNotifications key={props.notificationKey} />}
		</AppActivitiesProvider>
	);
}

function ActivityControl(props: {
	activityId: app_convex_Id<"activities">;
	sourceId: app_convex_Doc<"activities">["source"]["id"];
	label: string;
}) {
	const { stop, pendingStopSourceIds } = AppActivitiesProvider.useContext();
	return (
		<button
			disabled={pendingStopSourceIds.has(props.sourceId)}
			onClick={() => void stop({ activityId: props.activityId, sourceId: props.sourceId })}
		>
			{props.label}
		</button>
	);
}

function ReviewControl(props: {
	selection: Pick<
		app_convex_FunctionArgs<typeof import("@/lib/app-convex-client.ts").app_convex_api.files_pending_update_runs.start>,
		"kind" | "items"
	>;
	onError: (error: unknown) => void;
}) {
	const { startReview, isStartingReview } = AppActivitiesProvider.useContext();
	return (
		<button
			disabled={isStartingReview}
			onClick={() => {
				void startReview(props.selection).catch(props.onError);
			}}
		>
			Start review
		</button>
	);
}

describe("AppNotifications", () => {
	beforeEach(() => {
		// Use a lasting return value: the popover renders twice on mount when its first load ends.
		channelContextMock.mockReturnValue({ inboxUnreadCount: 0, status: "delayed", retrySummary: vi.fn() });
		useQueriesMock.mockImplementation((queries: Record<string, { query: string }>) =>
			Object.fromEntries(
				Object.entries(queries).map(([key, { query }]) => [
					key,
					query === "channels_messages.list_my_inbox" ? { page: [], isDone: true, continueCursor: "" } : undefined,
				]),
			),
		);
		useQueryMock.mockImplementation((query: unknown) => {
			if (query === "notifications.list_current_notifications") return [];
			if (query === "organizations.list") return { organizations: [], organizationIdsWorkspacesDict: {} };
			return undefined;
		});
		usePaginatedQueryMock.mockImplementation((_query: unknown, args: { section: string }) => ({
			results:
				args.section === "active"
					? []
					: [
							{
								_id: "activity_1",
								_creationTime: Date.UTC(2026, 7, 2, 12, 0),
								status: "failed",
								resultKind: "plugin_result",
								source: { kind: "plugin_run", id: "plugin_run_1" },
								title: "Export report",
								errorMessage: "Export failed",
								targets: [],
								finishedAt: Date.UTC(2026, 7, 2, 12, 1),
								controls: { canStop: false, canRetry: false, canDismiss: true },
							},
						],
			status: "Exhausted",
			loadMore: vi.fn(),
		}));
		mutationMock.mockResolvedValue({ _yay: { isDone: true, continueCursor: "", count: 1 } });
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	test("uses saved Messages totals and keeps their open action separate from dismiss", () => {
		channelContextMock.mockReturnValue({ inboxUnreadCount: 750, status: "delayed", retrySummary: vi.fn() });
		render(<TestNotifications />);
		expect(screen.getByText("750")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Dismiss jobs and invites" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Open message context" })).toBeNull();
		expect(mutationMock, "opening channel context must not archive invitations or jobs").not.toHaveBeenCalled();
	});

	test("shows a skeleton until every row is ready, then every row at once", () => {
		const inboxEntry = (channelId: string) => ({
			state: "readable",
			item: { _id: `inbox_${channelId}`, channelId, kind: "mention", threadRootId: null },
			message: {},
			unread: true,
		});
		let inboxPage = [inboxEntry("channel_1")];
		const channels: Record<string, unknown> = {};
		useQueriesMock.mockImplementation((queries: Record<string, { query: string }>) =>
			Object.fromEntries(
				Object.entries(queries).map(([key, { query }]) => [
					key,
					query === "channels_messages.list_my_inbox"
						? { page: inboxPage, isDone: true, continueCursor: "" }
						: query === "channels.get_channel"
							? channels[key]
							: undefined,
				]),
			),
		);
		render(<TestNotifications />);
		expect(screen.getByRole("status", { name: "Loading notifications" })).toBeTruthy();
		expect(screen.queryByText("Export report"), "the jobs wait until the message rows are ready too").toBeNull();

		channels.channel_1 = { channel: { kind: "public", name: "general" } };
		act(() => queriesUpdate.notify());
		expect(screen.queryByRole("status", { name: "Loading notifications" })).toBeNull();
		expect(screen.getByText("Export report")).toBeTruthy();
		expect(screen.getAllByRole("button", { name: "Open message context" })).toHaveLength(1);

		// A message from a channel that is still loading waits, and the rows on screen stay.
		inboxPage = [inboxEntry("channel_2"), inboxEntry("channel_1")];
		act(() => queriesUpdate.notify());
		expect(screen.queryByRole("status", { name: "Loading notifications" })).toBeNull();
		expect(screen.getByText("Export report")).toBeTruthy();
		expect(screen.getAllByRole("button", { name: "Open message context" })).toHaveLength(1);
	});

	test("names the popover dialog after its visible title", () => {
		render(<TestNotifications />);

		expect(screen.getByRole("dialog", { name: "Notifications" })).toBeTruthy();
	});
	test.each(["updating", "error"])("keeps jobs usable without a stale Messages badge during %s", async (status) => {
		channelContextMock.mockReturnValue({ inboxUnreadCount: null, status, retrySummary: vi.fn() });
		const view = render(<TestNotifications />);
		expect(view.container.querySelector(".AppNotifications-badge")).toBeNull();
		expect(screen.getByText("Export report")).toBeTruthy();
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Dismiss jobs and invites" })));
		expect(mutationMock).toHaveBeenCalledWith("notifications.archive_all_notifications", {});
		expect(mutationMock).toHaveBeenCalledWith("activities.archive_all_activities", {
			membershipId: "membership_1",
			cursor: null,
		});
	});

	test("lets a viewer dismiss a shared card using the returned control", () => {
		render(<TestNotifications />);
		const button = screen.getByRole("button", { name: "Dismiss Export report" });
		button.focus();
		expect(document.activeElement).toBe(button);
		fireEvent.click(button);
		expect(mutationMock).toHaveBeenCalledWith("activities.archive_activity", {
			membershipId: "membership_1",
			activityId: "activity_1",
		});
	});

	test("loads active jobs independently when history has no more pages", () => {
		const loadMore = vi.fn();
		const originalPage = usePaginatedQueryMock.getMockImplementation()!;
		usePaginatedQueryMock.mockImplementation((query: unknown, args: { section: string }) =>
			args.section === "active" ? { results: [], status: "CanLoadMore", loadMore } : originalPage(query, args),
		);
		render(<TestNotifications />);
		fireEvent.click(screen.getByRole("button", { name: "Load more active jobs" }));
		expect(loadMore).toHaveBeenCalledWith(50);
		expect(screen.queryByRole("button", { name: "Load more history" })).toBeNull();
	});

	test("bulk dismiss follows bounded continuation pages", async () => {
		mutationMock
			.mockResolvedValueOnce({ _yay: null })
			.mockResolvedValueOnce({ _yay: { count: 50, isDone: false, continueCursor: "next_page" } })
			.mockResolvedValueOnce({ _yay: { count: 1, isDone: true, continueCursor: "" } });
		render(<TestNotifications />);
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Dismiss jobs and invites" })));
		expect(mutationMock.mock.calls).toEqual([
			["notifications.archive_all_notifications", {}],
			["activities.archive_all_activities", { membershipId: "membership_1", cursor: null }],
			["activities.archive_all_activities", { membershipId: "membership_1", cursor: "next_page" }],
		]);
		expect(screen.getByRole("button", { name: "Dismiss jobs and invites" }).matches(":disabled")).toBe(false);
	});

	test("shows an overdue estimate without a database update", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(100_000);
		usePaginatedQueryMock.mockImplementation((_query: unknown, args: { section: string }) => ({
			results:
				args.section === "history"
					? []
					: [
							{
								_id: "plugin_activity",
								_creationTime: 100_000,
								status: "running",
								resultKind: "plugin_result",
								source: { kind: "plugin_run", id: "plugin_run" },
								title: "Export report",
								errorMessage: null,
								targets: [],
								expectedFinishAt: 101_000,
								controls: { canStop: false, canRetry: false, canDismiss: false },
							},
						],
			status: "Exhausted",
			loadMore: vi.fn(),
		}));
		render(<TestNotifications />);
		expect(screen.getByText(/^Running/)).toBeTruthy();
		await act(async () => vi.advanceTimersByTime(1001));
		expect(screen.getByText(/^Overdue/)).toBeTruthy();
		expect(mutationMock).not.toHaveBeenCalled();
	});

	test("shows a running job as a bar and a count", () => {
		usePaginatedQueryMock.mockImplementation((_query: unknown, args: { section: string }) => ({
			results:
				args.section !== "active"
					? []
					: [
							{
								_id: "copy_activity",
								_creationTime: 1,
								status: "running",
								resultKind: "saved",
								source: { kind: "files_transfer_run", id: "copy_run", transferKind: "copy", isRename: false },
								title: "Copy files",
								errorMessage: null,
								targets: [],
								progress: {
									unit: "files",
									discovered: 10,
									total: 10,
									completed: 3,
									blocked: 0,
									failed: 0,
									skipped: 1,
									canceled: 0,
								},
								controls: { canStop: true, canRetry: false, canDismiss: false },
							},
						],
			status: "Exhausted",
			loadMore: vi.fn(),
		}));
		render(<TestNotifications />);
		expect(screen.getByText("Copying 4 of 10 files…")).toBeTruthy();
		expect(screen.getByRole("progressbar", { name: "Copy files progress" }).getAttribute("aria-valuenow")).toBe("40");
		fireEvent.click(screen.getByRole("button", { name: "View progress" }));
		expect(openRunMock).toHaveBeenCalledWith("copy_run");
	});

	test.each([
		["move_repair_stuck", "running"],
		["waiting_for_move", "queued"],
	] as const)("tells the person why a Move does not go on (%s)", (errorCode, status) => {
		usePaginatedQueryMock.mockImplementation((_query: unknown, args: { section: string }) => ({
			results:
				args.section !== "active"
					? []
					: [
							{
								_id: "move_activity",
								_creationTime: 1,
								status,
								resultKind: "saved",
								source: { kind: "files_transfer_run", id: "move_run", transferKind: "move", isRename: false },
								title: "Move files",
								errorCode,
								errorMessage: errorCode === "move_repair_stuck" ? "Your files are already in their new place." : null,
								targets: [],
								progress: {
									unit: "files",
									discovered: 1,
									total: errorCode === "move_repair_stuck" ? 1 : null,
									completed: errorCode === "move_repair_stuck" ? 1 : 0,
									blocked: 0,
									failed: 0,
									skipped: 0,
									canceled: 0,
								},
								controls: { canStop: errorCode !== "move_repair_stuck", canRetry: false, canDismiss: false },
							},
						],
			status: "Exhausted",
			loadMore: vi.fn(),
		}));
		render(<TestNotifications />);
		if (errorCode === "waiting_for_move") {
			expect(screen.getByText("Waiting for another Move in this workspace to finish.")).toBeTruthy();
			expect(screen.queryByRole("button", { name: "Try again now" })).toBeNull();
			return;
		}
		expect(screen.getByText(/^Needs help/)).toBeTruthy();
		expect(screen.getByText("Your files are already in their new place.")).toBeTruthy();
		expect(screen.queryByRole("progressbar"), "a stuck Move shows no bar").toBeNull();
		expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Try again now" }));
		expect(mutationMock).toHaveBeenCalledWith("activities.retry_move_repair", {
			membershipId: "membership_1",
			activityId: "move_activity",
		});
	});

	test("reopens review progress and shows the saved count", async () => {
		usePaginatedQueryMock.mockImplementation((_query: unknown, args: { section: string }) => ({
			results:
				args.section === "active"
					? []
					: [
							{
								_id: "review_activity",
								_creationTime: 1,
								finishedAt: 2,
								status: "partial",
								resultKind: "saved",
								source: { kind: "files_pending_update_run", id: "review_1", operationKind: "accept" },
								title: "Save reviewed changes",
								targets: [],
								progress: {
									unit: "items",
									discovered: 5,
									total: 5,
									completed: 2,
									blocked: 1,
									failed: 1,
									skipped: 0,
									canceled: 1,
								},
								controls: { canStop: false, canRetry: false, canDismiss: true },
							},
						],
			status: "Exhausted",
			loadMore: vi.fn(),
		}));
		render(<TestNotifications />);
		expect(screen.getByText("Saved 2 of 4 items.")).toBeTruthy();
		expect(screen.getByRole("status").textContent).toMatch(/^Partly completed/);
		expect(screen.queryByRole("progressbar")).toBeNull();
		expect(screen.queryByRole("button", { name: "Stop and keep completed changes" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Open" }));
		// The card passes the run kind, so the dialog heading is right before the run loads.
		expect(screen.getByRole("dialog", { name: "Review review_1" }).getAttribute("data-kind")).toBe("accept");
		fireEvent.click(screen.getByRole("button", { name: "Hide review" }));
		fireEvent.click(screen.getByRole("button", { name: "Open" }));
		expect(screen.getByRole("dialog", { name: "Review review_1" })).toBeTruthy();
		expect(mutationMock).not.toHaveBeenCalled();
	});

	test("shows restore progress and reopens the paused name clash", () => {
		usePaginatedQueryMock.mockImplementation((_query: unknown, args: { section: string }) => ({
			results:
				args.section !== "active"
					? []
					: [
							{
								_id: "archive_activity",
								_creationTime: 1,
								status: "awaiting_input",
								resultKind: "saved",
								source: { kind: "files_archive_run", id: "archive_1", archiveKind: "restore" },
								title: "Restore files",
								errorMessage: null,
								targets: [],
								progress: {
									unit: "items",
									discovered: 700,
									total: 700,
									completed: 150,
									blocked: 0,
									failed: 0,
									skipped: 2,
									canceled: 0,
								},
								controls: { canStop: true, canRetry: false, canDismiss: false },
							},
						],
			status: "Exhausted",
			loadMore: vi.fn(),
		}));
		render(<TestNotifications />);
		expect(screen.getByText("1 name conflict needs your choice.")).toBeTruthy();
		expect(screen.getByRole("status").textContent).toMatch(/^Action needed/);
		// The waiting job counts on the bell until the person answers it.
		expect(screen.getByRole("button", { name: "Notifications" }).textContent).toBe("1");
		expect(screen.queryByRole("progressbar")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
		expect(screen.getByRole("dialog", { name: "Archive job archive_1" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Hide archive job" }));
		expect(screen.queryByRole("dialog", { name: "Archive job archive_1" })).toBeNull();
	});

	test("counts the selected items an archive did not archive", () => {
		usePaginatedQueryMock.mockImplementation((_query: unknown, args: { section: string }) => ({
			results:
				args.section === "active"
					? []
					: [
							{
								_id: "archive_activity",
								_creationTime: 1,
								finishedAt: 2,
								status: "partial",
								resultKind: "saved",
								source: { kind: "files_archive_run", id: "archive_1", archiveKind: "archive" },
								title: "Archive files",
								errorMessage: null,
								targets: [],
								progress: {
									unit: "items",
									discovered: 46,
									total: 46,
									completed: 40,
									blocked: 6,
									failed: 0,
									skipped: 0,
									canceled: 0,
								},
								controls: { canStop: false, canRetry: false, canDismiss: true },
							},
						],
			status: "Exhausted",
			loadMore: vi.fn(),
		}));
		render(<TestNotifications />);
		expect(screen.getByText("Archived 40 of 46 items.")).toBeTruthy();
		// A refused read-only item is expected, so the card reads as completed, not partly completed.
		expect(screen.getByRole("status").textContent).toMatch(/^Completed/);
		expect(screen.getByRole("button", { name: "Notifications" }).textContent).toBe("");
		fireEvent.click(screen.getByRole("button", { name: "Open" }));
		expect(screen.getByRole("dialog", { name: "Archive job archive_1" })).toBeTruthy();
	});

	// Only a finished walk sets `total`. Skipped items were already set, so the line leaves them out.
	test.each([
		{ status: "running", completed: 1, skipped: 0, blocked: 0, isDone: false, line: "Updating…", label: "Running" },
		{
			status: "partial",
			completed: 3,
			skipped: 2,
			blocked: 1,
			isDone: true,
			line: "Updated 3 of 4 items.",
			label: "Partly completed",
		},
		{
			status: "canceled",
			completed: 50,
			skipped: 0,
			blocked: 0,
			isDone: false,
			line: "Updated 50 items.",
			label: "Stopped",
		},
		{
			status: "timed_out",
			completed: 1,
			skipped: 0,
			blocked: 0,
			isDone: false,
			line: "Updated 1 item.",
			label: "Timed out",
		},
		{
			status: "failed",
			completed: 0,
			skipped: 0,
			blocked: 2,
			isDone: true,
			line: "Updated 0 of 2 items.",
			label: "Failed",
		},
	])(
		"shows the protection job line when $status after $completed",
		({ status, completed, skipped, blocked, isDone, line, label }) => {
			const isActive = status === "running";
			usePaginatedQueryMock.mockImplementation((_query: unknown, args: { section: string }) => ({
				results:
					(args.section === "active") !== isActive
						? []
						: [
								{
									_id: "protection_activity",
									_creationTime: 1,
									finishedAt: isActive ? undefined : 2,
									status,
									resultKind: "saved",
									source: { kind: "files_write_policy_run", id: "protection_1" },
									title: "Apply protection to folder contents",
									errorMessage: null,
									targets: [],
									progress: {
										unit: "items",
										discovered: completed + skipped + blocked,
										total: isDone ? completed + skipped + blocked : null,
										completed,
										blocked,
										failed: 0,
										skipped,
										canceled: 0,
									},
									controls: { canStop: isActive, canRetry: false, canDismiss: !isActive },
								},
							],
				status: "Exhausted",
				loadMore: vi.fn(),
			}));
			render(<TestNotifications />);
			expect(screen.getByText(line)).toBeTruthy();
			expect(screen.getByRole("status").textContent).toMatch(new RegExp(`^${label}`));
			// The walk has no total yet, so the bar has no value.
			expect(screen.queryByRole("progressbar")?.hasAttribute("aria-valuenow") ?? null).toBe(isActive ? false : null);
			// A protection job has no dialog to open.
			expect(screen.queryByRole("button", { name: /^(Open|View progress)$/ })).toBeNull();
		},
	);

	test("reopens conflicts and keeps Stop pending in the Activity provider", async () => {
		let status = "awaiting_input";
		usePaginatedQueryMock.mockImplementation((_query: unknown, args: { section: string }) => ({
			results:
				args.section === "history"
					? []
					: [
							{
								_id: "copy_activity",
								_creationTime: 1,
								status,
								title: "Copy files",
								resultKind: "saved",
								errorMessage: null,
								targets: [],
								finishedAt: status === "succeeded" ? 2 : undefined,
								source: { kind: "files_transfer_run", id: "copy_run", transferKind: "copy", isRename: false },
								progress: {
									unit: "files",
									discovered: 3,
									total: 3,
									completed: status === "succeeded" ? 3 : 1,
									skipped: 0,
									failed: 0,
									blocked: 0,
									canceled: 0,
								},
								controls: { canStop: status === "awaiting_input", canRetry: false, canDismiss: status === "succeeded" },
							},
						],
			status: "Exhausted",
			loadMore: vi.fn(),
		}));
		const response = Promise.withResolvers<{ _yay: null }>();
		mutationMock.mockReturnValue(response.promise);
		const view = render(<TestNotifications />);
		fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
		expect(openRunMock).toHaveBeenCalledWith("copy_run");
		expect(screen.queryByRole("button", { name: "Dismiss Copy files" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Stop and keep completed copies" }));
		expect(mutationMock).toHaveBeenCalledWith("activities.request_stop", {
			membershipId: "membership_1",
			activityId: "copy_activity",
		});
		view.rerender(<TestNotifications show={false} />);
		view.rerender(<TestNotifications />);
		expect(screen.getByRole("status").textContent).toContain("Stop requested. Waiting for the server…");
		expect(screen.getByRole("button", { name: "Stop and keep completed copies" }).matches(":disabled")).toBe(true);

		status = "stopping";
		view.rerender(<TestNotifications notificationKey="stopping" />);
		expect(screen.getByRole("status").textContent).toMatch(/^Stopping/);
		status = "succeeded";
		view.rerender(<TestNotifications notificationKey="completed" />);
		expect(screen.getByRole("status").textContent).toMatch(/^Completed/);
		expect(screen.getByText("Copied 3 files.")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Stop and keep completed copies" })).toBeNull();
		await act(async () => response.resolve({ _yay: null }));
	});
});

describe("AppActivitiesProvider", () => {
	beforeEach(() => {
		mutationMock.mockReset();
	});
	afterEach(() => cleanup());

	test("uploads the exact selection in bounded pages before sealing", async () => {
		const items = Array.from({ length: 205 }, (_, index) => ({
			pendingUpdateId: `proposal_${index}` as app_convex_Id<"files_pending_updates">,
			reviewedRevision: index + 1,
			selectedContentStateId: `state_${index}` as app_convex_Id<"files_pending_update_yjs_states">,
		}));
		const onError = vi.fn();
		const loadingSpy = vi.spyOn(toast, "loading");
		mutationMock.mockImplementation(async (ref: string) =>
			ref === "files_pending_update_runs.start"
				? { _yay: { runId: "review_1", activityId: "activity_1" } }
				: { _yay: null },
		);
		render(
			<AppActivitiesProvider membershipId={"membership_1" as app_convex_Id<"organizations_workspaces_users">}>
				<ReviewControl selection={{ kind: "accept", items }} onError={onError} />
			</AppActivitiesProvider>,
		);
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start review" })));
		expect(mutationMock.mock.calls).toEqual([
			[
				"files_pending_update_runs.start",
				{
					membershipId: "membership_1",
					requestId: expect.any(String),
					kind: "accept",
					expectedItemCount: 205,
					items: items.slice(0, 100),
				},
			],
			[
				"files_pending_update_runs.append_items",
				{ membershipId: "membership_1", runId: "review_1", offset: 100, items: items.slice(100, 200) },
			],
			[
				"files_pending_update_runs.append_items",
				{ membershipId: "membership_1", runId: "review_1", offset: 200, items: items.slice(200) },
			],
			["files_pending_update_runs.seal", { membershipId: "membership_1", runId: "review_1" }],
		]);
		expect(onError).not.toHaveBeenCalled();
		expect(loadingSpy).toHaveBeenCalledWith("Saving 205 changes…", expect.objectContaining({ id: "review_1" }));
		expect(screen.queryByRole("dialog"), "a Save never asks, so no dialog opens by itself").toBeNull();
		expect(mutationMock).toHaveBeenCalledTimes(4);
	});

	test("reuses the request after a lost start reply", async () => {
		const selection = {
			kind: "discard" as const,
			items: [
				{
					pendingUpdateId: "proposal_1" as app_convex_Id<"files_pending_updates">,
					reviewedRevision: 4,
					selectedContentStateId: null,
				},
			],
		};
		const onError = vi.fn();
		mutationMock.mockRejectedValueOnce(new Error("Connection lost"));
		mutationMock.mockImplementation(async (ref: string) =>
			ref === "files_pending_update_runs.start"
				? { _yay: { runId: "review_1", activityId: "activity_1" } }
				: { _yay: null },
		);
		render(
			<AppActivitiesProvider membershipId={"membership_1" as app_convex_Id<"organizations_workspaces_users">}>
				<ReviewControl selection={selection} onError={onError} />
			</AppActivitiesProvider>,
		);
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start review" })));
		expect(onError).toHaveBeenCalledTimes(1);
		expect(mutationMock).toHaveBeenCalledTimes(1);
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start review" })));
		expect(mutationMock.mock.calls[1]).toEqual(mutationMock.mock.calls[0]);
		expect(mutationMock.mock.calls[2]).toEqual([
			"files_pending_update_runs.seal",
			{ membershipId: "membership_1", runId: "review_1" },
		]);
	});

	test("replays the same page after a lost append reply and seals only after it succeeds", async () => {
		const items = Array.from({ length: 101 }, (_, index) => ({
			pendingUpdateId: `proposal_${index}` as app_convex_Id<"files_pending_updates">,
			reviewedRevision: 2,
			selectedContentStateId: null,
		}));
		const onError = vi.fn();
		let appendCount = 0;
		mutationMock.mockImplementation(async (ref: string) => {
			if (ref === "files_pending_update_runs.start") return { _yay: { runId: "review_1", activityId: "activity_1" } };
			if (ref === "files_pending_update_runs.append_items" && appendCount++ === 0) throw new Error("Connection lost");
			return { _yay: null };
		});
		render(
			<AppActivitiesProvider membershipId={"membership_1" as app_convex_Id<"organizations_workspaces_users">}>
				<ReviewControl selection={{ kind: "discard", items }} onError={onError} />
			</AppActivitiesProvider>,
		);
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start review" })));
		expect(onError).toHaveBeenCalledTimes(1);
		expect(mutationMock).toHaveBeenCalledTimes(2);
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start review" })));
		expect(mutationMock.mock.calls[2]).toEqual(mutationMock.mock.calls[0]);
		expect(mutationMock.mock.calls[3]).toEqual(mutationMock.mock.calls[1]);
		expect(mutationMock.mock.calls[4]).toEqual([
			"files_pending_update_runs.seal",
			{ membershipId: "membership_1", runId: "review_1" },
		]);
	});

	test("starts a new request after stopping a review whose seal reply was lost", async () => {
		const selection = {
			kind: "discard" as const,
			items: [
				{
					pendingUpdateId: "proposal_1" as app_convex_Id<"files_pending_updates">,
					reviewedRevision: 2,
					selectedContentStateId: null,
				},
			],
		};
		const onError = vi.fn();
		let starts = 0;
		let seals = 0;
		mutationMock.mockImplementation(async (ref: string) => {
			if (ref === "files_pending_update_runs.start")
				return { _yay: { runId: `review_${++starts}`, activityId: "activity_1" } };
			if (ref === "files_pending_update_runs.seal" && seals++ === 0) throw new Error("Connection lost");
			return { _yay: null };
		});
		render(
			<AppActivitiesProvider membershipId={"membership_1" as app_convex_Id<"organizations_workspaces_users">}>
				<ReviewControl selection={selection} onError={onError} />
				<ActivityControl
					activityId={"activity_1" as app_convex_Id<"activities">}
					sourceId={"review_1" as app_convex_Id<"files_pending_update_runs">}
					label="Stop review"
				/>
			</AppActivitiesProvider>,
		);
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start review" })));
		expect(onError).toHaveBeenCalledTimes(1);
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop review" })));
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start review" })));
		const startCalls = mutationMock.mock.calls.filter(([ref]) => ref === "files_pending_update_runs.start");
		expect(startCalls).toHaveLength(2);
		expect(startCalls[1]![1].requestId).not.toBe(startCalls[0]![1].requestId);
		expect(mutationMock).toHaveBeenLastCalledWith("files_pending_update_runs.seal", {
			membershipId: "membership_1",
			runId: "review_2",
		});
	});

	test("shows a page refusal and lets the user send the pages again", async () => {
		const items = Array.from({ length: 101 }, (_, index) => ({
			pendingUpdateId: `proposal_${index}` as app_convex_Id<"files_pending_updates">,
			reviewedRevision: 2,
			selectedContentStateId: null,
		}));
		const onError = vi.fn();
		mutationMock.mockImplementation(async (ref: string) =>
			ref === "files_pending_update_runs.start"
				? { _yay: { runId: "review_1", activityId: "activity_1" } }
				: { _nay: { message: "A reviewed change was revised." } },
		);
		render(
			<AppActivitiesProvider membershipId={"membership_1" as app_convex_Id<"organizations_workspaces_users">}>
				<ReviewControl selection={{ kind: "discard", items }} onError={onError} />
			</AppActivitiesProvider>,
		);
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start review" })));
		expect(onError).toHaveBeenCalledWith(new Error("A reviewed change was revised."));
		expect(mutationMock).toHaveBeenCalledTimes(2);
		expect(screen.getByRole("button", { name: "Start review" }).matches(":disabled")).toBe(false);
	});

	test("keeps concurrent Stops separate and reuses the same source request", async () => {
		const first = Promise.withResolvers<{ _yay: null }>();
		const second = Promise.withResolvers<{ _nay: { message: string } }>();
		mutationMock.mockImplementation((_query: unknown, args: { activityId: string }) =>
			args.activityId === "activity_first" ? first.promise : second.promise,
		);
		const firstArgs = {
			activityId: "activity_first" as app_convex_Id<"activities">,
			sourceId: "copy_run" as app_convex_Id<"files_transfer_runs">,
		};
		const secondArgs = {
			activityId: "activity_second" as app_convex_Id<"activities">,
			sourceId: "plugin_run" as app_convex_Id<"plugins_event_runs">,
		};
		render(
			<AppActivitiesProvider membershipId={"membership_1" as app_convex_Id<"organizations_workspaces_users">}>
				<ActivityControl {...firstArgs} label="Stop first job" />
				<ActivityControl {...firstArgs} label="Stop first job from its dialog" />
				<ActivityControl {...secondArgs} label="Stop second job" />
			</AppActivitiesProvider>,
		);
		const firstButton = screen.getByRole("button", { name: "Stop first job" });
		const firstDialogButton = screen.getByRole("button", { name: "Stop first job from its dialog" });
		const secondButton = screen.getByRole("button", { name: "Stop second job" });
		act(() => {
			fireEvent.click(firstButton);
			fireEvent.click(firstDialogButton);
			fireEvent.click(secondButton);
		});
		expect(mutationMock.mock.calls).toEqual([
			["activities.request_stop", { membershipId: "membership_1", activityId: "activity_first" }],
			["activities.request_stop", { membershipId: "membership_1", activityId: "activity_second" }],
		]);
		expect(firstButton.matches(":disabled")).toBe(true);
		expect(firstDialogButton.matches(":disabled")).toBe(true);
		expect(secondButton.matches(":disabled")).toBe(true);
		await act(async () => first.resolve({ _yay: null }));
		expect(firstButton.matches(":disabled")).toBe(false);
		expect(firstDialogButton.matches(":disabled")).toBe(false);
		expect(secondButton.matches(":disabled")).toBe(true);
		await act(async () => second.resolve({ _nay: { message: "Not allowed" } }));
		expect(secondButton.matches(":disabled")).toBe(false);
	});

	test("clears pending Stops when the tenant membership changes", async () => {
		const first = Promise.withResolvers<{ _yay: null }>();
		mutationMock.mockReturnValue(first.promise);
		const args = {
			activityId: "activity_first" as app_convex_Id<"activities">,
			sourceId: "copy_run" as app_convex_Id<"files_transfer_runs">,
		};
		const view = render(
			<AppActivitiesProvider
				key="membership_1"
				membershipId={"membership_1" as app_convex_Id<"organizations_workspaces_users">}
			>
				<ActivityControl {...args} label="Stop job" />
			</AppActivitiesProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Stop job" }));
		expect(screen.getByRole("button", { name: "Stop job" }).matches(":disabled")).toBe(true);
		view.rerender(
			<AppActivitiesProvider
				key="membership_2"
				membershipId={"membership_2" as app_convex_Id<"organizations_workspaces_users">}
			>
				<ActivityControl {...args} label="Stop job" />
			</AppActivitiesProvider>,
		);
		expect(screen.getByRole("button", { name: "Stop job" }).matches(":disabled")).toBe(false);
		const second = Promise.withResolvers<{ _yay: null }>();
		mutationMock.mockReturnValue(second.promise);
		fireEvent.click(screen.getByRole("button", { name: "Stop job" }));
		expect(mutationMock).toHaveBeenLastCalledWith("activities.request_stop", {
			membershipId: "membership_2",
			activityId: "activity_first",
		});
		await act(async () => first.resolve({ _yay: null }));
		expect(screen.getByRole("button", { name: "Stop job" }).matches(":disabled")).toBe(true);
		await act(async () => second.resolve({ _yay: null }));
		expect(screen.getByRole("button", { name: "Stop job" }).matches(":disabled")).toBe(false);
	});
});
