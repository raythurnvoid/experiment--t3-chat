import "./page-editor-rich-text-tools-link-setter.css";
import { Check, Trash, LinkIcon } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { useEditor } from "novel";
import { useEditorState } from "@tiptap/react";
import { MyPopover, MyPopoverTrigger, MyPopoverContent } from "@/components/my-popover.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MyInput, MyInputBox, MyInputArea, MyInputControl } from "@/components/my-input.tsx";
import { cn } from "@/lib/utils.ts";

// eslint-disable-next-line react-refresh/only-export-components
export function isValidUrl(url: string) {
	try {
		new URL(url);
		return true;
	} catch (_e) {
		return false;
	}
}
// eslint-disable-next-line react-refresh/only-export-components
export function getUrlFromString(str: string) {
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

export type PageEditorRichTextToolsLinkSetter_Props = {};

export function PageEditorRichTextToolsLinkSetter(props: PageEditorRichTextToolsLinkSetter_Props) {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor } = useEditor();

	// Subscribe to editor state changes to trigger re-renders when selection changes
	useEditorState({
		editor,
		selector: ({ editor }) => {
			if (!editor) return null;
			return {
				selection: editor.state.selection,
			};
		},
	});

	const [open, setOpen] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	// Autofocus on input by default
	useEffect(() => {
		inputRef.current?.focus();
	});

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
				setOpen(false);
			}
		} else {
			const input = target[0] as HTMLInputElement;
			const url = getUrlFromString(input.value);
			if (url && editor) {
				editor.chain().focus().setLink({ href: url }).run();
				setOpen(false);
			}
		}
	};

	if (!editor) return null;

	return (
		<div className={cn("PageEditorRichTextToolsLinkSetter" satisfies PageEditorRichTextToolsLinkSetter_ClassNames)}>
			<MyPopover open={open} setOpen={setOpen}>
				<MyPopoverTrigger>
					<MyButton
						variant="ghost"
						className={cn(
							"PageEditorRichTextToolsLinkSetter-trigger-button" satisfies PageEditorRichTextToolsLinkSetter_ClassNames,
							editor.isActive("link") &&
								("PageEditorRichTextToolsLinkSetter-trigger-button-active" satisfies PageEditorRichTextToolsLinkSetter_ClassNames),
						)}
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
