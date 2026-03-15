import "./page-editor-diff-skeleton.css";
import { cn } from "@/lib/utils.ts";

export type PageEditorDiffSkeleton_ClassNames =
	| "PageEditorDiffSkeleton"
	| "PageEditorDiffSkeleton-toolbar"
	| "PageEditorDiffSkeleton-toolbar-item"
	| "PageEditorDiffSkeleton-content"
	| "PageEditorDiffSkeleton-line";

export function PageEditorDiffSkeleton() {
	return (
		<div className={cn("PageEditorDiffSkeleton" satisfies PageEditorDiffSkeleton_ClassNames)}>
			<div className={cn("PageEditorDiffSkeleton-toolbar" satisfies PageEditorDiffSkeleton_ClassNames)}>
				{Array.from({ length: 6 }, (_, index) => (
					<div
						key={index}
						className={cn("PageEditorDiffSkeleton-toolbar-item" satisfies PageEditorDiffSkeleton_ClassNames)}
					></div>
				))}
			</div>
			<div className={cn("PageEditorDiffSkeleton-content" satisfies PageEditorDiffSkeleton_ClassNames)}>
				{Array.from({ length: 12 }, (_, index) => (
					<div
						key={index}
						className={cn("PageEditorDiffSkeleton-line" satisfies PageEditorDiffSkeleton_ClassNames)}
					></div>
				))}
			</div>
		</div>
	);
}
