"use client";

import { Palette } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Editor } from "@tiptap/react";
import { cn } from "@/lib/utils";

interface ColorSelector_Props {
	editor: Editor | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

const colors = [
	{ name: "Default", value: "#000000" },
	{ name: "Red", value: "#ef4444" },
	{ name: "Orange", value: "#f97316" },
	{ name: "Yellow", value: "#eab308" },
	{ name: "Green", value: "#22c55e" },
	{ name: "Blue", value: "#3b82f6" },
	{ name: "Purple", value: "#a855f7" },
	{ name: "Pink", value: "#ec4899" },
];

const highlights = [
	{ name: "None", value: null },
	{ name: "Yellow", value: "#fef08a" },
	{ name: "Green", value: "#bbf7d0" },
	{ name: "Blue", value: "#bfdbfe" },
	{ name: "Purple", value: "#e9d5ff" },
	{ name: "Pink", value: "#fbcfe8" },
];

export const ColorSelector = ({ editor, open, onOpenChange }: ColorSelector_Props) => {
	if (!editor) return null;

	const handle_color_change = (color: string) => {
		editor.chain().focus().setColor(color).run();
		onOpenChange(false);
	};

	const handle_highlight_change = (color: string | null) => {
		if (color) {
			editor.chain().focus().setHighlight({ color }).run();
		} else {
			editor.chain().focus().unsetHighlight().run();
		}
		onOpenChange(false);
	};

	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild>
				<Button variant="ghost" size="sm" className="flex h-8 items-center gap-2 px-2">
					<Palette className="h-4 w-4" />
					<span className="text-sm">Color</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-64 p-3" align="start">
				<div className="space-y-4">
					<div>
						<h4 className="mb-2 text-sm font-medium">Text Color</h4>
						<div className="grid grid-cols-4 gap-2">
							{colors.map((color) => (
								<Button
									key={color.value}
									variant="outline"
									size="sm"
									className={cn(
										"h-8 w-full p-0",
										editor.isActive("textStyle", { color: color.value }) && "ring-2 ring-blue-500",
									)}
									style={{ backgroundColor: color.value }}
									onClick={() => handle_color_change(color.value)}
									title={color.name}
								/>
							))}
						</div>
					</div>
					<div>
						<h4 className="mb-2 text-sm font-medium">Highlight</h4>
						<div className="grid grid-cols-3 gap-2">
							{highlights.map((highlight) => (
								<Button
									key={highlight.name}
									variant="outline"
									size="sm"
									className={cn(
										"h-8 w-full p-0",
										highlight.value
											? editor.isActive("highlight", { color: highlight.value }) && "ring-2 ring-blue-500"
											: !editor.isActive("highlight") && "ring-2 ring-blue-500",
									)}
									style={{ backgroundColor: highlight.value || "#ffffff" }}
									onClick={() => handle_highlight_change(highlight.value)}
									title={highlight.name}
								>
									{!highlight.value && <span className="text-xs">None</span>}
								</Button>
							))}
						</div>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
};
