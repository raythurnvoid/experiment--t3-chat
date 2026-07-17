import "./app-notifications.css";

import { useQueries, useQuery } from "convex/react";
import { useNavigate } from "@tanstack/react-router";
import { Bell, CircleAlert, CircleCheck, FileText, LoaderCircle, X } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { MyButton } from "@/components/my-button.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MyPopover, MyPopoverContent, MyPopoverTrigger } from "@/components/my-popover.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { format_relative_time } from "@/lib/date.ts";
import { cn, path_name_of } from "@/lib/utils.ts";

// #region list item
type AppNotificationsListItem_ClassNames =
	| "AppNotificationsListItem"
	| "AppNotificationsListItem-title"
	| "AppNotificationsListItem-meta"
	| "AppNotificationsListItem-actions";

type AppNotificationsListItem_Props = {
	notification: app_convex_FunctionReturnType<
		typeof app_convex_api.notifications.list_current_notifications
	>[number];
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
		notification: app_convex_FunctionReturnType<
			typeof app_convex_api.notifications.list_current_notifications
		>[number];
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
type AppNotificationsList_ClassNames =
	| "AppNotificationsList"
	| "AppNotificationsList-empty";

type AppNotificationsList_Props = {
	notifications:
		| app_convex_FunctionReturnType<typeof app_convex_api.notifications.list_current_notifications>
		| undefined;
	activities: app_convex_FunctionReturnType<typeof app_convex_api.activities.list_recent> | undefined;
	organizationList: app_convex_FunctionReturnType<typeof app_convex_api.organizations.list> | undefined;
	onArchiveNotification: (notificationId: app_convex_Id<"notifications">) => void;
	onOpenWorkspace: (args: {
		notification: app_convex_FunctionReturnType<
			typeof app_convex_api.notifications.list_current_notifications
		>[number];
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

	// One feed: invites and workspace activities interleaved, newest first.
	const feedItems = [
		...notificationItems.map((notification) => ({ kind: "invite" as const, notification })),
		...(activities ?? []).map((activity) => ({ kind: "activity" as const, activity })),
	].sort((a, b) => {
		const aCreationTime = a.kind === "invite" ? a.notification._creationTime : a.activity._creationTime;
		const bCreationTime = b.kind === "invite" ? b.notification._creationTime : b.activity._creationTime;
		return bCreationTime - aCreationTime;
	});

	return (
		<div className={"AppNotificationsList" satisfies AppNotificationsList_ClassNames}>
			{notifications === undefined && activities === undefined ? (
				<div className={"AppNotificationsList-empty" satisfies AppNotificationsList_ClassNames}>Loading...</div>
			) : feedItems.length === 0 ? (
				<div className={"AppNotificationsList-empty" satisfies AppNotificationsList_ClassNames}>No notifications</div>
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
						organizationList?.organizations.find((organization) => organization._id === notification.organizationId) ?? null;
					const invitedWorkspace =
						organizationList?.organizationIdsWorkspacesDict[notification.organizationId]?.find(
							(workspace) => workspace._id === notification.workspaceId,
						) ?? null;
					const defaultWorkspaceOfInvitedOrganization =
						// Keep organization-valid invites actionable after the originally invited workspace is deleted.
						organizationList?.organizationIdsWorkspacesDict[notification.organizationId]?.find(
							(workspace) => workspace._id === organization?.defaultWorkspaceId || workspace.default,
						) ?? null;
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
	| "AppNotificationsActivityItem-icon-status-succeeded"
	| "AppNotificationsActivityItem-icon-status-failed"
	| "AppNotificationsActivityItem-title-group"
	| "AppNotificationsActivityItem-title"
	| "AppNotificationsActivityItem-dismiss"
	| "AppNotificationsActivityItem-meta"
	| "AppNotificationsActivityItem-error"
	| "AppNotificationsActivityItem-targets"
	| "AppNotificationsActivityItem-target"
	| "AppNotificationsActivityItem-target-icon"
	| "AppNotificationsActivityItem-target-name";

type AppNotificationsActivityItem_Props = {
	activity: app_convex_FunctionReturnType<typeof app_convex_api.activities.list_recent>[number];
	onOpenFile: (fileNodeId: app_convex_Id<"files_nodes">) => void;
	onArchive: (activityId: app_convex_Id<"activities">) => void;
};

const AppNotificationsActivityItem = memo(function AppNotificationsActivityItem(
	props: AppNotificationsActivityItem_Props,
) {
	const { activity, onOpenFile, onArchive } = props;

	const statusLabel =
		activity.status === "running" ? "Running" : activity.status === "succeeded" ? "Completed" : "Failed";

	return (
		<article className={"AppNotificationsActivityItem" satisfies AppNotificationsActivityItem_ClassNames}>
			<div className={"AppNotificationsActivityItem-header" satisfies AppNotificationsActivityItem_ClassNames}>
				<span
					className={cn(
						"AppNotificationsActivityItem-icon" satisfies AppNotificationsActivityItem_ClassNames,
						`AppNotificationsActivityItem-icon-status-${activity.status}` satisfies AppNotificationsActivityItem_ClassNames,
					)}
					aria-hidden
				>
					{activity.status === "running" ? <LoaderCircle /> : activity.status === "succeeded" ? <CircleCheck /> : <CircleAlert />}
				</span>
				<div className={"AppNotificationsActivityItem-title-group" satisfies AppNotificationsActivityItem_ClassNames}>
					<h3
						className={"AppNotificationsActivityItem-title" satisfies AppNotificationsActivityItem_ClassNames}
						title={activity.title}
					>
						{activity.title}
					</h3>
					<p className={"AppNotificationsActivityItem-meta" satisfies AppNotificationsActivityItem_ClassNames}>
						{statusLabel} · {format_relative_time(activity.finishedAt ?? activity._creationTime)}
					</p>
				</div>
				{activity.status === "running" ? null : (
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
				)}
			</div>
			{activity.status === "failed" && activity.errorMessage ? (
				<p className={"AppNotificationsActivityItem-error" satisfies AppNotificationsActivityItem_ClassNames}>
					{activity.errorMessage}
				</p>
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
									className={"AppNotificationsActivityItem-target-icon" satisfies AppNotificationsActivityItem_ClassNames}
								>
									<FileText />
								</MyIcon>
								<span className={"AppNotificationsActivityItem-target-name" satisfies AppNotificationsActivityItem_ClassNames}>
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
	| "AppNotifications"
	| "AppNotifications-trigger"
	| "AppNotifications-badge"
	| "AppNotifications-popover"
	| "AppNotifications-header"
	| "AppNotifications-title";

export const AppNotifications = memo(function AppNotifications() {
	const navigate = useNavigate();
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();

	const notifications = useQuery(app_convex_api.notifications.list_current_notifications);
	const activities = useQuery(app_convex_api.activities.list_recent, { membershipId });
	const organizationList = useQuery(app_convex_api.organizations.list);

	const [open, setOpen] = useState(false);

	const notificationItems = notifications ?? [];

	const onArchiveNotification = useFn((notificationId: app_convex_Id<"notifications">) => {
		app_convex
			.mutation(app_convex_api.notifications.archive_notification, { notificationId })
			.then((result) => {
				if (result._nay) {
					console.error("[AppNotifications.archiveNotification] Failed to archive notification", { result });
				}
			})
			.catch((error) => {
				console.error("[AppNotifications.archiveNotification] Unexpected archive error", { error, notificationId });
			});
	});

	const dismissAll = useFn(() => {
		app_convex
			.mutation(app_convex_api.notifications.archive_all_notifications, {})
			.then((result) => {
				if (result._nay) {
					console.error("[AppNotifications.dismissAll] Failed to archive notifications", { result });
				}
			})
			.catch((error) => {
				console.error("[AppNotifications.dismissAll] Unexpected archive-all-notifications error", { error });
			});
		app_convex
			.mutation(app_convex_api.activities.archive_all_activities, { membershipId })
			.then((result) => {
				if (result._nay) {
					console.error("[AppNotifications.dismissAll] Failed to archive activities", { result });
				}
			})
			.catch((error) => {
				console.error("[AppNotifications.dismissAll] Unexpected archive-all-activities error", { error });
			});
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
		app_convex
			.mutation(app_convex_api.activities.archive_activity, { membershipId, activityId })
			.then((result) => {
				if (result._nay) {
					console.error("[AppNotifications.archiveActivity] Failed to archive activity", { result });
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

	// Only unarchived notifications are fetched, so every listed one counts toward the badge.
	const notificationCount = notificationItems.length;
	const dismissableActivityCount = (activities ?? []).filter((activity) => activity.status !== "running").length;

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
					{notificationCount > 0 ? (
						<span className={"AppNotifications-badge" satisfies AppNotifications_ClassNames}>
							{notificationCount > 99 ? "99+" : notificationCount}
						</span>
					) : null}
				</MyIconButton>
			</MyPopoverTrigger>
			<MyPopoverContent unmountOnHide className={"AppNotifications-popover" satisfies AppNotifications_ClassNames}>
				<header className={"AppNotifications-header" satisfies AppNotifications_ClassNames}>
					<h2 className={"AppNotifications-title" satisfies AppNotifications_ClassNames}>Notifications</h2>
					<MyButton variant="ghost" disabled={!notificationCount && !dismissableActivityCount} onClick={dismissAll}>
						Dismiss all
					</MyButton>
				</header>

				<AppNotificationsList
					notifications={notifications}
					activities={activities}
					organizationList={organizationList}
					onArchiveNotification={onArchiveNotification}
					onOpenWorkspace={handleOpenWorkspace}
					onOpenFile={handleOpenFile}
					onArchiveActivity={onArchiveActivity}
				/>
			</MyPopoverContent>
		</MyPopover>
	);
});
// #endregion root
