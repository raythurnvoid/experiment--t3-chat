import "./file-editor-diff-skeleton.css";
import { cn } from "@/lib/utils.ts";

export type FileEditorDiffSkeleton_ClassNames =
	| "FileEditorDiffSkeleton"
	| "FileEditorDiffSkeleton-content"
	| "FileEditorDiffSkeleton-line";

export function FileEditorDiffSkeleton() {
	return (
		<div className={cn("FileEditorDiffSkeleton" satisfies FileEditorDiffSkeleton_ClassNames)}>
			<div className={cn("FileEditorDiffSkeleton-content" satisfies FileEditorDiffSkeleton_ClassNames)}>
				{Array.from({ length: 12 }, (_, index) => (
					<div
						key={index}
						className={cn("FileEditorDiffSkeleton-line" satisfies FileEditorDiffSkeleton_ClassNames)}
					></div>
				))}
			</div>
		</div>
	);
}
