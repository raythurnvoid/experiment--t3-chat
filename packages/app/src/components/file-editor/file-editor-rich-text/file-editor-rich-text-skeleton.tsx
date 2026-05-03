import "./file-editor-rich-text-skeleton.css";
import { cn } from "@/lib/utils.ts";

export type FileEditorRichTextSkeleton_ClassNames =
	| "FileEditorRichTextSkeleton"
	| "FileEditorRichTextSkeleton-toolbar"
	| "FileEditorRichTextSkeleton-toolbar-item"
	| "FileEditorRichTextSkeleton-content"
	| "FileEditorRichTextSkeleton-line";

export function FileEditorRichTextSkeleton() {
	return (
		<div className={cn("FileEditorRichTextSkeleton" satisfies FileEditorRichTextSkeleton_ClassNames)}>
			<div className={cn("FileEditorRichTextSkeleton-toolbar" satisfies FileEditorRichTextSkeleton_ClassNames)}>
				{Array.from({ length: 8 }, (_, index) => (
					<div
						key={index}
						className={cn("FileEditorRichTextSkeleton-toolbar-item" satisfies FileEditorRichTextSkeleton_ClassNames)}
					></div>
				))}
			</div>
			<div className={cn("FileEditorRichTextSkeleton-content" satisfies FileEditorRichTextSkeleton_ClassNames)}>
				{Array.from({ length: 12 }, (_, index) => (
					<div
						key={index}
						className={cn("FileEditorRichTextSkeleton-line" satisfies FileEditorRichTextSkeleton_ClassNames)}
					></div>
				))}
			</div>
		</div>
	);
}
