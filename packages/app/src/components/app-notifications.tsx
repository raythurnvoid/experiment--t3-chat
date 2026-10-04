import "./app-notifications.css";

import { usePaginatedQuery, useQueries, useQuery } from "convex/react";
import { useNavigate } from "@tanstack/react-router";
import { Bell, CircleAlert, CircleCheck, FileText, LoaderCircle, X } from "lucide-react";
import { memo, useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";

import { FilesClipboardProvider } from "@/components/files/files-clipboard.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MyPopover, MyPopoverContent, MyPopoverTrigger } from "@/components/my-popover.tsx";
import { MyProgressBar } from "@/components/my-progress-bar.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { AppActivitiesProvider } from "@/lib/app-activities-context.tsx";
import { AppChannelsProvider } from "@/lib/app-channels-context.tsx";
import { ChannelsActivity } from "@/components/channels/channels-feed.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { format_relative_time } from "@/lib/date.ts";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";
import { path_name_of } from "@/lib/paths.ts";
import { app_tenant_primary_workspace_for_organization } from "@/lib/urls.ts";

// #region list item
type AppNotificationsListItem_ClassNames =
	| "AppNotificationsListItem"
	| "AppNotificationsListItem-title"
	| "AppNotificationsListItem-meta"
	| "AppNotificationsListItem-actions";

type AppNotificationsListItem_Props = {
	notification: app_convex_FunctionReturnType<typeof app_convex_api.notifications.list_current_notifications>[number];
	organization: app_convex_FunctionReturnType<typeof app_convex_api.organizations.list>["organizations"][number] | null;
	workspace:
		| app_convex_FunctionReturnType<
				typeof app_convex_api.organizations.list
		  >["organizationIdsWorkspacesDict"][app_convex_Id<"organizations">][number]
		| null;
	actorName: string;
	targetLoading: boolean;
	onArchive: (notificationId: app_convex_Id<"notifications">) => void;
	onOpenWorkspace: (args: {
		notification: app_convex_FunctionReturnType<typeof app_convex_api.notifications.list_current_notifications>[number];
		organization: app_convex_FunctionReturnType<typeof app_convex_api.organizations.list>["organizations"][number];
		workspace: app_convex_FunctionReturnType<
			typeof app_convex_api.organizations.list
		>["organizationIdsWorkspacesDict"][app_convex_Id<"organizations">][number];
	}) => void;
};

const AppNotificationsListItem = memo(function AppNotificationsListItem(props: AppNotificationsListItem_Props) {
	const { notification, organization, workspace, actorName, targetLoading, onArchive, onOpenWorkspace } = props;

	const title =
		targetLoading || !organization || !workspace
			? "Loading invitation..."
			: `${actorName} invited you to ${organization.name} / ${workspace.name}`;

	return (
		<article className={"AppNotificationsListItem" satisfies AppNotificationsListItem_ClassNames}>
			<h3 className={"AppNotificationsListItem-title" satisfies AppNotificationsListItem_ClassNames}>{title}</h3>
			<p className={"AppNotificationsListItem-meta" satisfies AppNotificationsListItem_ClassNames}>
				{format_relative_time(notification._creationTime)}
			</p>
			<div className={"AppNotificationsListItem-actions" satisfies AppNotificationsListItem_ClassNames}>
				<MyButton
					variant="secondary"
					disabled={targetLoading}
					onClick={() => {
						if (!organization || !workspace) return;
						onOpenWorkspace({ notification, organization, workspace });
					}}
				>
					Open
				</MyButton>
				<MyButton variant="ghost" onClick={() => onArchive(notification._id)}>
					Dismiss
				</MyButton>
			</div>
		</article>
	);
});
// #endregion list item

// #region list
type AppNotificationsList_ClassNames = "AppNotificationsList" | "AppNotificationsList-empty";

type AppNotificationsList_Props = {
	notifications:
		| app_convex_FunctionReturnType<typeof app_convex_api.notifications.list_current_notifications>
		| undefined;
	activities: app_convex_FunctionReturnType<typeof app_convex_api.activities.list_page>["page"] | undefined;
	organizationList: app_convex_FunctionReturnType<typeof app_convex_api.organizations.list> | undefined;
	onArchiveNotification: (notificationId: app_convex_Id<"notifications">) => void;
	onOpenWorkspace: (args: {
		notification: app_convex_FunctionReturnType<typeof app_convex_api.notifications.list_current_notifications>[number];
		organization: app_convex_FunctionReturnType<typeof app_convex_api.organizations.list>["organizations"][number];
		workspace: app_convex_FunctionReturnType<
			typeof app_convex_api.organizations.list
		>["organizationIdsWorkspacesDict"][app_convex_Id<"organizations">][number];
	}) => void;
	onOpenFile: (fileNodeId: app_convex_Id<"files_nodes">) => void;
	onArchiveActivity: (activityId: app_convex_Id<"activities">) => void;
};

const AppNotificationsList = memo(function AppNotificationsList(props: AppNotificationsList_Props) {
	const {
		notifications,
		activities,
		organizationList,
		onArchiveNotification,
		onOpenWorkspace,
		onOpenFile,
		onArchiveActivity,
	} = props;

	const notificationItems = notifications ?? [];

	const actorAnagraphicQueryResults = useQueries(
		// Memoized because useQueries re-subscribes with a render-phase setState whenever the
		// queries object identity changes; an inline object here re-render-loops the component.
		useMemo(
			() =>
				Object.fromEntries(
					(notifications ?? []).map(
						(notification) =>
							[
								notification.actorUserId,
								{
									query: app_convex_api.users.get_anagraphic,
									args: { userId: notification.actorUserId },
								},
							] as const,
					),
				),
			[notifications],
		),
	);

	// Keep active job controls before recent invitations and finished work.
	const feedItems = [
		...notificationItems.map((notification) => ({ kind: "invite" as const, notification })),
		...(activities ?? []).map((activity) => ({ kind: "activity" as const, activity })),
	].sort((a, b) => {
		const aActive = a.kind === "activity" && a.activity.finishedAt === undefined;
		const bActive = b.kind === "activity" && b.activity.finishedAt === undefined;
		if (aActive !== bActive) return aActive ? -1 : 1;
		const aCreationTime = a.kind === "invite" ? a.notification._creationTime : a.activity._creationTime;
		const bCreationTime = b.kind === "invite" ? b.notification._creationTime : b.activity._creationTime;
		return bCreationTime - aCreationTime;
	});

	return (
		<div className={"AppNotificationsList" satisfies AppNotificationsList_ClassNames}>
			{notifications === undefined && activities === undefined ? (
				<div className={"AppNotificationsList-empty" satisfies AppNotificationsList_ClassNames}>Loading...</div>
			) : feedItems.length === 0 ? (
				<div className={"AppNotificationsList-empty" satisfies AppNotificationsList_ClassNames}>
					No jobs or invitations
				</div>
			) : (
				feedItems.map((item) => {
					if (item.kind === "activity") {
						return (
							<AppNotificationsActivityItem
								key={item.activity._id}
								activity={item.activity}
								onOpenFile={onOpenFile}
								onArchive={onArchiveActivity}
							/>
						);
					}

					const notification = item.notification;
					const organization =
						organizationList?.organizations.find((organization) => organization._id === notification.organizationId) ??
						null;
					const invitedWorkspace =
						organizationList?.organizationIdsWorkspacesDict[notification.organizationId]?.find(
							(workspace) => workspace._id === notification.workspaceId,
						) ?? null;
					const defaultWorkspaceOfInvitedOrganization =
						// Keep organization-valid invites actionable after the originally invited workspace is deleted.
						organization
							? app_tenant_primary_workspace_for_organization({
									organization,
									workspaces: organizationList?.organizationIdsWorkspacesDict[notification.organizationId] ?? [],
								})
							: null;
					const workspace = invitedWorkspace ?? defaultWorkspaceOfInvitedOrganization;
					const actorAnagraphicQueryResult = actorAnagraphicQueryResults[notification.actorUserId];
					const actorAnagraphic =
						actorAnagraphicQueryResult === undefined || actorAnagraphicQueryResult instanceof Error
							? null
							: actorAnagraphicQueryResult;
					const targetLoading = organizationList === undefined;
					const actorName = actorAnagraphic?.displayName?.trim() || "Someone";

					if (!targetLoading && (!organization || !workspace)) {
						return null;
					}

					return (
						<AppNotificationsListItem
							key={notification._id}
							notification={notification}
							organization={organization}
							workspace={workspace}
							actorName={actorName}
							targetLoading={targetLoading}
							onArchive={onArchiveNotification}
							onOpenWorkspace={onOpenWorkspace}
						/>
					);
				})
			)}
		</div>
	);
});
// #endregion list

// #region activity item
type AppNotificationsActivityItem_ClassNames =
	| "AppNotificationsActivityItem"
	| "AppNotificationsActivityItem-header"
	| "AppNotificationsActivityItem-icon"
	| "AppNotificationsActivityItem-icon-status-running"
	| "AppNotificationsActivityItem-icon-status-queued"
	| "AppNotificationsActivityItem-icon-status-awaiting_input"
	| "AppNotificationsActivityItem-icon-status-stopping"
	| "AppNotificationsActivityItem-icon-status-partial"
	| "AppNotificationsActivityItem-icon-status-succeeded"
	| "AppNotificationsActivityItem-icon-status-failed"
	| "AppNotificationsActivityItem-icon-status-timed_out"
	| "AppNotificationsActivityItem-icon-status-canceled"
	| "AppNotificationsActivityItem-title-group"
	| "AppNotificationsActivityItem-title"
	| "AppNotificationsActivityItem-meta"
	| "AppNotificationsActivityItem-dismiss"
	| "AppNotificationsActivityItem-error"
	| "AppNotificationsActivityItem-job"
	| "AppNotificationsActivityItem-job-bar"
	| "AppNotificationsActivityItem-job-line"
	| "AppNotificationsActivityItem-job-line-action-needed"
	| "AppNotificationsActivityItem-targets"
	| "AppNotificationsActivityItem-target"
	| "AppNotificationsActivityItem-target-icon"
	| "AppNotificationsActivityItem-target-name";

type AppNotificationsActivityItem_Props = {
	activity: app_convex_FunctionReturnType<typeof app_convex_api.activities.list_page>["page"][number];
	onOpenFile: (fileNodeId: app_convex_Id<"files_nodes">) => void;
	onArchive: (activityId: app_convex_Id<"activities">) => void;
};

function count_label(count: number, unit: "files" | "items") {
	return `${count} ${count === 1 ? unit.slice(0, -1) : unit}`;
}

const AppNotificationsActivityItem = memo(function AppNotificationsActivityItem(
	props: AppNotificationsActivityItem_Props,
) {
	const { activity, onOpenFile, onArchive } = props;
	const { openRun } = FilesClipboardProvider.useContext();
	const { stop, pendingStopSourceIds, openReviewRun, openArchiveRun } = AppActivitiesProvider.useContext();
	const transferRun = activity.source.kind === "files_transfer_run" ? activity.source : null;
	const reviewRun = activity.source.kind === "files_pending_update_run" ? activity.source : null;
	const writePolicyRun = activity.source.kind === "files_write_policy_run" ? activity.source : null;
	const archiveRun = activity.source.kind === "files_archive_run" ? activity.source : null;
	const isStopPending = pendingStopSourceIds.has(activity.source.id);
	const progress = activity.progress;
	const isActive = activity.finishedAt === undefined;
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (!isActive || activity.expectedFinishAt === undefined) return;
		// Passing an estimate does not write to the database, so the card needs its own timer.
		const timer = setTimeout(() => setNow(Date.now()), Math.max(0, activity.expectedFinishAt - Date.now()) + 1);
		return () => clearTimeout(timer);
	}, [activity.expectedFinishAt, isActive]);

	const handleStop = useFn(() => {
		if (!activity.controls.canStop || isStopPending) return;

		stop({ activityId: activity._id, sourceId: activity.source.id })
			.then((result) => {
				if (result._nay) toast.error(result._nay.message);
			})
			.catch((error) => {
				console.error("[AppNotificationsActivityItem.handleStop] Failed to stop activity", { error });
				toast.error("Stop was not confirmed. Reconnect and try again.");
			});
	});

	// A job with counts shows one block: a bar while it runs, and one result line when it ends.
	const job = transferRun
		? {
				verbs: transferRun.transferKind === "move" ? ["Moving", "Moved"] : ["Copying", "Copied"],
				onOpen: () => openRun(transferRun.id),
			}
		: reviewRun
			? {
					verbs: reviewRun.operationKind === "accept" ? ["Saving", "Saved"] : ["Discarding", "Discarded"],
					onOpen: () => openReviewRun(reviewRun.id),
				}
			: archiveRun
				? {
						verbs: archiveRun.archiveKind === "restore" ? ["Restoring", "Restored"] : ["Archiving", "Archived"],
						onOpen: () => openArchiveRun(archiveRun.id),
					}
				: writePolicyRun
					? { verbs: ["Updating", "Updated"], onOpen: null }
					: null;
	// An archive or a protection job refuses the items the person may not change, like a read-only file.
	// That is expected, so a job that changed everything else still shows as completed. The result line
	// keeps the refused items in its "N of M" count, and the job dialog names them.
	const isRefusalOnly =
		(archiveRun?.archiveKind === "archive" || writePolicyRun !== null) &&
		activity.status === "partial" &&
		progress?.failed === 0 &&
		progress.canceled === 0;
	const displayStatus = isRefusalOnly ? "succeeded" : activity.status;

	const statusLabel =
		isStopPending && isActive && activity.status !== "stopping"
			? "Stop requested. Waiting for the server…"
			: {
					queued: "Queued",
					running: activity.expectedFinishAt !== undefined && activity.expectedFinishAt < now ? "Overdue" : "Running",
					awaiting_input: "Action needed",
					stopping: "Stopping",
					succeeded: job
						? "Completed"
						: {
								saved: "Saved",
								ready_for_review: "Ready for review",
								discarded: "Discarded",
								plugin_result: "Completed",
								bash_result: "Command finished",
							}[activity.resultKind],
					partial: "Partly completed",
					failed: "Failed",
					canceled: "Stopped",
					timed_out: "Timed out",
				}[displayStatus];
	const stopLabel = reviewRun
		? "Stop and keep completed changes"
		: transferRun && (progress?.completed ?? 0) > 0 && transferRun.transferKind === "copy"
			? "Stop and keep completed copies"
			: "Stop";

	const isAwaitingInput = activity.status === "awaiting_input";
	const handledCount = progress
		? progress.completed + progress.skipped + progress.failed + progress.blocked + progress.canceled
		: 0;
	// Skipped items were already in place or the person chose Skip, so the result line leaves them out.
	const missedCount = progress ? progress.failed + progress.blocked : 0;
	const jobLine =
		!job || !progress
			? null
			: isAwaitingInput
				? // Only name clashes pause a job. A restore asks about one clash at a time and counts none.
					`${Math.max(1, progress.blocked)} name ${progress.blocked > 1 ? "conflicts need" : "conflict needs"} your choice.`
				: isActive
					? progress.total === null
						? `${job.verbs[0]}…`
						: `${job.verbs[0]} ${handledCount} of ${count_label(progress.total, progress.unit)}…`
					: missedCount > 0
						? `${job.verbs[1]} ${progress.completed} of ${count_label(progress.completed + missedCount, progress.unit)}.`
						: `${job.verbs[1]} ${count_label(progress.completed, progress.unit)}.`;

	return (
		<article className={"AppNotificationsActivityItem" satisfies AppNotificationsActivityItem_ClassNames}>
			<div className={"AppNotificationsActivityItem-header" satisfies AppNotificationsActivityItem_ClassNames}>
				<span
					className={cn(
						"AppNotificationsActivityItem-icon" satisfies AppNotificationsActivityItem_ClassNames,
						`AppNotificationsActivityItem-icon-status-${displayStatus}` satisfies AppNotificationsActivityItem_ClassNames,
					)}
					aria-hidden
				>
					{isAwaitingInput ? (
						<CircleAlert />
					) : isActive ? (
						<LoaderCircle />
					) : displayStatus === "succeeded" ? (
						<CircleCheck />
					) : activity.status === "canceled" ? (
						<X />
					) : (
						<CircleAlert />
					)}
				</span>
				<div className={"AppNotificationsActivityItem-title-group" satisfies AppNotificationsActivityItem_ClassNames}>
					<h3
						className={"AppNotificationsActivityItem-title" satisfies AppNotificationsActivityItem_ClassNames}
						title={activity.title}
					>
						{activity.title}
					</h3>
					<p
						role="status"
						className={"AppNotificationsActivityItem-meta" satisfies AppNotificationsActivityItem_ClassNames}
					>
						{statusLabel} · {format_relative_time(activity.finishedAt ?? activity._creationTime)}
					</p>
				</div>
				{activity.controls.canDismiss ? (
					<MyIconButton
						variant="ghost-highlightable"
						tooltip="Dismiss"
						aria-label={`Dismiss ${activity.title}`}
						className={"AppNotificationsActivityItem-dismiss" satisfies AppNotificationsActivityItem_ClassNames}
						onClick={() => onArchive(activity._id)}
					>
						<MyIconButtonIcon>
							<X />
						</MyIconButtonIcon>
					</MyIconButton>
				) : null}
			</div>
			{activity.errorMessage ? (
				<p className={"AppNotificationsActivityItem-error" satisfies AppNotificationsActivityItem_ClassNames}>
					{activity.errorMessage}
				</p>
			) : null}
			{job && progress ? (
				<div className={"AppNotificationsActivityItem-job" satisfies AppNotificationsActivityItem_ClassNames}>
					{/* `total` stays null until the job has found every item, so the bar moves without a value. */}
					{isActive && !isAwaitingInput ? (
						<MyProgressBar
							className={"AppNotificationsActivityItem-job-bar" satisfies AppNotificationsActivityItem_ClassNames}
							aria-label={`${activity.title} progress`}
							value={handledCount}
							max={progress.total}
						/>
					) : null}
					<p
						className={cn(
							"AppNotificationsActivityItem-job-line" satisfies AppNotificationsActivityItem_ClassNames,
							isAwaitingInput &&
								("AppNotificationsActivityItem-job-line-action-needed" satisfies AppNotificationsActivityItem_ClassNames),
						)}
					>
						{jobLine}
					</p>
					{job.onOpen ? (
						<MyButton variant={isAwaitingInput ? "secondary" : "ghost-highlightable"} onClick={job.onOpen}>
							{isAwaitingInput ? "Resolve" : isActive ? "View progress" : "Open"}
						</MyButton>
					) : null}
				</div>
			) : null}
			{activity.controls.canStop ? (
				<MyButton
					variant="ghost"
					// Several bare "Stop" buttons can sit in one feed; the name says which one. The
					// longer labels keep their visible text as the name.
					aria-label={stopLabel === "Stop" ? `Stop ${activity.title}` : undefined}
					disabled={isStopPending}
					onClick={handleStop}
				>
					{stopLabel}
				</MyButton>
			) : null}
			{activity.targets.length > 0 ? (
				<ul className={"AppNotificationsActivityItem-targets" satisfies AppNotificationsActivityItem_ClassNames}>
					{activity.targets.map((target) => (
						<li key={target.id}>
							<button
								type="button"
								className={"AppNotificationsActivityItem-target" satisfies AppNotificationsActivityItem_ClassNames}
								title={target.path}
								onClick={() => onOpenFile(target.id)}
							>
								<MyIcon
									className={
										"AppNotificationsActivityItem-target-icon" satisfies AppNotificationsActivityItem_ClassNames
									}
								>
									<FileText />
								</MyIcon>
								<span
									className={
										"AppNotificationsActivityItem-target-name" satisfies AppNotificationsActivityItem_ClassNames
									}
								>
									{path_name_of(target.path)}
								</span>
							</button>
						</li>
					))}
				</ul>
			) : null}
		</article>
	);
});
// #endregion activity item

// #region root
type AppNotifications_ClassNames =
	| "AppNotifications-trigger"
	| "AppNotifications-badge"
	| "AppNotifications-popover"
	| "AppNotifications-header"
	| "AppNotifications-content"
	| "AppNotifications-title";

export const AppNotifications = memo(function AppNotifications() {
	const navigate = useNavigate();
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();
	const { inbox, inboxUnreadCount, inboxHasMore } = AppChannelsProvider.useContext();

	const notifications = useQuery(app_convex_api.notifications.list_current_notifications);
	const activeActivities = usePaginatedQuery(
		app_convex_api.activities.list_page,
		{ membershipId, section: "active" },
		{ initialNumItems: 50 },
	);
	const activityHistory = usePaginatedQuery(
		app_convex_api.activities.list_page,
		{ membershipId, section: "history" },
		{ initialNumItems: 50 },
	);
	const activities = [...activeActivities.results, ...activityHistory.results];
	const organizationList = useQuery(app_convex_api.organizations.list);

	const [open, setOpen] = useState(false);
	const [dismissing, setDismissing] = useState(false);
	const titleId = useId();

	const notificationItems = notifications ?? [];
	// Only unarchived notifications are fetched, so every listed one counts toward the badge.
	const notificationCount = notificationItems.length;
	// A job that waits on a name clash also counts, until the person answers it or the job ends.
	const badgeCount =
		notificationCount +
		activeActivities.results.filter((activity) => activity.status === "awaiting_input").length +
		inboxUnreadCount;
	const dismissableActivityCount = activities.filter((activity) => activity.controls.canDismiss).length;

	const onArchiveNotification = useFn((notificationId: app_convex_Id<"notifications">) => {
		app_convex
			.mutation(app_convex_api.notifications.archive_notification, { notificationId })
			.then((result) => {
				if (result._nay) {
					console.error("[AppNotifications.archiveNotification] Failed to archive notification", { result });
					toast.error(result._nay.message);
				}
			})
			.catch((error) => {
				console.error("[AppNotifications.archiveNotification] Unexpected archive error", { error, notificationId });
			});
	});

	const dismissAll = useFn(() => {
		if (dismissing) return;
		setDismissing(true);
		app_convex
			.mutation(app_convex_api.notifications.archive_all_notifications, {})
			.then(async (notificationsResult) => {
				if (notificationsResult._nay) {
					toast.error(notificationsResult._nay.message);
					return;
				}
				let cursor: string | null = null;
				do {
					const result: app_convex_FunctionReturnType<typeof app_convex_api.activities.archive_all_activities> =
						await app_convex.mutation(app_convex_api.activities.archive_all_activities, { membershipId, cursor });
					if (result._nay) {
						toast.error(result._nay.message);
						return;
					}
					cursor = result._yay.isDone ? null : result._yay.continueCursor;
				} while (cursor !== null);
			})
			.catch((error) => {
				console.error("[AppNotifications.dismissAll] Failed to dismiss notifications", { error });
				toast.error("Could not dismiss all notifications. Try again.");
			})
			.finally(() => setDismissing(false));
	});

	const handleOpenWorkspace = useFn(
		(args: {
			notification: app_convex_FunctionReturnType<
				typeof app_convex_api.notifications.list_current_notifications
			>[number];
			organization: app_convex_FunctionReturnType<typeof app_convex_api.organizations.list>["organizations"][number];
			workspace: app_convex_FunctionReturnType<
				typeof app_convex_api.organizations.list
			>["organizationIdsWorkspacesDict"][app_convex_Id<"organizations">][number];
		}) => {
			const { notification, workspace, organization } = args;

			onArchiveNotification(notification._id);
			setOpen(false);
			navigate({
				to: "/w/$organizationName/$workspaceName/chat",
				params: {
					organizationName: organization.name,
					workspaceName: workspace.name,
				},
			}).catch((error) => {
				console.error("[AppNotifications.handleOpenWorkspace] Failed to navigate to invite target", {
					error,
					notificationId: notification._id,
				});
			});
		},
	);

	const onArchiveActivity = useFn((activityId: app_convex_Id<"activities">) => {
		if (!activities.find((activity) => activity._id === activityId)?.controls.canDismiss) return;

		app_convex
			.mutation(app_convex_api.activities.archive_activity, { membershipId, activityId })
			.then((result) => {
				if (result._nay) {
					console.error("[AppNotifications.archiveActivity] Failed to archive activity", { result });
					toast.error(result._nay.message);
				}
			})
			.catch((error) => {
				console.error("[AppNotifications.archiveActivity] Unexpected archive error", { error, activityId });
			});
	});

	const handleOpenFile = useFn((fileNodeId: app_convex_Id<"files_nodes">) => {
		setOpen(false);
		navigate({
			to: "/w/$organizationName/$workspaceName/files",
			params: { organizationName, workspaceName },
			search: { nodeId: fileNodeId },
		}).catch((error) => {
			console.error("[AppNotifications.handleOpenFile] Failed to navigate to activity target", {
				error,
				fileNodeId,
			});
		});
	});

	return (
		<MyPopover open={open} setOpen={setOpen}>
			<MyPopoverTrigger>
				<MyIconButton
					variant="ghost-highlightable"
					aria-label="Notifications"
					className={"AppNotifications-trigger" satisfies AppNotifications_ClassNames}
				>
					<MyIconButtonIcon>
						<Bell />
					</MyIconButtonIcon>
					{badgeCount > 0 || inboxHasMore ? (
						<span
							className={"AppNotifications-badge" satisfies AppNotifications_ClassNames}
							title="Jobs and invites plus unread loaded message items"
						>
							{badgeCount > 99 ? "99+" : `${badgeCount}${inboxHasMore ? "+" : ""}`}
						</span>
					) : null}
				</MyIconButton>
			</MyPopoverTrigger>
			<MyPopoverContent
				unmountOnHide
				className={"AppNotifications-popover" satisfies AppNotifications_ClassNames}
				aria-labelledby={titleId}
			>
				<header className={"AppNotifications-header" satisfies AppNotifications_ClassNames}>
					<h2 id={titleId} className={"AppNotifications-title" satisfies AppNotifications_ClassNames}>
						Notifications
					</h2>
					<MyButton
						variant="ghost"
						disabled={
							dismissing || (!notificationCount && !dismissableActivityCount && activityHistory.status === "Exhausted")
						}
						onClick={dismissAll}
					>
						{dismissing
							? "Dismissing…"
							: inbox.results.length > 0 || inboxHasMore
								? "Dismiss jobs and invites"
								: "Dismiss all"}
					</MyButton>
				</header>

				<div
					className={cn(
						"AppNotifications-content" satisfies AppNotifications_ClassNames,
						"app-scrollable" satisfies AppClassName,
					)}
				>
					<ChannelsActivity compact onOpen={() => setOpen(false)} />
					<AppNotificationsList
						notifications={notifications}
						activities={activities}
						organizationList={organizationList}
						onArchiveNotification={onArchiveNotification}
						onOpenWorkspace={handleOpenWorkspace}
						onOpenFile={handleOpenFile}
						onArchiveActivity={onArchiveActivity}
					/>
					{activeActivities.status === "CanLoadMore" || activeActivities.status === "LoadingMore" ? (
						<MyButton
							variant="ghost"
							disabled={activeActivities.status === "LoadingMore"}
							onClick={() => activeActivities.loadMore(50)}
						>
							{activeActivities.status === "LoadingMore" ? "Loading active jobs…" : "Load more active jobs"}
						</MyButton>
					) : null}
					{activityHistory.status === "CanLoadMore" || activityHistory.status === "LoadingMore" ? (
						<MyButton
							variant="ghost"
							disabled={activityHistory.status === "LoadingMore"}
							onClick={() => activityHistory.loadMore(50)}
						>
							{activityHistory.status === "LoadingMore" ? "Loading history…" : "Load more history"}
						</MyButton>
					) : null}
				</div>
			</MyPopoverContent>
		</MyPopover>
	);
});
// #endregion root
