import { useQueries } from "convex/react";
import { useMemo } from "react";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_convex_api, type app_convex_FunctionReturnType, type app_convex_Id } from "@/lib/app-convex-client.ts";

type ChannelsProfile = { name: string; avatarUrl: string | null; left: boolean };

/**
 * The current name and avatar of each person, in the same order as `userIds`. Read one query per
 * person, so the cost grows with the ids asked about, never with the workspace.
 *
 * `left` means the person is not an active member of this workspace any more. Their name then comes
 * from `get_anagraphic`, which answers for anyone. An entry is `undefined` while it loads, so callers
 * do not show "(left)" too early, and `null` when the id cannot be read at all.
 */
export function useChannelsProfiles(userIds: readonly app_convex_Id<"users">[]) {
	const { organizationId, workspaceId } = AppTenantProvider.useContext();

	// Keep the manual `useMemo` on the ids joined as text. `useQueries` subscribes again whenever its
	// queries object changes, and callers often pass a new array on every render.
	const userIdsText = userIds.join(",");
	const memberQueries = useMemo(
		() =>
			Object.fromEntries(
				(userIdsText ? userIdsText.split(",") : []).map((userId) => [
					userId,
					{
						query: app_convex_api.users.get_workspace_member_anagraphic,
						args: { organizationId, workspaceId, userId: userId as app_convex_Id<"users"> },
					},
				]),
			),
		[userIdsText, organizationId, workspaceId],
	);
	const members = useQueries(memberQueries) as Record<
		string,
		app_convex_FunctionReturnType<typeof app_convex_api.users.get_workspace_member_anagraphic> | Error | undefined
	>;

	// Only people who are not active members need the second query.
	const leftIdsText = userIds.filter((userId) => members[userId] === null).join(",");
	const pastQueries = useMemo(
		() =>
			Object.fromEntries(
				(leftIdsText ? leftIdsText.split(",") : []).map((userId) => [
					userId,
					{ query: app_convex_api.users.get_anagraphic, args: { userId: userId as app_convex_Id<"users"> } },
				]),
			),
		[leftIdsText],
	);
	const past = useQueries(pastQueries) as Record<
		string,
		app_convex_FunctionReturnType<typeof app_convex_api.users.get_anagraphic> | Error | undefined
	>;

	return userIds.map((userId): ChannelsProfile | null | undefined => {
		const member = members[userId];
		if (member === undefined) return undefined;
		if (member instanceof Error) return null;
		if (member) return { name: member.displayName, avatarUrl: member.avatarUrl ?? null, left: false };

		const profile = past[userId];
		if (profile === undefined) return undefined;
		return {
			name: profile && !(profile instanceof Error) ? profile.displayName : "User",
			avatarUrl: profile && !(profile instanceof Error) ? (profile.avatarUrl ?? null) : null,
			left: true,
		};
	});
}

/**
 * The name of a direct conversation: the other people, with "(left)" after each person who is not an
 * active member of this workspace any more.
 */
export function useChannelsDirectName(userIds: readonly app_convex_Id<"users">[]) {
	return useChannelsProfiles(userIds)
		.map((profile) =>
			profile === undefined ? "…" : profile === null ? "User" : profile.left ? `${profile.name} (left)` : profile.name,
		)
		.join(", ");
}
