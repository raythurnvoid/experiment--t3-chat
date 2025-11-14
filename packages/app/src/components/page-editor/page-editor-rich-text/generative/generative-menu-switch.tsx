// Derived from Liveblocks:
// liveblocks\examples\nextjs-tiptap-novel\src\components\editor\generative\generative-menu-switch.tsx

import { EditorBubble, useEditor, removeAIHighlight } from "novel";
import { Fragment, type ReactNode, useEffect } from "react";
import { Button } from "../../../ui/button.tsx";
import { AISelector } from "./ai-selector.tsx";
import { Sparkles } from "lucide-react";

interface GenerativeMenuSwitchProps {
	children: ReactNode;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}
const GenerativeMenuSwitch = ({ children, open, onOpenChange }: GenerativeMenuSwitchProps) => {
	const { editor } = useEditor();

	useEffect(() => {
		if (!editor) return;

		if (!open) {
			removeAIHighlight(editor);
		}
	}, [open]);

	return (
		<EditorBubble
			appendTo={document.body}
			options={{
				placement: "bottom-start",
				onHide: () => {
					if (!editor) {
						return;
					}

					onOpenChange(false);
					removeAIHighlight(editor);
				},
			}}
			className="flex w-fit max-w-[90vw] overflow-hidden rounded-md border border-muted bg-background shadow-xl"
		>
			{open && <AISelector open={open} onOpenChange={onOpenChange} />}
			{!open && (
				<Fragment>
					<Button
						className="gap-1 rounded-none text-purple-500"
						variant="ghost"
						onClick={() => onOpenChange(true)}
						size="sm"
					>
						<Sparkles className="h-5 w-5" />
						Ask AI
					</Button>
					{children}
				</Fragment>
			)}
		</EditorBubble>
	);
};

export default GenerativeMenuSwitch;
