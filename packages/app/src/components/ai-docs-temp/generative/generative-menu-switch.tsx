"use client";

import { Fragment, type ReactNode, useEffect } from "react";
import { Button } from "../../ui/button";
import { cn } from "../../../lib/utils";
import { Editor } from "@tiptap/react";
import { SparklesIcon } from "lucide-react";

interface GenerativeMenuSwitch_Props {
	children: ReactNode;
	editor: Editor | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export const GenerativeMenuSwitch = ({ children, editor, open, onOpenChange }: GenerativeMenuSwitch_Props) => {
	useEffect(() => {
		if (!open && editor) {
			// Remove any AI highlighting when closed
			editor.chain().unsetHighlight().run();
		}
	}, [open, editor]);

	return (
		<div
			className={cn(
				"GenerativeMenuSwitch",
				"border-muted bg-background flex w-fit max-w-[90vw] overflow-hidden rounded-md border shadow-xl",
			)}
		>
			{open && (
				<div className={cn("GenerativeMenuSwitch-ai-panel", "p-2")}>
					<div className={cn("GenerativeMenuSwitch-ai-content", "text-muted-foreground text-sm")}>
						AI functionality coming soon
					</div>
				</div>
			)}
			{!open && (
				<Fragment>
					<Button
						className={cn("GenerativeMenuSwitch-ai-button", "gap-1 rounded-none text-purple-500")}
						variant="ghost"
						onClick={() => onOpenChange(true)}
						size="sm"
					>
						<SparklesIcon className="h-5 w-5" />
						Ask AI
					</Button>
					{children}
				</Fragment>
			)}
		</div>
	);
};

export default GenerativeMenuSwitch;
