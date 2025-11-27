import "./page-editor-rich-text-tools-comment.css";
import { useEditor } from "novel";
import { useState, useEffect, type ComponentProps } from "react";
import { toast } from "sonner";
import { useCreateThread } from "@liveblocks/react";
import { MyInput, MyInputBox, MyInputArea, MyInputControl } from "@/components/my-input.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { ArrowUp, X } from "lucide-react";
import { cn } from "@/lib/utils.ts";

export type PageEditorRichTextToolsComment_ClassNames =
	| "PageEditorRichTextToolsComment"
	| "PageEditorRichTextToolsComment-form"
	| "PageEditorRichTextToolsComment-input"
	| "PageEditorRichTextToolsComment-actions";

export type PageEditorRichTextToolsComment_Props = {
	onCancel: () => void;
};

export function PageEditorRichTextToolsComment(props: PageEditorRichTextToolsComment_Props) {
	const { onCancel } = props;

	const createThread = useCreateThread();

	const { editor } = useEditor();
	const [text, setText] = useState("");

	const handleChange: ComponentProps<"input">["onChange"] = (e) => {
		setText(e.target.value);
	};

	const handleSubmit: ComponentProps<"form">["onSubmit"] = (e) => {
		e?.preventDefault();

		if (!editor) {
			return;
		}

		if (!text.trim()) {
			toast.error("Write a comment before submitting.");
			return;
		}

		const selection = editor.state.selection;
		if (selection.empty) {
			toast.error("Select some text to attach the comment to.");
			return;
		}

		const body: any = {
			version: 1,
			content: [
				{
					type: "paragraph",
					children: [{ text }],
				},
			],
		};

		try {
			const thread = createThread({
				body,
				metadata: {},
			});
			editor.commands.addComment(thread.id);
			setText("");
			onCancel();
		} catch (err: any) {
			console.error(err);
			toast.error(err?.message ?? "Failed to create comment");
		}
	};

	// Auto-close if selection becomes empty
	useEffect(() => {
		if (editor?.state.selection.empty) {
			onCancel();
		}
	}, [editor?.state.selection.empty, onCancel]);

	return (
		<div className={cn("PageEditorRichTextToolsComment" satisfies PageEditorRichTextToolsComment_ClassNames)}>
			<form
				className={cn("PageEditorRichTextToolsComment-form" satisfies PageEditorRichTextToolsComment_ClassNames)}
				onSubmit={handleSubmit}
			>
				<MyInput
					className={cn("PageEditorRichTextToolsComment-input" satisfies PageEditorRichTextToolsComment_ClassNames)}
				>
					<MyInputBox />
					<MyInputArea>
						<MyInputControl
							type="text"
							placeholder="Add a comment..."
							autoFocus
							disabled={editor?.state.selection.empty}
							onChange={handleChange}
						/>
					</MyInputArea>
					<MyIconButton type="submit" variant="default" disabled={!text.trim() || editor?.state.selection.empty}>
						<MyIconButtonIcon>
							<ArrowUp />
						</MyIconButtonIcon>
					</MyIconButton>
				</MyInput>
			</form>

			<div className={cn("PageEditorRichTextToolsComment-actions" satisfies PageEditorRichTextToolsComment_ClassNames)}>
				<MyButton type="button" variant="ghost" onClick={onCancel}>
					<MyButtonIcon>
						<X />
					</MyButtonIcon>
					Cancel
				</MyButton>
			</div>
		</div>
	);
}
