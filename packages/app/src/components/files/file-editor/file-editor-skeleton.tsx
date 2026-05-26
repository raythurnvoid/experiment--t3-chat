import "./file-editor-skeleton.css";
import { cn } from "../../../lib/utils.ts";

export type FileEditorSkeleton_ClassNames =
	| "FileEditorSkeleton"
	| "FileEditorSkeleton-header"
	| "FileEditorSkeleton-header-start"
	| "FileEditorSkeleton-header-end"
	| "FileEditorSkeleton-header-item"
	| "FileEditorSkeleton-toolbar"
	| "FileEditorSkeleton-content"
	| "FileEditorSkeleton-skeleton";

export function FileEditorSkeleton() {
	return (
		<div className={cn("FileEditorSkeleton" satisfies FileEditorSkeleton_ClassNames)}>
			<div className={cn("FileEditorSkeleton-header" satisfies FileEditorSkeleton_ClassNames)}>
				<div className={cn("FileEditorSkeleton-header-start" satisfies FileEditorSkeleton_ClassNames)}>
					{Array.from({ length: 3 }, (_, index) => (
						<div
							key={`header-start-${index}`}
							className={cn("FileEditorSkeleton-header-item" satisfies FileEditorSkeleton_ClassNames)}
						></div>
					))}
				</div>
				<div className={cn("FileEditorSkeleton-header-end" satisfies FileEditorSkeleton_ClassNames)}>
					{Array.from({ length: 4 }, (_, index) => (
						<div
							key={`header-end-${index}`}
							className={cn("FileEditorSkeleton-header-item" satisfies FileEditorSkeleton_ClassNames)}
						></div>
					))}
				</div>
			</div>
			<div className={cn("FileEditorSkeleton-toolbar" satisfies FileEditorSkeleton_ClassNames)}>
				{Array.from({ length: 8 }, (_, index) => (
					<div key={index} className={cn("FileEditorSkeleton-skeleton" satisfies FileEditorSkeleton_ClassNames)}></div>
				))}
			</div>
			<div className={cn("FileEditorSkeleton-content" satisfies FileEditorSkeleton_ClassNames)}>
				{Array.from({ length: 12 }, (_, index) => (
					<div key={index} className={cn("FileEditorSkeleton-skeleton" satisfies FileEditorSkeleton_ClassNames)}></div>
				))}
			</div>
		</div>
	);
}
