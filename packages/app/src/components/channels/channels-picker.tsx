import "./channels-picker.css";
import { memo, useState } from "react";
import { CatchBoundary, type ErrorComponentProps } from "@tanstack/react-router";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { AppChannelsProvider } from "@/lib/app-channels-context.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { useChannelsNamedPages, useChannelsPickerFocus } from "./channels-picker-hooks.ts";

type ChannelsPicker_ClassNames = "ChannelsPicker" | "ChannelsPicker-group" | "ChannelsPicker-status";

export const ChannelsPickerError = memo(function ChannelsPickerError(props: ErrorComponentProps) {
	return (
		<div role="alert">
			<p>Could not load channels</p>
			<MyButton onClick={props.reset}>Retry</MyButton>
		</div>
	);
});

export const ChannelsNamedPicker = memo(function ChannelsNamedPicker(props: {
	prefix: string;
	archived: boolean;
	onSelect: (channelId: app_convex_Id<"channels">) => void;
}) {
	const { membershipId } = AppTenantProvider.useContext();
	const { accessScopeKey, status } = AppChannelsProvider.useContext();
	const focus = useChannelsPickerFocus();
	return (
		<div {...focus}>
			{accessScopeKey === null ? (
				<p>
					{status === "error"
						? "Could not load channels"
						: status === "unavailable"
							? "Channels unavailable"
							: "Loading channels…"}
				</p>
			) : (
				<CatchBoundary getResetKey={() => `${membershipId}:${accessScopeKey}`} errorComponent={ChannelsPickerError}>
					<ChannelsNamedPickerPages
						key={`${membershipId}:${accessScopeKey}`}
						{...props}
						accessScopeKey={accessScopeKey}
					/>
				</CatchBoundary>
			)}
		</div>
	);
});

const ChannelsNamedPickerPages = memo(function ChannelsNamedPickerPages(props: {
	accessScopeKey: string;
	prefix: string;
	archived: boolean;
	onSelect: (channelId: app_convex_Id<"channels">) => void;
}) {
	const pages = useChannelsNamedPages({
		accessScopeKey: props.accessScopeKey,
		prefix: props.prefix,
		archived: props.archived,
	});
	const focus = useChannelsPickerFocus();
	const [refusal, setRefusal] = useState<string | null>(null);
	return (
		<div
			{...focus}
			className={"ChannelsPicker" satisfies ChannelsPicker_ClassNames}
			aria-busy={pages.loading}
			data-results-state={pages.noRowsYet ? "loading" : pages.loading ? "updating" : "ready"}
		>
			{pages.groups.map((group) => (
				<section
					key={group.name}
					className={"ChannelsPicker-group" satisfies ChannelsPicker_ClassNames}
					aria-label={group.name}
				>
					<h3 tabIndex={-1}>{group.name}</h3>
					{pages.noRowsYet ? (
						<div className={"ChannelsPicker-status" satisfies ChannelsPicker_ClassNames} data-loading="true">
							Loading…
						</div>
					) : (
						<>
							{group.rows.map((row) => (
								<MyButton
									key={row.memberId}
									variant="ghost-highlightable"
									disabled={pages.loading}
									data-channel-access={row.state}
									data-picker-row={row.memberId}
									onClick={() => {
										if (pages.loading) return;
										if (row.state === "readable") props.onSelect(row.channel._id);
										else setRefusal(row.state === "locked" ? "Permission denied" : "Unavailable");
									}}
								>
									{row.state === "readable"
										? `#${row.channel.kind === "public" || row.channel.kind === "private" ? row.channel.name : ""}`
										: row.state === "locked"
											? "No access"
											: "Unavailable"}
									{row.state === "readable" &&
										(row.channel.kind === "public" || row.channel.kind === "private") &&
										row.channel.archived &&
										" · Archived"}
								</MyButton>
							))}
							{group.rows.length === 0 && (
								<div className={"ChannelsPicker-status" satisfies ChannelsPicker_ClassNames}>No matches</div>
							)}
							{(group.status === "CanLoadMore" || group.status === "LoadingMore") && (
								<MyButton
									aria-disabled={pages.loading || group.status === "LoadingMore"}
									onClick={() => {
										if (!pages.loading && group.status === "CanLoadMore") group.loadMore(50);
									}}
								>
									{group.status === "LoadingMore" ? "Loading…" : `Show more ${group.name.toLowerCase()}`}
								</MyButton>
							)}
						</>
					)}
				</section>
			))}
			{refusal && <p role="status">{refusal}</p>}
		</div>
	);
});
