"use client";

import { Calculator } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Editor } from "@tiptap/react";

interface MathSelector_Props {
	editor: Editor | null;
}

export const MathSelector = ({ editor }: MathSelector_Props) => {
	if (!editor) return null;

	const handle_add_math = () => {
		// This would integrate with math extension
		// For now, we'll just insert a placeholder
		editor.chain().focus().insertContent("$$equation$$").run();
	};

	return (
		<Button variant="ghost" size="sm" onClick={handle_add_math} className="flex h-8 items-center gap-2 px-2">
			<Calculator className="h-4 w-4" />
			<span className="text-sm">Math</span>
		</Button>
	);
};
