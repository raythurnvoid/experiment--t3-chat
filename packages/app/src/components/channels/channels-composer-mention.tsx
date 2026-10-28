import "./channels-composer-mention.css";
import {
	createContext,
	memo,
	use,
	useEffect,
	useId,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
	type Ref,
} from "react";
import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import { createInlineMarkdownSpec, mergeAttributes, type Editor, type JSONContent, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { NodeViewWrapper, posToDOMRect, ReactNodeViewRenderer, ReactRenderer, type NodeViewProps } from "@tiptap/react";
import { usePaginatedQuery, useQueries, useQuery } from "convex/react";
import Mention from "@tiptap/extension-mention";
import { exitSuggestion, type SuggestionKeyDownProps } from "@tiptap/suggestion";
import { Hash, Lock, User, Users } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { app_convex_api, type app_convex_FunctionArgs, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { FilesNodePicker, type FilesNodePicker_Ref } from "@/components/files/files-node-picker.tsx";
import type { MyFloatingSurface_ClassNames } from "@/components/my-floating-surface.tsx";
import type { MyMenuItem_ClassNames } from "@/components/my-menu.tsx";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { useChannelsProfiles } from "./channels-people.ts";

/**
 * A channel the "#" list offers.
 */
export type ChannelsMentionItem = { kind: "channel"; id: string; label: string; href: string };

/**
 * Where the message goes. The "@" list asks the server which people can be mentioned there.
 */
export type ChannelsMentionTarget =
	| { channelId: app_convex_Id<"channels"> }
	| { fileNodeId: app_convex_Id<"files_nodes"> };

export const ChannelsMentionContext = createContext<{
	target: ChannelsMentionTarget | null;
	items: readonly ChannelsMentionItem[];
}>({ target: null, items: [] });
type ChannelsComposerMention_ClassNames = "ChannelsComposerMention";
type ChannelsComposerMentionList_ClassNames =
	| "ChannelsComposerMentionList"
	| "ChannelsComposerMentionList-item"
	| "ChannelsComposerMentionList-status";

export const channels_composer_mention_PLUGIN_KEY = new PluginKey("channelsComposerMention");
export const channels_composer_channel_PLUGIN_KEY = new PluginKey("channelsComposerChannel");

// eslint-disable-next-line react-refresh/only-export-components
function ChannelsFileMention(props: { fileNodeId: string }) {
	const { membershipId } = AppTenantProvider.useContext();
	const file = useQuery(app_convex_api.files_tree.get_file_node_for_membership, {
		membershipId,
		fileNodeId: props.fileNodeId,
	});
	return <>{file && file.archiveOperationId === null ? `@${file.name}` : "File unavailable"}</>;
}

// Markdown keeps only the person's id, so a restored draft or an edit reads the name by id.
// eslint-disable-next-line react-refresh/only-export-components
function ChannelsPersonMention(props: { userId: app_convex_Id<"users">; label: string | null }) {
	const profile = useChannelsProfiles([props.userId])[0];
	return <>{`@${profile?.name ?? props.label ?? "…"}`}</>;
}

// eslint-disable-next-line react-refresh/only-export-components
function ChannelsMentionNodeView(props: NodeViewProps) {
	const { items } = use(ChannelsMentionContext);
	const id = typeof props.node.attrs.id === "string" ? props.node.attrs.id : "";
	const label = typeof props.node.attrs.label === "string" ? props.node.attrs.label : null;
	const item = items.find((item) => `${item.kind}:${item.id}` === id);
	return (
		<NodeViewWrapper
			as="span"
			contentEditable={false}
			className={"ChannelsComposerMention" satisfies ChannelsComposerMention_ClassNames}
		>
			{id.startsWith("file:") ? (
				<ChannelsFileMention fileNodeId={id.slice(5)} />
			) : id.startsWith("user:") ? (
				<ChannelsPersonMention userId={id.slice(5) as app_convex_Id<"users">} label={label} />
			) : (
				`#${item?.label ?? label ?? "channel"}`
			)}
		</NodeViewWrapper>
	);
}

export function channels_composer_mention_create_extension(options: {
	isEnabled: () => boolean;
	getItems: () => readonly ChannelsMentionItem[];
}) {
	return Mention.extend(
		createInlineMarkdownSpec({ nodeName: "channelsMention", name: "@", selfClosing: true, allowedAttributes: ["id"] }),
	)
		.extend({
			name: "channelsMention",
			addAttributes(this: ThisParameterType<NonNullable<typeof Mention.config.addAttributes>>) {
				return { ...this.parent?.(), href: { default: null } };
			},
			renderMarkdown(node: JSONContent) {
				if (typeof node.attrs?.id === "string" && node.attrs.id.startsWith("channel:")) {
					return `[#${String(node.attrs.label).replace(/[\\\[\]]/g, "\\$&")}](${node.attrs.href})`;
				}
				// Names stay in the chip. The submitted body carries a typed position only.
				return `[@ id="${node.attrs?.id}"]`;
			},
			addNodeView() {
				return ReactNodeViewRenderer(ChannelsMentionNodeView, { as: "span" });
			},
		})
		.configure({
			renderText: ({ node }) => `@${node.attrs.label ?? "Person"}`,
			renderHTML({ node, options: nodeOptions }) {
				const item = options.getItems().find((item) => `${item.kind}:${item.id}` === node.attrs.id);
				return [
					"span",
					mergeAttributes(nodeOptions.HTMLAttributes, {
						class: "ChannelsComposerMention" satisfies ChannelsComposerMention_ClassNames,
					}),
					`${String(node.attrs.id).startsWith("channel:") ? "#" : "@"}${item?.label ?? node.attrs.label ?? "Person"}`,
				];
			},
			suggestions: (
				[
					{ char: "@", kind: "user", key: channels_composer_mention_PLUGIN_KEY },
					{ char: "#", kind: "channel", key: channels_composer_channel_PLUGIN_KEY },
				] as const
			).map(({ char, kind, key }) => ({
				char,
				// Browsers can keep a non-breaking space after an inline chip.
				allowedPrefixes: [" ", "\u00a0"],
				pluginKey: key,
				allow: () => options.isEnabled(),
				items: () => [],
				render: () => {
					let component: ReactRenderer<ChannelsComposerMentionList_Ref, ChannelsComposerMentionList_Props> | null =
						null;
					let editor: Editor | null = null;
					const blur = () => {
						if (editor) exitSuggestion(editor.view, key);
					};
					const destroy = () => {
						if (!component) return;
						editor?.off("blur", blur);
						editor = null;
						component.element.remove();
						component.destroy();
						component = null;
					};
					const position = (editor: Editor, element: HTMLElement) => {
						void computePosition(
							{
								getBoundingClientRect: () =>
									posToDOMRect(editor.view, editor.state.selection.from, editor.state.selection.to),
							},
							element,
							{
								placement: "bottom-start",
								strategy: "absolute",
								middleware: [offset(4), flip(), shift()],
							},
						)
							.then(({ x, y, strategy }) => {
								element.style.position = strategy;
								element.style.left = `${x}px`;
								element.style.top = `${y}px`;
							})
							.catch((error: unknown) => console.error("[ChannelsComposerMention] Cannot place suggestions", error));
					};
					return {
						onStart(props) {
							component = new ReactRenderer(kind === "user" ? PeopleMentionList : ChannelMentionList, {
								editor: props.editor,
								// Only the people list changes the typed text, so only it gets the range.
								props: {
									editor: props.editor,
									query: props.query,
									command: props.command,
									...(kind === "user" && { range: props.range }),
								},
							});
							(document.getElementById("app_hoisting_container" satisfies AppElementId) ?? document.body).appendChild(
								component.element,
							);
							position(props.editor, component.element);
							editor = props.editor;
							editor.on("blur", blur);
						},
						onUpdate(props) {
							component?.updateProps({
								query: props.query,
								command: props.command,
								...(kind === "user" && { range: props.range }),
							});
							if (component) position(props.editor, component.element);
						},
						onKeyDown(props) {
							// This Escape closes only the popup. The next Escape reaches its parent.
							if (props.event.key === "Escape" && !props.event.isComposing) {
								props.event.stopPropagation();
								return false;
							}
							return component?.ref?.onKeyDown(props) ?? false;
						},
						onExit: destroy,
					};
				},
			})),
		});
}

type ChannelsComposerMentionList_Ref = { onKeyDown: (props: SuggestionKeyDownProps) => boolean };
type ChannelsComposerMentionList_Props = {
	ref?: Ref<ChannelsComposerMentionList_Ref>;
	editor: Editor;
	query: string;
	command: (attrs: { id: string; label: string; href?: string }) => void;
};

const PEOPLE_PAGE_SIZE = 20;

/**
 * The "@" list: people first, then the workspace files of the shared file picker.
 *
 * People come from the server search one page at a time, so a workspace of any size costs the same.
 * A person who cannot see this conversation or file stays in the list, locked, so a search for them
 * says why they cannot be mentioned instead of finding nothing.
 */
// eslint-disable-next-line react-refresh/only-export-components
const PeopleMentionList = memo(function PeopleMentionList(
	props: ChannelsComposerMentionList_Props & {
		/**
		 * The "@" and the typed query in the document.
		 */
		range: Range;
	},
) {
	const { ref, editor, query, range, command } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const { target } = use(ChannelsMentionContext);

	// Text with a "/" is a folder path. The picker shows no people then.
	const people = usePaginatedQuery(
		app_convex_api.organizations_member_names.search_workspace_members,
		query.includes("/") ? "skip" : { membershipId, text: query.trim() },
		{ initialNumItems: PEOPLE_PAGE_SIZE },
	);

	// Ask which loaded people can be mentioned here, one page at a time. This reads only the pages the
	// user loaded, never the whole workspace. Keep the manual `useMemo` on plain values: `useQueries`
	// subscribes again whenever its queries object changes.
	//
	// Each check covers exactly one page. "Show more people" then adds a new check and keeps the old
	// ones as they are, so the locked rows already shown do not unlock while the new answer loads.
	const channelId = target && "channelId" in target ? target.channelId : null;
	const fileNodeId = target && "fileNodeId" in target ? target.fileNodeId : null;
	const userIdsText = people.results.map((person) => person.userId).join(",");
	const mentionableQueries = useMemo(() => {
		const userIds = (userIdsText ? userIdsText.split(",") : []) as Array<app_convex_Id<"users">>;
		const queryTarget = channelId ? { channelId } : fileNodeId ? { fileNodeId } : null;
		const queries: Record<
			string,
			{
				query: typeof app_convex_api.channels_messages.get_mentionable_users;
				args: app_convex_FunctionArgs<typeof app_convex_api.channels_messages.get_mentionable_users>;
			}
		> = {};
		for (let start = 0; queryTarget && start < userIds.length; start += PEOPLE_PAGE_SIZE) {
			queries[start] = {
				query: app_convex_api.channels_messages.get_mentionable_users,
				args: { membershipId, target: queryTarget, userIds: userIds.slice(start, start + PEOPLE_PAGE_SIZE) },
			};
		}
		return queries;
	}, [membershipId, channelId, fileNodeId, userIdsText]);
	const mentionableAnswers = useQueries(mentionableQueries);
	// A person whose answer has not arrived can still be picked. Send checks every mention again.
	const lockedUserIds = new Set(
		Object.entries(mentionableQueries).flatMap(([key, { args }]) => {
			const answer: unknown = mentionableAnswers[key];
			return Array.isArray(answer) ? args.userIds.filter((userId) => !answer.includes(userId)) : [];
		}),
	);

	const rows = [
		...people.results.map((person) => {
			const name = person.displayName || "Unknown";
			// The shared picker has no disabled state for these rows, so the label carries the note and
			// a pick does nothing.
			return lockedUserIds.has(person.userId)
				? { key: person.userId, label: `${name} (can't see this)`, icon: <Lock />, onPick: () => {} }
				: {
						key: person.userId,
						label: name,
						icon: <User />,
						onPick: () => command({ id: `user:${person.userId}`, label: name }),
					};
		}),
		// The search starts over on every typed letter, so the list has no people until the server
		// answers. Show a row that does nothing, so Enter does not pick a file or the wrong person.
		...((people.status === "LoadingFirstPage" && !query.includes("/")) || people.status === "LoadingMore"
			? [{ key: "people-loading", label: "Searching people…", icon: <Users />, onPick: () => {} }]
			: []),
		...(people.status === "CanLoadMore"
			? [
					{
						key: "more-people",
						label: "Show more people",
						icon: <Users />,
						onPick: () => people.loadMore(PEOPLE_PAGE_SIZE),
					},
				]
			: []),
	];
	const pickerRef = useRef<FilesNodePicker_Ref>(null);

	useImperativeHandle(ref, () => ({
		// The picker leaves IME keys alone and takes Enter even with no rows, so Enter never sends the
		// message from here.
		onKeyDown: ({ event }) => pickerRef.current?.onKeyDown(event) ?? event.key === "Enter",
	}));
	return (
		<div
			className={cn(
				"ChannelsComposerMentionList" satisfies ChannelsComposerMentionList_ClassNames,
				"MyFloatingSurface" satisfies MyFloatingSurface_ClassNames,
			)}
			// The picker keeps the editor focus for its rows. This root also covers its padding and scrollbar.
			onMouseDown={(event) => event.preventDefault()}
		>
			<FilesNodePicker
				ref={pickerRef}
				variant="listbox"
				aria-label="People and files"
				ownerElement={editor.view.dom}
				query={query}
				select="any"
				leadingRows={rows}
				folderRow={{
					label: "Mention this folder",
					onPick: (folder) => command({ id: `file:${folder.nodeId}`, label: folder.name }),
				}}
				onPick={(row) => command({ id: `file:${row.nodeId}`, label: row.name })}
				// Keep the "@", so the suggestion stays open on the opened folder.
				clearQuery={() => editor.commands.deleteRange({ from: range.from + 1, to: range.to })}
			/>
		</div>
	);
});

// eslint-disable-next-line react-refresh/only-export-components
const ChannelMentionList = memo(function ChannelMentionList(props: ChannelsComposerMentionList_Props) {
	const { ref, editor, query, command } = props;
	const { items: allItems } = use(ChannelsMentionContext);
	const value = query.trim().toLowerCase();
	const items = allItems.filter((item) => item.label.toLowerCase().includes(value)).slice(0, 50);
	const id = useId();
	const [highlight, setHighlight] = useState({ query, index: 0 });
	const index = Math.min(highlight.query === query ? highlight.index : 0, Math.max(0, items.length - 1));
	const select = (item: ChannelsMentionItem) =>
		command({ id: `${item.kind}:${item.id}`, label: item.label, href: item.href });
	useImperativeHandle(ref, () => ({
		onKeyDown: ({ event }) => {
			if (event.isComposing) return false;
			if (event.key === "ArrowUp" || event.key === "ArrowDown") {
				if (items.length)
					setHighlight({ query, index: (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length });
				return true;
			}
			if (event.key === "Enter") {
				if (items[index]) select(items[index]);
				return true;
			}
			return false;
		},
	}));
	useEffect(() => {
		const dom = editor.view.dom;
		dom.setAttribute("aria-controls", id);
		if (items.length) dom.setAttribute("aria-activedescendant", `${id}-${index}`);
		else dom.removeAttribute("aria-activedescendant");
		return () => {
			dom.removeAttribute("aria-controls");
			dom.removeAttribute("aria-activedescendant");
		};
	}, [editor, id, index, items.length]);
	useEffect(() => {
		document.getElementById(`${id}-${index}`)?.scrollIntoView({ block: "nearest" });
	}, [id, index]);
	return (
		<div
			id={id}
			role="listbox"
			aria-label="Channels"
			className={cn(
				"ChannelsComposerMentionList" satisfies ChannelsComposerMentionList_ClassNames,
				"MyFloatingSurface" satisfies MyFloatingSurface_ClassNames,
			)}
			onMouseDown={(event) => event.preventDefault()}
		>
			{items.length ? (
				items.map((item, itemIndex) => (
					<div
						key={`${item.kind}:${item.id}`}
						id={`${id}-${itemIndex}`}
						role="option"
						aria-selected={index === itemIndex}
						className={cn(
							"ChannelsComposerMentionList-item" satisfies ChannelsComposerMentionList_ClassNames,
							"MyMenuItem" satisfies MyMenuItem_ClassNames,
						)}
						onClick={() => select(item)}
					>
						<Hash size={16} />
						<span>{item.label}</span>
					</div>
				))
			) : (
				<div className={"ChannelsComposerMentionList-status" satisfies ChannelsComposerMentionList_ClassNames}>
					No results
				</div>
			)}
		</div>
	);
});
