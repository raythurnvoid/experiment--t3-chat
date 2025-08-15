import { EditorBubble, useEditor, removeAIHighlight } from "novel";
import { Fragment, type ReactNode, useEffect } from "react";
import { Button } from "../../ui/button";
import { AISelector } from "./ai-selector";
import { Sparkles } from "lucide-react";

interface GenerativeMenuSwitchProps {
	children: ReactNode;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}
const GenerativeMenuSwitch = ({ children, open, onOpenChange }: GenerativeMenuSwitchProps) => {
	const { editor } = useEditor();

	useEffect(() => {
		if (!open && editor) removeAIHighlight(editor);
	}, [open]);

	return (
		<EditorBubble
			tippyOptions={{
				placement: open ? "bottom-start" : "top",
				onHidden: () => {
					if (!editor) {
						return;
					}

					onOpenChange(false);
					editor.chain().unsetHighlight().run();
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
