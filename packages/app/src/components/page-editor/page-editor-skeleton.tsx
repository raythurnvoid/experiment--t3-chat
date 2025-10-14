import "./page-editor-skeleton.css";
import { cn } from "../../lib/utils.ts";

export type PageEditorSkeleton_ClassNames =
	| "PageEditorSkeleton"
	| "PageEditorSkeleton-header"
	| "PageEditorSkeleton-toolbar"
	| "PageEditorSkeleton-content"
	| "PageEditorSkeleton-skeleton";

export function PageEditorSkeleton() {
	return (
		<div className={cn("PageEditorSkeleton" satisfies PageEditorSkeleton_ClassNames)}>
			<div className={cn("PageEditorSkeleton-header" satisfies PageEditorSkeleton_ClassNames)}>
				{Array.from({ length: 2 }, (_, index) => (
					<div key={index} className={cn("PageEditorSkeleton-skeleton" satisfies PageEditorSkeleton_ClassNames)}></div>
				))}
			</div>
			<div className={cn("PageEditorSkeleton-toolbar" satisfies PageEditorSkeleton_ClassNames)}>
				{Array.from({ length: 8 }, (_, index) => (
					<div key={index} className={cn("PageEditorSkeleton-skeleton" satisfies PageEditorSkeleton_ClassNames)}></div>
				))}
			</div>
			<div className={cn("PageEditorSkeleton-content" satisfies PageEditorSkeleton_ClassNames)}>
				{Array.from({ length: 12 }, (_, index) => (
					<div key={index} className={cn("PageEditorSkeleton-skeleton" satisfies PageEditorSkeleton_ClassNames)}></div>
				))}
			</div>
		</div>
	);
}
