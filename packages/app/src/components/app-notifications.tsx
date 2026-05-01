import "./app-notifications.css";

import { useQueries, useQuery } from "convex/react";
import { useNavigate } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { memo, useState } from "react";

import { MyButton } from "@/components/my-button.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MyPopover, MyPopoverContent, MyPopoverTrigger } from "@/components/my-popover.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { format_relative_time } from "@/lib/date.ts";
import { cn } from "@/lib/utils.ts";

// #region list item
type AppNotificationsListItem_ClassNames =
	| "AppNotificationsListItem"
	| "AppNotificationsListItem-state-unread"
	| "AppNotificationsListItem-title"
	| "AppNotificationsListItem-meta"
	| "AppNotificationsListItem-actions";

type AppNotificationsListItem_Props = {
	notification: app_convex_FunctionReturnType<
		typeof app_convex_api.notifications.list_current_notifications
	>[number];
	workspace: app_convex_FunctionReturnType<typeof app_convex_api.workspaces.list>["workspaces"][number] | null;
	project:
		| app_convex_FunctionReturnType<
				typeof app_convex_api.workspaces.list
		  >["workspaceIdsProjectsDict"][app_convex_Id<"workspaces">][number]
		| null;
	actorName: string;
	targetLoading: boolean;
	onMarkRead: (notificationId: app_convex_Id<"notifications">) => void;
	onOpenProject: (args: {
		notification: app_convex_FunctionReturnType<
			typeof app_convex_api.notifications.list_current_notifications
		>[number];
		workspace: app_convex_FunctionReturnType<typeof app_convex_api.workspaces.list>["workspaces"][number];
		project: app_convex_FunctionReturnType<
			typeof app_convex_api.workspaces.list
		>["workspaceIdsProjectsDict"][app_convex_Id<"workspaces">][number];
	}) => void;
};

const AppNotificationsListItem = memo(function AppNotificationsListItem(props: AppNotificationsListItem_Props) {
	const { notification, workspace, project, actorName, targetLoading, onMarkRead, onOpenProject } = props;

	const title =
		targetLoading || !workspace || !project
			? "Loading invitation..."
			: `${actorName} invited you to ${workspace.name} / ${project.name}`;

	return (
		<article
			className={cn(
				"AppNotificationsListItem" satisfies AppNotificationsListItem_ClassNames,
				!notification.read && ("AppNotificationsListItem-state-unread" satisfies AppNotificationsListItem_ClassNames),
			)}
		>
			<h3 className={"AppNotificationsListItem-title" satisfies AppNotificationsListItem_ClassNames}>{title}</h3>
			<p className={"AppNotificationsListItem-meta" satisfies AppNotificationsListItem_ClassNames}>
				{format_relative_time(notification.createdAt)}
			</p>
			<div className={"AppNotificationsListItem-actions" satisfies AppNotificationsListItem_ClassNames}>
				<MyButton
					variant="secondary"
					disabled={targetLoading}
					onClick={() => {
						if (!workspace || !project) return;
						onOpenProject({ notification, workspace, project });
					}}
				>
					Open
				</MyButton>
				{notification.read ? null : (
					<MyButton variant="ghost" onClick={() => onMarkRead(notification._id)}>
						Mark read
					</MyButton>
				)}
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
	workspaceList: app_convex_FunctionReturnType<typeof app_convex_api.workspaces.list> | undefined;
	onMarkRead: (notificationId: app_convex_Id<"notifications">) => void;
	onOpenProject: (args: {
		notification: app_convex_FunctionReturnType<
			typeof app_convex_api.notifications.list_current_notifications
		>[number];
		workspace: app_convex_FunctionReturnType<typeof app_convex_api.workspaces.list>["workspaces"][number];
		project: app_convex_FunctionReturnType<
			typeof app_convex_api.workspaces.list
		>["workspaceIdsProjectsDict"][app_convex_Id<"workspaces">][number];
	}) => void;
};

const AppNotificationsList = memo(function AppNotificationsList(props: AppNotificationsList_Props) {
	const { notifications, workspaceList, onMarkRead, onOpenProject } = props;

	const notificationItems = notifications ?? [];

	const actorAnagraphicQueryResults = useQueries(
		Object.fromEntries(
			notificationItems.map(
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
	);

	return (
		<div className={"AppNotificationsList" satisfies AppNotificationsList_ClassNames}>
			{notifications === undefined ? (
				<div className={"AppNotificationsList-empty" satisfies AppNotificationsList_ClassNames}>Loading...</div>
			) : notificationItems.length === 0 ? (
				<div className={"AppNotificationsList-empty" satisfies AppNotificationsList_ClassNames}>No notifications</div>
			) : (
				notificationItems.map((notification) => {
					const workspace =
						workspaceList?.workspaces.find((workspace) => workspace._id === notification.workspaceId) ?? null;
					const project =
						workspaceList?.workspaceIdsProjectsDict[notification.workspaceId]?.find(
							(project) => project._id === notification.projectId,
						) ?? null;
					const actorAnagraphicQueryResult = actorAnagraphicQueryResults[notification.actorUserId];
					const actorAnagraphic =
						actorAnagraphicQueryResult === undefined || actorAnagraphicQueryResult instanceof Error
							? null
							: actorAnagraphicQueryResult;
					const targetLoading = workspaceList === undefined;
					const actorName = actorAnagraphic?.displayName?.trim() || "Someone";

					if (!targetLoading && (!workspace || !project)) {
						return null;
					}

					return (
						<AppNotificationsListItem
							key={notification._id}
							notification={notification}
							workspace={workspace}
							project={project}
							actorName={actorName}
							targetLoading={targetLoading}
							onMarkRead={onMarkRead}
							onOpenProject={onOpenProject}
						/>
					);
				})
			)}
		</div>
	);
});
// #endregion list

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

	const notifications = useQuery(app_convex_api.notifications.list_current_notifications);
	const workspaceList = useQuery(app_convex_api.workspaces.list);

	const [open, setOpen] = useState(false);

	const notificationItems = notifications ?? [];

	const onMarkRead = useFn((notificationId: app_convex_Id<"notifications">) => {
		app_convex
			.mutation(app_convex_api.notifications.mark_notification_read, { notificationId })
			.then((result) => {
				if (result._nay) {
					console.error("[AppNotifications.markRead] Failed to mark notification read", { result });
				}
			})
			.catch((error) => {
				console.error("[AppNotifications.markRead] Unexpected mark-read error", { error, notificationId });
			});
	});

	const markAllRead = useFn(() => {
		app_convex
			.mutation(app_convex_api.notifications.mark_all_notifications_read, {})
			.then((result) => {
				if (result._nay) {
					console.error("[AppNotifications.markAllRead] Failed to mark notifications read", { result });
				}
			})
			.catch((error) => {
				console.error("[AppNotifications.markAllRead] Unexpected mark-all-read error", { error });
			});
	});

	const handleOpenProject = useFn(
		(args: {
			notification: app_convex_FunctionReturnType<
				typeof app_convex_api.notifications.list_current_notifications
			>[number];
			workspace: app_convex_FunctionReturnType<typeof app_convex_api.workspaces.list>["workspaces"][number];
			project: app_convex_FunctionReturnType<
				typeof app_convex_api.workspaces.list
			>["workspaceIdsProjectsDict"][app_convex_Id<"workspaces">][number];
		}) => {
			const { notification, project, workspace } = args;

			onMarkRead(notification._id);
			setOpen(false);
			navigate({
				to: "/w/$workspaceName/$projectName/chat",
				params: {
					workspaceName: workspace.name,
					projectName: project.name,
				},
			}).catch((error) => {
				console.error("[AppNotifications.handleOpenProject] Failed to navigate to invite target", {
					error,
					notificationId: notification._id,
				});
			});
		},
	);

	const visibleUnreadCount = notificationItems.filter((notification) => !notification.read).length;

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
					{visibleUnreadCount > 0 ? (
						<span className={"AppNotifications-badge" satisfies AppNotifications_ClassNames}>
							{visibleUnreadCount > 99 ? "99+" : visibleUnreadCount}
						</span>
					) : null}
				</MyIconButton>
			</MyPopoverTrigger>
			<MyPopoverContent unmountOnHide className={"AppNotifications-popover" satisfies AppNotifications_ClassNames}>
				<header className={"AppNotifications-header" satisfies AppNotifications_ClassNames}>
					<h2 className={"AppNotifications-title" satisfies AppNotifications_ClassNames}>Notifications</h2>
					<MyButton variant="ghost" disabled={!visibleUnreadCount} onClick={markAllRead}>
						Mark all read
					</MyButton>
				</header>

				<AppNotificationsList
					notifications={notifications}
					workspaceList={workspaceList}
					onMarkRead={onMarkRead}
					onOpenProject={handleOpenProject}
				/>
			</MyPopoverContent>
		</MyPopover>
	);
});
// #endregion root
