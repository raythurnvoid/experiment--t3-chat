import "./channels-composer-mention.css";
import { createContext, memo, use, useEffect, useId, useImperativeHandle, useState, type Ref } from "react";
import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import { createInlineMarkdownSpec, mergeAttributes, type Editor, type JSONContent } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { NodeViewWrapper, posToDOMRect, ReactNodeViewRenderer, ReactRenderer, type NodeViewProps } from "@tiptap/react";
import { useQuery } from "convex/react";
import Mention from "@tiptap/extension-mention";
import { exitSuggestion, type SuggestionKeyDownProps } from "@tiptap/suggestion";
import { FileText, Folder, Hash, User } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { FilesTreeProvider } from "@/lib/files-tree-context.tsx";
import type { MyFloatingSurface_ClassNames } from "@/components/my-floating-surface.tsx";
import type { MyMenuItem_ClassNames } from "@/components/my-menu.tsx";
import type { AppElementId } from "@/lib/dom-utils.ts";

export type ChannelsMentionItem =
	| { kind: "user" | "channel"; id: string; label: string; href?: string }
	| { kind: "file"; id: string; label: string; path: string; fileKind: "file" | "folder" };
export const ChannelsMentionContext = createContext<readonly ChannelsMentionItem[]>([]);
type ChannelsComposerMention_ClassNames = "ChannelsComposerMention";
type ChannelsComposerMentionList_ClassNames =
	| "ChannelsComposerMentionList"
	| "ChannelsComposerMentionList-item"
	| "ChannelsComposerMentionList-path"
	| "ChannelsComposerMentionList-status";

export const channels_composer_mention_PLUGIN_KEY = new PluginKey("channelsComposerMention");
export const channels_composer_channel_PLUGIN_KEY = new PluginKey("channelsComposerChannel");

// eslint-disable-next-line react-refresh/only-export-components
function ChannelsFileMention(props: { fileNodeId: string }) {
	const { membershipId } = AppTenantProvider.useContext();
	const file = useQuery(app_convex_api.files_nodes.get_file_node_for_membership, {
		membershipId,
		fileNodeId: props.fileNodeId,
	});
	return <>{file && file.archiveOperationId === null ? `@${file.name}` : "File unavailable"}</>;
}

// eslint-disable-next-line react-refresh/only-export-components
function ChannelsMentionNodeView(props: NodeViewProps) {
	const items = use(ChannelsMentionContext);
	const id = typeof props.node.attrs.id === "string" ? props.node.attrs.id : "";
	const item = items.find((item) => `${item.kind}:${item.id}` === id);
	return (
		<NodeViewWrapper
			as="span"
			contentEditable={false}
			className={"ChannelsComposerMention" satisfies ChannelsComposerMention_ClassNames}
		>
			{id.startsWith("file:") ? (
				<ChannelsFileMention fileNodeId={id.slice(5)} />
			) : (
				`${item?.kind === "channel" ? "#" : "@"}${item?.label ?? props.node.attrs.label ?? "Person"}`
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
					`${item?.kind === "channel" ? "#" : "@"}${item?.label ?? node.attrs.label ?? "Person"}`,
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
					let component: ReactRenderer<MentionList_Ref, MentionList_Props> | null = null;
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
							component = new ReactRenderer(MentionList, {
								editor: props.editor,
								props: { editor: props.editor, query: props.query, kind, command: props.command },
							});
							(document.getElementById("app_hoisting_container" satisfies AppElementId) ?? document.body).appendChild(
								component.element,
							);
							position(props.editor, component.element);
							editor = props.editor;
							editor.on("blur", blur);
						},
						onUpdate(props) {
							component?.updateProps({ query: props.query, command: props.command });
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

type MentionList_Ref = { onKeyDown: (props: SuggestionKeyDownProps) => boolean };
type MentionList_Props = {
	ref?: Ref<MentionList_Ref>;
	editor: Editor;
	query: string;
	kind: "user" | "channel";
	command: (attrs: { id: string; label: string; href?: string }) => void;
};

// eslint-disable-next-line react-refresh/only-export-components
const MentionList = memo(function MentionList(props: MentionList_Props) {
	const { ref, editor, query, kind, command } = props;
	const allItems = use(ChannelsMentionContext);
	const tree = FilesTreeProvider.useFullList(kind === "user");
	const value = query.trim().toLowerCase();
	const items: ChannelsMentionItem[] = [
		...allItems.filter((item) => item.kind === kind && item.label.toLowerCase().includes(value)),
		...(kind === "user"
			? (tree ?? [])
					.filter(
						(node) =>
							node.archiveOperationId === null &&
							(value.includes("/") ? (node.kind === "folder" ? `${node.path}/` : node.path) : node.name)
								.toLowerCase()
								.includes(value),
					)
					.map((node) => ({
						kind: "file" as const,
						id: node._id,
						label: node.name,
						path: node.path,
						fileKind: node.kind,
					}))
			: []),
	].slice(0, 50);
	const id = useId();
	const [highlight, setHighlight] = useState({ query, index: 0 });
	const index = Math.min(highlight.query === query ? highlight.index : 0, Math.max(0, items.length - 1));
	const select = (item: ChannelsMentionItem) =>
		command({ id: `${item.kind}:${item.id}`, label: item.label, href: item.kind === "file" ? undefined : item.href });
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
			aria-label={kind === "user" ? "People and files" : "Channels"}
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
						{item.kind === "file" ? (
							item.fileKind === "folder" ? (
								<Folder size={16} />
							) : (
								<FileText size={16} />
							)
						) : item.kind === "user" ? (
							<User size={16} />
						) : (
							<Hash size={16} />
						)}
						<span>
							{item.label}
							{item.kind === "file" && (
								<small className={"ChannelsComposerMentionList-path" satisfies ChannelsComposerMentionList_ClassNames}>
									{item.path}
								</small>
							)}
						</span>
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
