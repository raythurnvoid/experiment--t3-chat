import "./page-editor-skeleton.css";
import { cn } from "../../lib/utils.ts";

export type PageEditorSkeleton_ClassNames =
	| "PageEditorSkeleton"
	| "PageEditorSkeleton-header"
	| "PageEditorSkeleton-header-start"
	| "PageEditorSkeleton-header-end"
	| "PageEditorSkeleton-header-item"
	| "PageEditorSkeleton-toolbar"
	| "PageEditorSkeleton-content"
	| "PageEditorSkeleton-skeleton";

export function PageEditorSkeleton() {
	return (
		<div className={cn("PageEditorSkeleton" satisfies PageEditorSkeleton_ClassNames)}>
			<div className={cn("PageEditorSkeleton-header" satisfies PageEditorSkeleton_ClassNames)}>
				<div className={cn("PageEditorSkeleton-header-start" satisfies PageEditorSkeleton_ClassNames)}>
					{Array.from({ length: 3 }, (_, index) => (
						<div
							key={`header-start-${index}`}
							className={cn("PageEditorSkeleton-header-item" satisfies PageEditorSkeleton_ClassNames)}
						></div>
					))}
				</div>
				<div className={cn("PageEditorSkeleton-header-end" satisfies PageEditorSkeleton_ClassNames)}>
					{Array.from({ length: 4 }, (_, index) => (
						<div
							key={`header-end-${index}`}
							className={cn("PageEditorSkeleton-header-item" satisfies PageEditorSkeleton_ClassNames)}
						></div>
					))}
				</div>
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
