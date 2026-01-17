import { useQuery } from "convex/react";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { usePresence as usePresenceBase } from "@convex-dev/presence/react";

type usePresenceBase_Props = Parameters<typeof usePresenceBase>[0];

export type usePresence_Props = {
	roomId: usePresenceBase_Props["roomId"];
	userId: usePresenceBase_Props["userId"];
	interval?: usePresenceBase_Props["interval"];
	disconnectOnDocumentHidden?: usePresenceBase_Props["disconnectOnDocumentHidden"];
};

export function usePresence(props: usePresence_Props) {
	return usePresenceBase({
		...props,
		presence: app_convex_api.presence,
	});
}

export type usePresenceList_Props = {
	roomToken: string | null | undefined;
	userId: string | null | undefined;
};

/**
 * @example
 *
 * ```tsx
 * function MyComponent() {
 *   const presence = usePresence({
 *     presence: app_convex_api.presence,
 *     roomToken: "room-token",
 *     userId: "user-id",
 *   });
 *
 *   const presenceList = usePresenceList({ roomToken: presence.roomToken, userId: "user-id" });
 *
 *   // ...
 * }
 * ```
 */
export function usePresenceList(props: usePresenceList_Props) {
	const { roomToken, userId } = props;

	const list = useQuery(app_convex_api.presence.list, roomToken ? { roomToken } : "skip");

	if (!list) return list;

	return {
		users: list.users.slice().sort((a, b) => {
			if (a.userId === userId) return -1;
			if (b.userId === userId) return 1;
			return 0;
		}),
		usersAnagraphics: list.usersAnagraphics,
	};
}

export type usePresenceSessions_Props = {
	roomToken: string | null | undefined;
	userId: string | null | undefined;
};

/**
 * Get all sessions (browser tabs/connections) in a room.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const presence = usePresence({
 *     presence: app_convex_api.presence,
 *     roomToken: "room-token",
 *     userId: "user-id",
 *   });
 *
 *   const presenceSessions = usePresenceSessions({ roomToken: presence.roomToken, userId: "user-id" });
 *
 *   // ...
 * }
 * ```
 */
export function usePresenceSessions(props: usePresenceSessions_Props) {
	const { roomToken, userId } = props;

	const state = useQuery(app_convex_api.presence.listSessions, roomToken ? { roomToken } : "skip");

	return state?.slice().sort((a, b) => {
		if (a.userId === userId) return -1;
		if (b.userId === userId) return 1;
		return 0;
	});
}

export type usePresenceSessionsData_Props = {
	roomToken: string | null | undefined;
};

/**
 * Hook to access and manage session data in a room.
 *
 * @returns a records object with sessionId as key and data as value, along with helper functions.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const presence = usePresence({
 *     presence: app_convex_api.presence,
 *     roomToken: "room-token",
 *     userId: "user-id",
 *   });
 *
 *   const presenceSessionsData = usePresenceSessionsData({ roomToken: "room-token" });
 *
 *   // ...
 * }
 * ```
 */
export function usePresenceSessionsData(props: usePresenceSessionsData_Props) {
	const { roomToken } = props;
	return useQuery(app_convex_api.presence.getSessionsData, roomToken ? { roomToken } : "skip");
}
