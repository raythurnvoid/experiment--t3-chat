import "./channels-composer-formatting.css";
import { useEditorState, type Editor } from "@tiptap/react";
import { Bold, Code, FileCode, Italic, Link, List, ListOrdered, Strikethrough } from "lucide-react";
import { memo, useState } from "react";
import { createPortal } from "react-dom";
import { MyButton } from "@/components/my-button.tsx";
import { MyIconButton } from "@/components/my-icon-button.tsx";
import { MyInput, MyInputArea, MyInputBackground, MyInputBox, MyInputControl } from "@/components/my-input.tsx";
import { MyPopover, MyPopoverContent, MyPopoverTrigger } from "@/components/my-popover.tsx";

const LINK_PROTOCOL = /^(https?:\/\/|mailto:)/i;
const LINK_ERROR = "Enter an http, https or mailto link.";

const items = [
	{ name: "bold", label: "Bold", icon: Bold, command: (editor: Editor) => editor.chain().focus().toggleBold().run() },
	{
		name: "italic",
		label: "Italic",
		icon: Italic,
		command: (editor: Editor) => editor.chain().focus().toggleItalic().run(),
	},
	{
		name: "strike",
		label: "Strikethrough",
		icon: Strikethrough,
		command: (editor: Editor) => editor.chain().focus().toggleStrike().run(),
	},
	{
		name: "code",
		label: "Inline code",
		icon: Code,
		command: (editor: Editor) => editor.chain().focus().toggleCode().run(),
	},
	{
		name: "codeBlock",
		label: "Code block",
		icon: FileCode,
		command: (editor: Editor) => editor.chain().focus().toggleCodeBlock().run(),
	},
	{
		name: "bulletList",
		label: "Bullet list",
		icon: List,
		command: (editor: Editor) => editor.chain().focus().toggleBulletList().run(),
	},
	{
		name: "orderedList",
		label: "Numbered list",
		icon: ListOrdered,
		command: (editor: Editor) => editor.chain().focus().toggleOrderedList().run(),
	},
];

const ChannelsComposerLink = memo(function ChannelsComposerLink(props: {
	editor: Editor;
	disabled: boolean;
	href: string;
}) {
	const { editor, disabled, href } = props;
	const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
	const [open, setOpen] = useState(false);
	const [url, setUrl] = useState(href);
	const [error, setError] = useState<string>();
	const validationMessage = url && !LINK_PROTOCOL.test(url) ? LINK_ERROR : undefined;
	// Native popovers stay beside their trigger. Keep this form outside the message form.
	const portal = trigger?.closest("form")?.parentElement ?? document.body;
	return (
		<MyPopover open={open} setOpen={setOpen}>
			<MyPopoverTrigger>
				<MyIconButton
					ref={setTrigger}
					variant="ghost-highlightable"
					tooltip={href ? "Edit link" : "Add link"}
					aria-pressed={!!href}
					disabled={disabled}
					onClick={() => {
						setUrl(href);
						setError(undefined);
					}}
				>
					<Link size={16} />
				</MyIconButton>
			</MyPopoverTrigger>
			{createPortal(
				<MyPopoverContent className="ChannelsComposerLink" aria-label="Message link" unmountOnHide>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							// The link form must not submit the message around it.
							event.stopPropagation();
							const chain = editor.chain().focus().extendMarkRange("link");
							if (editor.state.selection.empty && !href) {
								chain.insertContent({ type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] }).run();
							} else {
								chain.setLink({ href: url }).run();
							}
							setOpen(false);
						}}
					>
						<label>
							Link address
							<MyInput displayValidationMessage={error}>
								<MyInputBackground />
								<MyInputArea>
									<MyInputControl
										type="url"
										required
										autoFocus
										value={url}
										placeholder="https://example.com"
										validationMessage={validationMessage}
										onChange={(event) => {
											setUrl(event.target.value);
											if (error !== undefined) {
												setError(
													event.target.value &&
														LINK_PROTOCOL.test(event.target.value) &&
														!event.target.validity.typeMismatch
														? undefined
														: LINK_ERROR,
												);
											}
										}}
										onInvalid={(event) => {
											event.preventDefault();
											setError(LINK_ERROR);
										}}
									/>
								</MyInputArea>
								<MyInputBox />
							</MyInput>
						</label>
						{error && <p role="alert">{error}</p>}
						<div className="ChannelsComposerLink-actions">
							{href && (
								<MyButton
									onClick={() => {
										editor.chain().focus().extendMarkRange("link").unsetLink().run();
										setOpen(false);
									}}
								>
									Remove link
								</MyButton>
							)}
							<MyButton type="submit">Apply link</MyButton>
						</div>
					</form>
				</MyPopoverContent>,
				portal,
			)}
		</MyPopover>
	);
});

export const ChannelsComposerFormatting = memo(function ChannelsComposerFormatting(props: {
	editor: Editor;
	disabled: boolean;
}) {
	"use no memo";
	const { editor, disabled } = props;
	const formatting = useEditorState({
		editor,
		selector: ({ editor }) => ({
			active: items.map((item) => editor.isActive(item.name)),
			href: editor.getAttributes("link").href,
		}),
	});
	return (
		<div className="ChannelsComposerFormatting" role="group" aria-label="Message formatting">
			{items.map((item, index) => (
				<MyIconButton
					key={item.name}
					variant="ghost-highlightable"
					tooltip={item.label}
					aria-pressed={formatting.active[index]}
					disabled={disabled}
					onClick={() => item.command(editor)}
				>
					<item.icon size={16} />
				</MyIconButton>
			))}
			<ChannelsComposerLink
				editor={editor}
				disabled={disabled}
				href={typeof formatting.href === "string" ? formatting.href : ""}
			/>
		</div>
	);
});
