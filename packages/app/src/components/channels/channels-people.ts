import { useQueries, useQuery } from "convex/react";
import { useMemo } from "react";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_convex_api, type app_convex_FunctionReturnType, type app_convex_Id } from "@/lib/app-convex-client.ts";

export type ChannelsPerson = { id: app_convex_Id<"users">; name: string; avatarUrl: string | undefined };

export function useChannelsPeople() {
	const { organizationId, workspaceId } = AppTenantProvider.useContext();
	const userIds = useQuery(app_convex_api.organizations.list_organization_workspace_users, {
		organizationId,
		workspaceId,
	});
	// The roster's query descriptors stay stable while profiles load.
	const queries = useMemo(
		() =>
			Object.fromEntries(
				(userIds ?? []).map((userId) => [
					userId,
					{
						query: app_convex_api.users.get_workspace_member_anagraphic,
						args: { organizationId, workspaceId, userId },
					},
				]),
			),
		[userIds, organizationId, workspaceId],
	);
	const results = useQueries(queries) as Record<
		string,
		app_convex_FunctionReturnType<typeof app_convex_api.users.get_workspace_member_anagraphic> | Error | undefined
	>;
	const people: ChannelsPerson[] = (userIds ?? []).map((id) => {
		const profile = results[id];
		return {
			id,
			name: profile && !(profile instanceof Error) ? profile.displayName : "User",
			avatarUrl: profile && !(profile instanceof Error) ? profile.avatarUrl : undefined,
		};
	});
	return { people, loading: userIds === undefined || people.some((person) => results[person.id] === undefined) };
}

export function useChannelsDirectName(userIds: readonly app_convex_Id<"users">[], people: readonly ChannelsPerson[]) {
	const queries = useMemo(
		() =>
			Object.fromEntries(
				userIds.map((userId) => [
					userId,
					{
						query: app_convex_api.users.get_anagraphic,
						args: { userId },
					},
				]),
			),
		[userIds],
	);
	const profiles = useQueries(queries) as Record<
		string,
		app_convex_FunctionReturnType<typeof app_convex_api.users.get_anagraphic> | Error | undefined
	>;
	return userIds
		.map((id) => {
			const person = people.find((person) => person.id === id);
			const profile = profiles[id];
			return person?.name ?? `${profile && !(profile instanceof Error) ? profile.displayName : "User"} (left)`;
		})
		.join(", ");
}

export function useChannelsMentionPeople(
	target: { channelId: app_convex_Id<"channels"> } | { fileNodeId: app_convex_Id<"files_nodes"> },
	people: readonly ChannelsPerson[],
) {
	const { membershipId } = AppTenantProvider.useContext();
	const queries = useMemo(() => {
		const pages = [];
		for (let start = 0; start < people.length; start += 50) {
			pages.push([
				String(start),
				{
					query: app_convex_api.channels_messages.get_mentionable_users,
					args: { membershipId, target, userIds: people.slice(start, start + 50).map((person) => person.id) },
				},
			]);
		}
		return Object.fromEntries(pages);
	}, [membershipId, target, people]);
	const results = useQueries(queries) as Record<string, app_convex_Id<"users">[] | Error | undefined>;
	const allowed = new Set(
		Object.values(results).flatMap((result) => (result && !(result instanceof Error) ? result : [])),
	);
	return people
		.filter((person) => allowed.has(person.id))
		.map((person) => ({ kind: "user" as const, id: person.id, label: person.name }));
}
