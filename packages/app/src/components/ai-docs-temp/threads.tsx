import React from "react";
import { useThreads } from "@liveblocks/react";
import { AnchoredThreads, FloatingThreads } from "@liveblocks/react-tiptap";
import { Editor } from "@tiptap/react";
import { useIsMobile } from "./use-is-mobile";

interface Threads_Props {
	editor: Editor | null;
}

export function Threads({ editor }: Threads_Props) {
	const { threads } = useThreads();
	const is_mobile = useIsMobile();

	if (!threads || !editor) {
		return null;
	}

	return is_mobile ? (
		<FloatingThreads threads={threads} editor={editor} />
	) : (
		<AnchoredThreads threads={threads} editor={editor} className="Threads mr-[50px] w-[350px] xl:mr-[100px]" />
	);
}
