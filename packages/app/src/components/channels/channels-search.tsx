import "./channels-search.css";
import { memo, useState, type ComponentProps, type ReactNode } from "react";
import { CatchBoundary, type ErrorComponentProps } from "@tanstack/react-router";
import { usePaginatedQuery, useQuery } from "convex/react";
import { z } from "zod";
import { MyButton } from "@/components/my-button.tsx";
import {
	MyInput,
	MyInputArea,
	MyInputBackground,
	MyInputBox,
	MyInputControl,
	MyInputLabel,
	MyInputHelperText,
} from "@/components/my-input.tsx";
import {
	MySelect,
	MySelectLabel,
	MySelectTrigger,
	MySelectPopover,
	MySelectPopoverScrollableArea,
	MySelectPopoverContent,
	MySelectItem,
	MySelectItemContent,
	MySelectItemContentPrimary,
	MySelectItemIndicator,
	MySelectOpenIndicator,
} from "@/components/my-select.tsx";
import { AppAuthProvider } from "@/components/app-auth.tsx";
import { AppChannelsProvider } from "@/lib/app-channels-context.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { useFn } from "@/hooks/utils-hooks.ts";
import { cn } from "@/lib/utils.ts";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { channels_search_query_schema } from "../../../shared/channels.ts";
import { ChannelsFeedMessage } from "./channels-feed.tsx";
import { useChannelsDirectName, useChannelsPeople, type ChannelsPerson } from "./channels-people.ts";

export type ChannelsSearchFilters = {
	q?: string;
	channel?: string;
	from?: string;
	attachments?: "true" | "false";
	since?: string;
	until?: string;
};
type ChannelsSearchView_ClassNames =
	| "ChannelsSearchView"
	| "ChannelsSearchView-form"
	| "ChannelsSearchView-filters"
	| "ChannelsSearchView-field"
	| "ChannelsSearchView-value"
	| "ChannelsSearchView-results";

const SearchFilter = memo(function SearchFilter(props: {
	label: string;
	value: string;
	options: { value: string; label: ReactNode }[];
	onChange: (value: string) => void;
}) {
	const { label, value, options, onChange } = props;
	return (
		<div className={"ChannelsSearchView-field" satisfies ChannelsSearchView_ClassNames}>
			<MySelect value={value} setValue={(value) => onChange(value as string)}>
				<MySelectLabel>{label}</MySelectLabel>
				<MySelectTrigger>
					<MyButton type="button" variant="outline">
						<span className={"ChannelsSearchView-value" satisfies ChannelsSearchView_ClassNames}>
							{options.find((option) => option.value === value)?.label ?? "Unavailable"}
						</span>
						<MySelectOpenIndicator />
					</MyButton>
				</MySelectTrigger>
				<MySelectPopover unmountOnHide sameWidth>
					<MySelectPopoverScrollableArea>
						<MySelectPopoverContent>
							{options.map((option) => (
								<MySelectItem key={option.value} value={option.value}>
									<MySelectItemContent>
										<MySelectItemContentPrimary>{option.label}</MySelectItemContentPrimary>
									</MySelectItemContent>
									<MySelectItemIndicator />
								</MySelectItem>
							))}
						</MySelectPopoverContent>
					</MySelectPopoverScrollableArea>
				</MySelectPopover>
			</MySelect>
		</div>
	);
});

const SearchChannelName = memo(function SearchChannelName(props: {
	channelId: app_convex_Id<"channels">;
	people: readonly ChannelsPerson[];
}) {
	const { channelId, people } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const { userId } = AppAuthProvider.useAuthenticated();
	const channel = useQuery(app_convex_api.channels.get_channel, { membershipId, channelId });
	const directName = useChannelsDirectName(
		channel?.channel.kind === "direct" ? channel.channel.participantUserIds.filter((id) => id !== userId) : [],
		people,
	);
	if (channel === undefined) return "Loading channel…";
	if (channel === null) return "Unavailable";
	return channel.channel.kind === "direct"
		? directName
		: channel.channel.kind === "file"
			? channel.file!.path
			: `#${channel.channel.name}`;
});

export const ChannelsSearchView = memo(function ChannelsSearchView(props: {
	filters: ChannelsSearchFilters;
	onSearch: (filters: ChannelsSearchFilters) => void;
}) {
	const { filters, onSearch } = props;
	const { channelList } = AppChannelsProvider.useContext();
	const { people } = useChannelsPeople();
	const [draft, setDraft] = useState({
		q: filters.q ?? "",
		channel: filters.channel ?? "",
		from: filters.from ?? "",
		attachments: filters.attachments ?? "",
		since: filters.since ?? "",
		until: filters.until ?? "",
	});
	const [showErrors, setShowErrors] = useState(false);
	const query = channels_search_query_schema.safeParse(draft.q);
	const validationMessage = query.success ? undefined : query.error.issues[0]!.message;
	const dateValidationMessage =
		(draft.since && !z.iso.date().safeParse(draft.since).success) ||
		(draft.until && !z.iso.date().safeParse(draft.until).success)
			? "Choose valid dates"
			: draft.since && draft.until && draft.since >= draft.until
				? "Since must be before Until"
				: undefined;
	const submit = useFn<NonNullable<ComponentProps<"form">["onSubmit"]>>((event) => {
		event.preventDefault();
		setShowErrors(true);
		if (!event.currentTarget.checkValidity() || !query.success || dateValidationMessage) return;
		onSearch({
			q: query.data,
			channel: draft.channel || undefined,
			from: draft.from || undefined,
			attachments: draft.attachments === "true" || draft.attachments === "false" ? draft.attachments : undefined,
			since: draft.since || undefined,
			until: draft.until || undefined,
		});
	});
	const resetKey = useFn(() => JSON.stringify(filters));
	const catchError = useFn((error: unknown) =>
		console.error("[ChannelsSearchView] Failed to search messages", { error }),
	);
	return (
		<section
			className={cn(
				"ChannelsSearchView" satisfies ChannelsSearchView_ClassNames,
				"app-scrollable" satisfies AppClassName,
			)}
			aria-label="Search messages"
		>
			<h1>Search messages</h1>
			<form noValidate className={"ChannelsSearchView-form" satisfies ChannelsSearchView_ClassNames} onSubmit={submit}>
				<MyInput layout="stacked" displayValidationMessage={showErrors ? validationMessage : undefined}>
					<MyInputLabel>Search words</MyInputLabel>
					<MyInputBackground />
					<MyInputArea>
						<MyInputControl
							type="search"
							required
							maxLength={512}
							value={draft.q}
							validationMessage={validationMessage}
							onChange={(event) => setDraft({ ...draft, q: event.target.value })}
						/>
					</MyInputArea>
					<MyInputBox />
					<MyInputHelperText>
						{showErrors ? validationMessage : "Search message text with 1–16 words"}
					</MyInputHelperText>
				</MyInput>
				<div className={"ChannelsSearchView-filters" satisfies ChannelsSearchView_ClassNames}>
					<SearchFilter
						label="Channel"
						value={draft.channel}
						options={[
							{ value: "", label: "All readable channels" },
							...channelList.results.map((channel) => ({
								value: channel._id,
								label: <SearchChannelName channelId={channel._id} people={people} />,
							})),
						]}
						onChange={(channel) => setDraft({ ...draft, channel })}
					/>
					<SearchFilter
						label="Person"
						value={draft.from}
						options={[
							{ value: "", label: "Anyone" },
							...people.map((person) => ({ value: person.id, label: person.name })),
						]}
						onChange={(from) => setDraft({ ...draft, from })}
					/>
					<SearchFilter
						label="Attachments"
						value={draft.attachments}
						options={[
							{ value: "", label: "Any" },
							{ value: "true", label: "With attachments" },
							{ value: "false", label: "Without attachments" },
						]}
						onChange={(attachments) => setDraft({ ...draft, attachments })}
					/>
					<MyInput layout="stacked">
						<MyInputLabel>Since (UTC)</MyInputLabel>
						<MyInputBackground />
						<MyInputArea>
							<MyInputControl
								type="date"
								value={draft.since}
								onChange={(event) => setDraft({ ...draft, since: event.target.value })}
							/>
						</MyInputArea>
						<MyInputBox />
					</MyInput>
					<MyInput layout="stacked" displayValidationMessage={showErrors ? dateValidationMessage : undefined}>
						<MyInputLabel>Until (UTC, exclusive)</MyInputLabel>
						<MyInputBackground />
						<MyInputArea>
							<MyInputControl
								type="date"
								value={draft.until}
								validationMessage={dateValidationMessage}
								onChange={(event) => setDraft({ ...draft, until: event.target.value })}
							/>
						</MyInputArea>
						<MyInputBox />
						<MyInputHelperText>{showErrors ? dateValidationMessage : undefined}</MyInputHelperText>
					</MyInput>
				</div>
				<MyButton type="submit">Search</MyButton>
			</form>
			<CatchBoundary getResetKey={resetKey} onCatch={catchError} errorComponent={SearchError}>
				<SearchResults key={JSON.stringify(filters)} filters={filters} people={people} />
			</CatchBoundary>
		</section>
	);
});

const SearchError = memo(function SearchError(props: ErrorComponentProps) {
	return (
		<div role="alert">
			<p>Could not search messages. Try again.</p>
			<MyButton onClick={props.reset}>Retry</MyButton>
		</div>
	);
});

const SearchResults = memo(function SearchResults(props: {
	filters: ChannelsSearchFilters;
	people: readonly ChannelsPerson[];
}) {
	const { filters, people } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const parsed = channels_search_query_schema.safeParse(filters.q ?? "");
	const validDates =
		(!filters.since || z.iso.date().safeParse(filters.since).success) &&
		(!filters.until || z.iso.date().safeParse(filters.until).success) &&
		(!filters.since || !filters.until || filters.since < filters.until);
	const results = usePaginatedQuery(
		app_convex_api.channels_messages.search_messages,
		parsed.success && validDates
			? {
					membershipId,
					query: parsed.data,
					channelId: filters.channel,
					authorUserId: filters.from,
					hasAttachments: filters.attachments === undefined ? undefined : filters.attachments === "true",
					since: filters.since ? Date.parse(filters.since) : undefined,
					until: filters.until ? Date.parse(filters.until) : undefined,
				}
			: "skip",
		{ initialNumItems: 50 },
	);
	if (!filters.q) return <p>Enter words to search message text</p>;
	if (!parsed.success || !validDates) return <p role="alert">Check your search words and dates</p>;
	return (
		<div
			className={"ChannelsSearchView-results" satisfies ChannelsSearchView_ClassNames}
			role="region"
			aria-label="Search results"
		>
			{results.results.map((row) => (
				<ChannelsFeedMessage key={row.message._id} row={row} people={people} />
			))}
			{results.status === "LoadingFirstPage" ? (
				<p>Searching…</p>
			) : results.results.length === 0 ? (
				<p>No readable matches in this page</p>
			) : null}
			{results.status === "CanLoadMore" && <MyButton onClick={() => results.loadMore(50)}>Load more results</MyButton>}
			{results.status === "LoadingMore" && <p>Loading more results…</p>}
		</div>
	);
});
