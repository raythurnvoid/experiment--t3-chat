import "./channels-dialogs.css";
import { memo, useId, useState, type FormEvent } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { ChannelsNavigationMode } from "@/lib/app-channels-context.tsx";
import { AppAuthProvider } from "@/components/app-auth.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyCheckboxButton } from "@/components/my-checkbox-button.tsx";
import {
	MyInput,
	MyInputArea,
	MyInputBackground,
	MyInputBox,
	MyInputControl,
	MyInputLabel,
} from "@/components/my-input.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalFooter,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
	MyModalScrollableArea,
} from "@/components/my-modal.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { useChannelsProfiles } from "./channels-people.ts";
import { ChannelsNamedPicker } from "./channels-picker.tsx";

export type ChannelsDialogKind = "create" | "direct" | "members" | "settings" | "quick";
type ChannelsDialogs_ClassNames =
	| "ChannelsDialogs"
	| "ChannelsDialogs-form"
	| "ChannelsDialogs-fields"
	| "ChannelsDialogs-list"
	| "ChannelsDialogs-person"
	| "ChannelsDialogs-error";
type ChannelsDialogs_CustomAttributes = {
	"data-member-status": "active" | "left" | "locked";
};

/**
 * People per page in the add list. "Show more people" reads the next page.
 */
const PEOPLE_PAGE_SIZE = 20;

export const ChannelsDialogs = memo(function ChannelsDialogs(props: {
	kind: ChannelsDialogKind;
	channel: app_convex_FunctionReturnType<typeof app_convex_api.channels.get_channel>;
	onClose: () => void;
	onChannel: (channelId: app_convex_Id<"channels">, mode?: ChannelsNavigationMode) => void;
}) {
	const { kind, channel, onClose, onChannel } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const { userId } = AppAuthProvider.useAuthenticated();
	const groupName = useId();
	const [name, setName] = useState(
		channel?.channel.kind === "public" || channel?.channel.kind === "private" ? channel.channel.name : "",
	);
	const [topic, setTopic] = useState(
		channel?.channel.kind === "public" || channel?.channel.kind === "private" ? channel.channel.topic : "",
	);
	const [privateChannel, setPrivateChannel] = useState(false);
	const [resolvable, setResolvable] = useState(
		channel?.channel.kind === "public" || channel?.channel.kind === "private"
			? channel.channel.resolvableThreads
			: false,
	);
	const [filter, setFilter] = useState("");
	const [archived, setArchived] = useState(false);
	const [selected, setSelected] = useState<app_convex_Id<"users">[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const creator = useQuery(
		app_convex_api.users.get_anagraphic,
		kind === "settings" && channel ? { userId: channel.channel.createdBy } : "skip",
	);
	const namedChannel = channel?.channel.kind === "public" || channel?.channel.kind === "private";
	const members = usePaginatedQuery(
		app_convex_api.channels.list_channel_members,
		kind === "members" && channel ? { membershipId, channelId: channel.channel._id } : "skip",
		{ initialNumItems: 50 },
	);
	const addsPeople =
		kind === "direct" || (kind === "members" && !!channel?.canManage && channel.channel.kind === "private");
	// The server searches the workspace one page at a time, so a workspace of any size loads the same.
	const candidates = usePaginatedQuery(
		app_convex_api.organizations_member_names.search_workspace_members,
		addsPeople ? { membershipId, text: filter } : "skip",
		{ initialNumItems: PEOPLE_PAGE_SIZE },
	);
	const title =
		kind === "create"
			? "Create channel"
			: kind === "direct"
				? "Message someone"
				: kind === "members"
					? "Channel members"
					: kind === "settings"
						? "Channel details"
						: "Find a named channel";
	const submit = useFn(async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!event.currentTarget.checkValidity() || busy) return;
		setBusy(true);
		setError("");
		try {
			if (kind === "create") {
				const result = await app_convex.mutation(app_convex_api.channels.create_channel, {
					membershipId,
					kind: privateChannel ? "private" : "public",
					layout: "messages",
					name,
					topic,
				});
				if (result._nay) {
					setError(result._nay.message);
					setBusy(false);
					return;
				}
				onChannel(result._yay.channelId);
				onClose();
			} else if (kind === "direct") {
				const result = await app_convex.mutation(app_convex_api.channels.open_direct_channel, {
					membershipId,
					otherUserIds: selected,
				});
				if (result._nay) {
					setError(result._nay.message);
					setBusy(false);
					return;
				}
				onChannel(result._yay.channelId, "alreadyOpened");
				onClose();
			} else if (kind === "members" && channel) {
				const result = await app_convex.mutation(app_convex_api.channels.add_channel_members, {
					membershipId,
					channelId: channel.channel._id,
					userIds: selected,
					level: "member",
				});
				if (result._nay) setError(result._nay.message);
				else setSelected([]);
			} else if (kind === "settings" && channel && namedChannel) {
				const args = { membershipId, channelId: channel.channel._id };
				const renamed = await app_convex.mutation(app_convex_api.channels.rename_channel, { ...args, name });
				if (renamed._nay) {
					setError(renamed._nay.message);
					setBusy(false);
					return;
				}
				const changedTopic = await app_convex.mutation(app_convex_api.channels.set_channel_topic, { ...args, topic });
				if (changedTopic._nay) {
					setError(changedTopic._nay.message);
					setBusy(false);
					return;
				}
				const changedResolve = await app_convex.mutation(app_convex_api.channels.set_channel_resolvable_threads, {
					...args,
					resolvableThreads: resolvable,
				});
				if (changedResolve._nay) {
					setError(changedResolve._nay.message);
					setBusy(false);
					return;
				}
				onClose();
			}
		} catch (error) {
			console.error("[ChannelsDialogs] Cannot save", error);
			setError("Could not save. Try again.");
		}
		setBusy(false);
	});
	const changeMember = useFn(async (id: app_convex_Id<"users">, operation: "remove" | "member" | "manager") => {
		if (!channel) return;
		try {
			const args = {
				membershipId,
				channelId: channel.channel._id,
				userId: id,
			};
			const result =
				operation === "remove"
					? await app_convex.mutation(app_convex_api.channels.remove_channel_member, args)
					: await app_convex.mutation(app_convex_api.channels.set_channel_member_level, { ...args, level: operation });
			if (result._nay) setError(result._nay.message);
		} catch (error) {
			console.error("[ChannelsDialogs] Cannot change member", error);
			setError("Could not change this member");
		}
	});
	const archive = useFn(async () => {
		if (!channel || (channel.channel.kind !== "public" && channel.channel.kind !== "private")) return;
		try {
			const result = await app_convex.mutation(
				channel.channel.archivedAt === null
					? app_convex_api.channels.archive_channel
					: app_convex_api.channels.unarchive_channel,
				{ membershipId, channelId: channel.channel._id },
			);
			if (result._nay) setError(result._nay.message);
			else onClose();
		} catch (error) {
			console.error("[ChannelsDialogs] Cannot archive", error);
			setError("Could not change the archive state");
		}
	});
	// Only the member pages loaded in this dialog are known here. Adding a current member again changes
	// nothing on the server, so a member on a page that is not loaded yet is harmless. A person who left
	// and came back can be added again, so a "left" row does not lock them.
	const memberUserIds = new Set(members.results.flatMap((row) => (row.status === "left" ? [] : [row.member.userId])));
	return (
		<MyModal
			open
			setOpen={(open) => {
				if (!open) onClose();
			}}
		>
			<MyModalPopover className={"ChannelsDialogs" satisfies ChannelsDialogs_ClassNames}>
				<MyModalHeader>
					<MyModalHeading>{title}</MyModalHeading>
					<MyModalCloseTrigger />
				</MyModalHeader>
				<form
					className={"ChannelsDialogs-form" satisfies ChannelsDialogs_ClassNames}
					onSubmit={(event) => void submit(event)}
				>
					<MyModalScrollableArea className={"ChannelsDialogs-fields" satisfies ChannelsDialogs_ClassNames}>
						{kind === "settings" && channel && (
							<>
								<p>
									Created {new Date(channel.channel.createdAt).toLocaleString()} by {creator?.displayName ?? "User"}.
								</p>
								{channel.channel.kind === "direct" && <p>The people in this conversation stay fixed.</p>}
								{channel.channel.kind === "file" && <p>{channel.file?.path}</p>}
							</>
						)}
						{(kind === "create" || (kind === "settings" && namedChannel)) && (
							<>
								<MyInput layout="stacked">
									<MyInputLabel>Name</MyInputLabel>
									<MyInputBackground />
									<MyInputArea>
										<MyInputControl
											required
											pattern="[a-z0-9_\-]{1,80}"
											maxLength={80}
											value={name}
											disabled={kind === "settings" && !channel?.canManage}
											onChange={(event) => {
												setName(event.target.value);
												setError("");
											}}
										/>
									</MyInputArea>
									<MyInputBox />
								</MyInput>
								<MyInput layout="stacked">
									<MyInputLabel>Topic</MyInputLabel>
									<MyInputBackground />
									<MyInputArea>
										<MyInputControl
											maxLength={250}
											value={topic}
											disabled={kind === "settings" && !channel?.canManage}
											onChange={(event) => {
												setTopic(event.target.value);
												setError("");
											}}
										/>
									</MyInputArea>
									<MyInputBox />
								</MyInput>
								{kind === "create" ? (
									<MyCheckboxButton checked={privateChannel} onCheckedChange={setPrivateChannel} variant="outline">
										Private channel
									</MyCheckboxButton>
								) : (
									<>
										<MyCheckboxButton
											checked={resolvable}
											disabled={!channel?.canManage}
											onCheckedChange={setResolvable}
											variant="outline"
										>
											Allow resolving threads
										</MyCheckboxButton>
										{channel?.canManage && (
											<MyButton onClick={() => void archive()}>
												{channel.channel.kind === "public" || channel.channel.kind === "private"
													? channel.channel.archivedAt === null
														? "Archive channel"
														: "Unarchive channel"
													: ""}
											</MyButton>
										)}
									</>
								)}
							</>
						)}
						{(kind === "direct" || kind === "quick" || kind === "members") && (
							<MyInput>
								<MyInputBackground />
								<MyInputArea>
									<MyInputControl
										type="search"
										aria-label={kind === "quick" ? "Find channel" : "Find person"}
										placeholder={kind === "quick" ? "Channel name…" : "Person name…"}
										value={filter}
										onChange={(event) => setFilter(event.target.value)}
									/>
								</MyInputArea>
								<MyInputBox />
							</MyInput>
						)}
						{kind === "quick" && (
							<div className={"ChannelsDialogs-list" satisfies ChannelsDialogs_ClassNames}>
								<MyButton aria-pressed={archived} onClick={() => setArchived(!archived)}>
									{archived ? "Show active channels" : "Show archived channels"}
								</MyButton>
								<ChannelsNamedPicker
									prefix={filter}
									archived={archived}
									onSelect={(id) => {
										onChannel(id);
										onClose();
									}}
								/>
							</div>
						)}
						{kind === "members" && (
							<div className={"ChannelsDialogs-list" satisfies ChannelsDialogs_ClassNames}>
								{/* The server keeps people who left or lost access in the list, so a manager can see and
								    remove them. Only "left" people cannot change level. */}
								{members.results.map(({ member, status }) => (
									<div
										key={member._id}
										className={"ChannelsDialogs-person" satisfies ChannelsDialogs_ClassNames}
										{...({ "data-member-status": status } satisfies ChannelsDialogs_CustomAttributes)}
									>
										<span>
											<ChannelsDialogsPersonName userId={member.userId} />
											{status === "left" ? " (left)" : status === "locked" ? " (can't see this)" : ""} · {member.level}
										</span>
										{channel?.canManage && channel.channel.kind === "private" && (
											<>
												{status !== "left" && (
													<MyButton
														onClick={() =>
															void changeMember(member.userId, member.level === "manager" ? "member" : "manager")
														}
													>
														{member.level === "manager" ? "Make member" : "Make manager"}
													</MyButton>
												)}
												<MyButton
													variant="ghost_destructive"
													onClick={() => void changeMember(member.userId, "remove")}
												>
													Remove
												</MyButton>
											</>
										)}
									</div>
								))}
								{members.status === "CanLoadMore" && (
									<MyButton onClick={() => members.loadMore(50)}>Load more members</MyButton>
								)}
							</div>
						)}
						{addsPeople && (
							<div className={"ChannelsDialogs-list" satisfies ChannelsDialogs_ClassNames}>
								<p>
									{kind === "direct"
										? "Choose up to 8 people. This group stays fixed."
										: "Add people to this private channel."}
								</p>
								{candidates.results
									.filter((person) => person.userId !== userId)
									.map((person) => {
										// A known member stays in the list, locked, so a search for them says why they
										// cannot be added instead of finding nothing.
										const isMember = memberUserIds.has(person.userId);
										return (
											<MyCheckboxButton
												key={person.userId}
												name={groupName}
												variant="outline"
												checked={selected.includes(person.userId)}
												disabled={
													isMember ||
													(!selected.includes(person.userId) && selected.length >= (kind === "direct" ? 8 : 50))
												}
												onCheckedChange={(checked) => {
													setSelected((ids) =>
														checked ? [...ids, person.userId] : ids.filter((id) => id !== person.userId),
													);
													setError("");
												}}
											>
												{person.displayName || "Unknown"}
												{isMember && " · Member"}
											</MyCheckboxButton>
										);
									})}
								{candidates.status === "LoadingFirstPage" ? (
									<p>Searching…</p>
								) : candidates.results.every((person) => person.userId === userId) ? (
									<p>No matches</p>
								) : null}
								{candidates.status === "CanLoadMore" && (
									<MyButton onClick={() => candidates.loadMore(PEOPLE_PAGE_SIZE)}>Show more people</MyButton>
								)}
							</div>
						)}
						{error && (
							<p role="alert" className={"ChannelsDialogs-error" satisfies ChannelsDialogs_ClassNames}>
								{error}
							</p>
						)}
					</MyModalScrollableArea>
					<MyModalFooter>
						<MyButton onClick={onClose}>Close</MyButton>
						{(kind === "create" ||
							kind === "direct" ||
							(kind === "settings" && namedChannel && channel?.canManage) ||
							(kind === "members" && selected.length > 0)) && (
							<MyButton
								type="submit"
								variant="accent"
								disabled={busy || (kind === "direct" && selected.length === 0)}
								aria-busy={busy}
							>
								{kind === "create"
									? "Create"
									: kind === "direct"
										? "Open conversation"
										: kind === "members"
											? "Add people"
											: "Save"}
							</MyButton>
						)}
					</MyModalFooter>
				</form>
			</MyModalPopover>
		</MyModal>
	);
});

const ChannelsDialogsPersonName = memo(function ChannelsDialogsPersonName(props: { userId: app_convex_Id<"users"> }) {
	const { userId } = props;
	const profile = useChannelsProfiles([userId])[0];
	return profile === undefined ? "…" : (profile?.name ?? "User");
});
