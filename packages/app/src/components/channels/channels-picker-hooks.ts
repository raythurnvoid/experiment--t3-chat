import { useLayoutEffect, useRef, useState, type FocusEvent } from "react";
import { usePaginatedQuery } from "convex/react";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";

export function useChannelsPickerFocus() {
	const ref = useRef<HTMLDivElement>(null);
	const focused = useRef<{ element: HTMLElement; group: string | null; index: number } | null>(null);
	useLayoutEffect(() => {
		const previous = focused.current;
		if (!previous || previous.element.isConnected || document.activeElement !== document.body) return;
		const group = previous.group
			? ref.current?.querySelector<HTMLElement>(`section[aria-label="${CSS.escape(previous.group)}"]`)
			: ref.current;
		const rows = Array.from(group?.querySelectorAll<HTMLElement>("[data-picker-row]:not(:disabled)") ?? []);
		const target =
			rows[previous.index < 0 ? rows.length - 1 : Math.min(previous.index, rows.length - 1)] ??
			group?.querySelector<HTMLElement>("h3") ??
			ref.current;
		target?.focus();
	});
	return {
		ref,
		tabIndex: -1,
		onFocusCapture: (event: FocusEvent<HTMLDivElement>) => {
			const group = event.target.closest<HTMLElement>("section[aria-label]");
			focused.current = {
				element: event.target,
				group: group?.getAttribute("aria-label") ?? null,
				index: Array.from((group ?? ref.current)?.querySelectorAll("[data-picker-row]:not(:disabled)") ?? []).indexOf(
					event.target,
				),
			};
		},
	};
}

// The caller keys this hook's owner by accessScopeKey. A held page never crosses access changes.
export function useChannelsNamedPages(props: { accessScopeKey: string; prefix: string; archived: boolean }) {
	const { membershipId } = AppTenantProvider.useContext();
	const args = { membershipId, ...props };
	const publicChannels = usePaginatedQuery(app_convex_api.channels.browse_public_channels, args, {
		initialNumItems: 50,
	});
	const privateChannels = usePaginatedQuery(app_convex_api.channels.search_my_private_channels, args, {
		initialNumItems: 50,
	});
	const loading = publicChannels.status === "LoadingFirstPage" || privateChannels.status === "LoadingFirstPage";
	const [held, setHeld] = useState<{
		publicRows: typeof publicChannels.results;
		privateRows: typeof privateChannels.results;
	} | null>(null);
	if (!loading && (held?.publicRows !== publicChannels.results || held.privateRows !== privateChannels.results)) {
		setHeld({ publicRows: publicChannels.results, privateRows: privateChannels.results });
	}
	return {
		loading,
		noRowsYet: loading && held === null,
		groups: [
			{
				name: "Public channels",
				...publicChannels,
				rows: (loading && held ? held.publicRows : publicChannels.results).map((channel) => ({
					state: "readable" as const,
					memberId: channel._id,
					channel,
				})),
			},
			{
				name: "Your private channels",
				...privateChannels,
				rows: loading && held ? held.privateRows : privateChannels.results,
			},
		],
	};
}
