import "./file-editor-plain-text-skeleton.css";
import { cn } from "@/lib/utils.ts";

export type FileEditorPlainTextSkeleton_ClassNames =
	| "FileEditorPlainTextSkeleton"
	| "FileEditorPlainTextSkeleton-content"
	| "FileEditorPlainTextSkeleton-line";

export function FileEditorPlainTextSkeleton() {
	return (
		<div className={cn("FileEditorPlainTextSkeleton" satisfies FileEditorPlainTextSkeleton_ClassNames)}>
			<div className={cn("FileEditorPlainTextSkeleton-content" satisfies FileEditorPlainTextSkeleton_ClassNames)}>
				{Array.from({ length: 12 }, (_, index) => (
					<div
						key={index}
						className={cn("FileEditorPlainTextSkeleton-line" satisfies FileEditorPlainTextSkeleton_ClassNames)}
					></div>
				))}
			</div>
		</div>
	);
}
