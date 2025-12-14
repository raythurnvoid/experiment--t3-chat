import "./page-editor-rich-text-tools-link-setter.css";
import { Check, Trash, LinkIcon } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { MyPopover, MyPopoverTrigger, MyPopoverContent } from "@/components/my-popover.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MyInput, MyInputBox, MyInputArea, MyInputControl } from "@/components/my-input.tsx";
import { cn } from "@/lib/utils.ts";
import { PageEditorRichText } from "./page-editor-rich-text.tsx";
import type { PageEditorRichText_CustomAttributes } from "./page-editor-rich-text.tsx";

function isValidUrl(url: string) {
	try {
		new URL(url);
		return true;
	} catch (_e) {
		return false;
	}
}

function getUrlFromString(str: string) {
	if (isValidUrl(str)) return str;
	try {
		if (str.includes(".") && !str.includes(" ")) {
			return new URL(`https://${str}`).toString();
		}
	} catch (_e) {
		return null;
	}
}

export type PageEditorRichTextToolsLinkSetter_ClassNames =
	| "PageEditorRichTextToolsLinkSetter"
	| "PageEditorRichTextToolsLinkSetter-trigger-button"
	| "PageEditorRichTextToolsLinkSetter-trigger-button-active"
	| "PageEditorRichTextToolsLinkSetter-popover-content"
	| "PageEditorRichTextToolsLinkSetter-form"
	| "PageEditorRichTextToolsLinkSetter-input"
	| "PageEditorRichTextToolsLinkSetter-icon";

export type PageEditorRichTextToolsLinkSetter_Props = {
	editor: Editor;
	setDecorationHighlightOnOpen?: boolean;
};

export function PageEditorRichTextToolsLinkSetter(props: PageEditorRichTextToolsLinkSetter_Props) {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor, setDecorationHighlightOnOpen = false } = props;

	// Subscribe to editor state changes to trigger re-renders when selection changes
	useEditorState({
		editor,
		selector: ({ editor }) => {
			return {
				selection: editor.state.selection,
			};
		},
	});

	const [open, setOpen] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	const triggerButtonRef = useRef<HTMLButtonElement>(null);
	const openRef = useRef(false);
	const didSetDecorationHighlightRef = useRef(false);

	const doSetOpen = (next: boolean | ((prev: boolean) => boolean)) => {
		const prev = openRef.current;
		const nextOpen = typeof next === "function" ? next(prev) : next;

		openRef.current = nextOpen;
		setOpen(nextOpen);

		if (setDecorationHighlightOnOpen) {
			if (nextOpen && !prev) {
				didSetDecorationHighlightRef.current = editor.commands.setDecorationHighlight();
			} else if (!nextOpen && prev && didSetDecorationHighlightRef.current) {
				PageEditorRichText.clearDecorationHighlightProperly(editor, triggerButtonRef.current);
				didSetDecorationHighlightRef.current = false;
			}
		}
	};

	// Autofocus only when the popover opens (not on every render)
	useEffect(() => {
		if (!open) {
			return;
		}

		const focusTimeout = setTimeout(() => {
			inputRef.current?.focus();
		});

		return () => {
			clearTimeout(focusTimeout);
		};
	}, [open]);

	const activeHref = editor?.getAttributes("link").href ?? false;

	const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
		const target = e.currentTarget as HTMLFormElement;
		e.preventDefault();

		const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;

		if (submitter?.name === "delete") {
			if (editor) {
				editor.chain().focus().unsetLink().run();
				if (inputRef.current) {
					inputRef.current.value = "";
				}
				doSetOpen(false);
			}
		} else {
			const input = target[0] as HTMLInputElement;
			const url = getUrlFromString(input.value);
			if (url && editor) {
				editor.chain().focus().setLink({ href: url }).run();
				doSetOpen(false);
			}
		}
	};

	// Unmount useEffect
	useEffect(() => {
		return () => {
			if (didSetDecorationHighlightRef.current) {
				PageEditorRichText.clearDecorationHighlightProperly(editor, triggerButtonRef.current);
			}
		};
	}, []);

	return (
		<div className={cn("PageEditorRichTextToolsLinkSetter" satisfies PageEditorRichTextToolsLinkSetter_ClassNames)}>
			<MyPopover open={open} setOpen={doSetOpen}>
				<MyPopoverTrigger>
					<MyButton
						ref={triggerButtonRef}
						variant="ghost"
						className={cn(
							"PageEditorRichTextToolsLinkSetter-trigger-button" satisfies PageEditorRichTextToolsLinkSetter_ClassNames,
							editor.isActive("link") &&
								("PageEditorRichTextToolsLinkSetter-trigger-button-active" satisfies PageEditorRichTextToolsLinkSetter_ClassNames),
						)}
						{...(setDecorationHighlightOnOpen
							? ({ "data-app-set-decoration-highlight": "" } satisfies Partial<PageEditorRichText_CustomAttributes>)
							: {})}
					>
						<MyButtonIcon>
							<LinkIcon />
						</MyButtonIcon>
						Link
					</MyButton>
				</MyPopoverTrigger>
				<MyPopoverContent
					className={cn(
						"PageEditorRichTextToolsLinkSetter-popover-content" satisfies PageEditorRichTextToolsLinkSetter_ClassNames,
					)}
					gutter={10}
				>
					<form
						onSubmit={handleSubmit}
						className={cn(
							"PageEditorRichTextToolsLinkSetter-form" satisfies PageEditorRichTextToolsLinkSetter_ClassNames,
						)}
					>
						<MyInput
							className={cn(
								"PageEditorRichTextToolsLinkSetter-input" satisfies PageEditorRichTextToolsLinkSetter_ClassNames,
							)}
						>
							<MyInputBox />
							<MyInputArea>
								<MyInputControl
									ref={inputRef}
									type="text"
									placeholder="Paste a link"
									defaultValue={editor.getAttributes("link").href || ""}
								/>
							</MyInputArea>
						</MyInput>
						{activeHref ? (
							<MyIconButton variant="destructive" type="submit" name="delete">
								<MyIconButtonIcon>
									<Trash />
								</MyIconButtonIcon>
							</MyIconButton>
						) : (
							<MyIconButton variant="default" type="submit">
								<MyIconButtonIcon>
									<Check />
								</MyIconButtonIcon>
							</MyIconButton>
						)}
					</form>
				</MyPopoverContent>
			</MyPopover>
		</div>
	);
}
