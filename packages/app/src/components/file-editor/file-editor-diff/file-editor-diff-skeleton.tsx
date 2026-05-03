import "./file-editor-diff-skeleton.css";
import { cn } from "@/lib/utils.ts";

export type FileEditorDiffSkeleton_ClassNames =
	| "FileEditorDiffSkeleton"
	| "FileEditorDiffSkeleton-toolbar"
	| "FileEditorDiffSkeleton-toolbar-item"
	| "FileEditorDiffSkeleton-content"
	| "FileEditorDiffSkeleton-line";

export function FileEditorDiffSkeleton() {
	return (
		<div className={cn("FileEditorDiffSkeleton" satisfies FileEditorDiffSkeleton_ClassNames)}>
			<div className={cn("FileEditorDiffSkeleton-toolbar" satisfies FileEditorDiffSkeleton_ClassNames)}>
				{Array.from({ length: 6 }, (_, index) => (
					<div
						key={index}
						className={cn("FileEditorDiffSkeleton-toolbar-item" satisfies FileEditorDiffSkeleton_ClassNames)}
					></div>
				))}
			</div>
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
