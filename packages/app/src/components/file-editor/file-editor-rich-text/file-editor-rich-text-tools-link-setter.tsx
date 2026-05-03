import "./file-editor-rich-text-tools-link-setter.css";
import { Check, Trash, LinkIcon } from "lucide-react";
import { memo, useState, useEffect, useRef } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { MyPopover, MyPopoverTrigger, MyPopoverContent } from "@/components/my-popover.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MyInput, MyInputBox, MyInputArea, MyInputControl } from "@/components/my-input.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { cn } from "@/lib/utils.ts";
import { FileEditorRichText } from "./file-editor-rich-text.tsx";
import type { FileEditorRichText_CustomAttributes } from "./file-editor-rich-text.tsx";

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

// #region form
type FileEditorRichTextToolsLinkSetterForm_ClassNames =
	| "FileEditorRichTextToolsLinkSetterForm"
	| "FileEditorRichTextToolsLinkSetterForm-input";

type FileEditorRichTextToolsLinkSetterForm_Props = {
	inputRef: React.RefObject<HTMLInputElement | null>;
	activeHref: string | false;
	onSubmit: React.FormEventHandler<HTMLFormElement>;
};

const FileEditorRichTextToolsLinkSetterForm = memo(function FileEditorRichTextToolsLinkSetterForm(
	props: FileEditorRichTextToolsLinkSetterForm_Props,
) {
	const { inputRef, activeHref, onSubmit } = props;

	return (
		<form
			onSubmit={onSubmit}
			className={cn("FileEditorRichTextToolsLinkSetterForm" satisfies FileEditorRichTextToolsLinkSetterForm_ClassNames)}
		>
			<MyInput
				className={cn("FileEditorRichTextToolsLinkSetterForm-input" satisfies FileEditorRichTextToolsLinkSetterForm_ClassNames)}
			>
				<MyInputBox />
				<MyInputArea>
					<MyInputControl ref={inputRef} type="text" placeholder="Paste a link" defaultValue={activeHref || ""} />
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
	);
});
// #endregion form

// #region root
export type FileEditorRichTextToolsLinkSetter_ClassNames =
	| "FileEditorRichTextToolsLinkSetter"
	| "FileEditorRichTextToolsLinkSetter-trigger-button"
	| "FileEditorRichTextToolsLinkSetter-trigger-button-active"
	| "FileEditorRichTextToolsLinkSetter-popover-content"
	| "FileEditorRichTextToolsLinkSetter-icon";

export type FileEditorRichTextToolsLinkSetter_Props = {
	editor: Editor;
	setDecorationHighlightOnOpen?: boolean;
};

type FileEditorRichTextToolsLinkSetterInner_Props = FileEditorRichTextToolsLinkSetter_Props & {
	activeHref: string | false;
	isLinkActive: boolean;
};

const FileEditorRichTextToolsLinkSetterInner = memo(function FileEditorRichTextToolsLinkSetterInner(
	props: FileEditorRichTextToolsLinkSetterInner_Props,
) {
	const { editor, activeHref, isLinkActive, setDecorationHighlightOnOpen = false } = props;

	const [open, setOpen] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	const triggerButtonRef = useRef<HTMLButtonElement>(null);
	const openRef = useRef(false);
	const didSetDecorationHighlightRef = useRef(false);

	const doSetOpen = useFn((next: boolean | ((prev: boolean) => boolean)) => {
		const prev = openRef.current;
		const nextOpen = typeof next === "function" ? next(prev) : next;

		openRef.current = nextOpen;
		setOpen(nextOpen);

		if (setDecorationHighlightOnOpen) {
			if (nextOpen && !prev) {
				didSetDecorationHighlightRef.current = editor.commands.setDecorationHighlight();
			} else if (!nextOpen && prev && didSetDecorationHighlightRef.current) {
				FileEditorRichText.clearDecorationHighlightProperly(editor, triggerButtonRef.current);
				didSetDecorationHighlightRef.current = false;
			}
		}
	});

	const handleSubmit = useFn((e: React.FormEvent<HTMLFormElement>) => {
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
	});

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

	// Unmount useEffect
	useEffect(() => {
		return () => {
			if (didSetDecorationHighlightRef.current) {
				FileEditorRichText.clearDecorationHighlightProperly(editor, triggerButtonRef.current);
			}
		};
	}, []);

	return (
		<div className={cn("FileEditorRichTextToolsLinkSetter" satisfies FileEditorRichTextToolsLinkSetter_ClassNames)}>
			<MyPopover open={open} setOpen={doSetOpen}>
				<MyPopoverTrigger>
					<MyButton
						ref={triggerButtonRef}
						variant="ghost"
						className={cn(
							"FileEditorRichTextToolsLinkSetter-trigger-button" satisfies FileEditorRichTextToolsLinkSetter_ClassNames,
							isLinkActive &&
								("FileEditorRichTextToolsLinkSetter-trigger-button-active" satisfies FileEditorRichTextToolsLinkSetter_ClassNames),
						)}
						{...(setDecorationHighlightOnOpen
							? ({ "data-app-set-decoration-highlight": "" } satisfies Partial<FileEditorRichText_CustomAttributes>)
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
						"FileEditorRichTextToolsLinkSetter-popover-content" satisfies FileEditorRichTextToolsLinkSetter_ClassNames,
					)}
					gutter={10}
				>
					<FileEditorRichTextToolsLinkSetterForm
						inputRef={inputRef}
						activeHref={activeHref}
						onSubmit={handleSubmit}
					/>
				</MyPopoverContent>
			</MyPopover>
		</div>
	);
});

export const FileEditorRichTextToolsLinkSetter = memo(function FileEditorRichTextToolsLinkSetter(
	props: FileEditorRichTextToolsLinkSetter_Props,
) {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor, setDecorationHighlightOnOpen = false } = props;

	// Subscribe to the derived link state so mark changes rerender immediately.
	const editorState = useEditorState({
		editor,
		selector: ({ editor }) => {
			return {
				activeHref: editor.getAttributes("link").href ?? false,
				isLinkActive: editor.isActive("link"),
			};
		},
	});

	return (
		<FileEditorRichTextToolsLinkSetterInner
			editor={editor}
			activeHref={editorState.activeHref}
			isLinkActive={editorState.isLinkActive}
			setDecorationHighlightOnOpen={setDecorationHighlightOnOpen}
		/>
	);
});
// #endregion root
