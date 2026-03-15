import "./page-editor-rich-text-skeleton.css";
import { cn } from "@/lib/utils.ts";

export type PageEditorRichTextSkeleton_ClassNames =
	| "PageEditorRichTextSkeleton"
	| "PageEditorRichTextSkeleton-toolbar"
	| "PageEditorRichTextSkeleton-toolbar-item"
	| "PageEditorRichTextSkeleton-content"
	| "PageEditorRichTextSkeleton-line";

export function PageEditorRichTextSkeleton() {
	return (
		<div className={cn("PageEditorRichTextSkeleton" satisfies PageEditorRichTextSkeleton_ClassNames)}>
			<div className={cn("PageEditorRichTextSkeleton-toolbar" satisfies PageEditorRichTextSkeleton_ClassNames)}>
				{Array.from({ length: 8 }, (_, index) => (
					<div
						key={index}
						className={cn("PageEditorRichTextSkeleton-toolbar-item" satisfies PageEditorRichTextSkeleton_ClassNames)}
					></div>
				))}
			</div>
			<div className={cn("PageEditorRichTextSkeleton-content" satisfies PageEditorRichTextSkeleton_ClassNames)}>
				{Array.from({ length: 12 }, (_, index) => (
					<div
						key={index}
						className={cn("PageEditorRichTextSkeleton-line" satisfies PageEditorRichTextSkeleton_ClassNames)}
					></div>
				))}
			</div>
		</div>
	);
}
