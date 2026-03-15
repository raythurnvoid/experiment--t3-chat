import "./page-editor-plain-text-skeleton.css";
import { cn } from "@/lib/utils.ts";

export type PageEditorPlainTextSkeleton_ClassNames =
	| "PageEditorPlainTextSkeleton"
	| "PageEditorPlainTextSkeleton-toolbar"
	| "PageEditorPlainTextSkeleton-toolbar-item"
	| "PageEditorPlainTextSkeleton-content"
	| "PageEditorPlainTextSkeleton-line";

export function PageEditorPlainTextSkeleton() {
	return (
		<div className={cn("PageEditorPlainTextSkeleton" satisfies PageEditorPlainTextSkeleton_ClassNames)}>
			<div className={cn("PageEditorPlainTextSkeleton-toolbar" satisfies PageEditorPlainTextSkeleton_ClassNames)}>
				{Array.from({ length: 3 }, (_, index) => (
					<div
						key={index}
						className={cn("PageEditorPlainTextSkeleton-toolbar-item" satisfies PageEditorPlainTextSkeleton_ClassNames)}
					></div>
				))}
			</div>
			<div className={cn("PageEditorPlainTextSkeleton-content" satisfies PageEditorPlainTextSkeleton_ClassNames)}>
				{Array.from({ length: 12 }, (_, index) => (
					<div
						key={index}
						className={cn("PageEditorPlainTextSkeleton-line" satisfies PageEditorPlainTextSkeleton_ClassNames)}
					></div>
				))}
			</div>
		</div>
	);
}
