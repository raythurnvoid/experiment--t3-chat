"use client";

import { Link, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Editor } from "@tiptap/react";
import { useState } from "react";

interface LinkSelector_Props {
	editor: Editor | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export const LinkSelector = ({ editor, open, onOpenChange }: LinkSelector_Props) => {
	const [url, set_url] = useState("");

	if (!editor) return null;

	const is_link_active = editor.isActive("link");

	const handle_set_link = () => {
		if (url) {
			editor.chain().focus().setLink({ href: url }).run();
			set_url("");
			onOpenChange(false);
		}
	};

	const handle_unset_link = () => {
		editor.chain().focus().unsetLink().run();
		onOpenChange(false);
	};

	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild>
				<Button variant="ghost" size="sm" className="flex h-8 items-center gap-2 px-2">
					<Link className="h-4 w-4" />
					<span className="text-sm">Link</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-80 p-3" align="start">
				<div className="flex flex-col gap-3">
					<div className="flex items-center gap-2">
						<Input
							placeholder="Enter URL"
							value={url}
							onChange={(e) => set_url(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									handle_set_link();
								}
							}}
						/>
						<Button size="sm" onClick={handle_set_link} disabled={!url}>
							Set Link
						</Button>
					</div>
					{is_link_active && (
						<Button variant="outline" size="sm" onClick={handle_unset_link} className="flex items-center gap-2">
							<Unlink className="h-4 w-4" />
							Remove Link
						</Button>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
};
