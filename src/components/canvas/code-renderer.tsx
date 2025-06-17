import { useCanvasStore } from "../../stores/canvas-store";
import type { ArtifactCodeContent } from "../../types/canvas";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useMemo } from "react";

const getLanguageExtension = (language: string) => {
	switch (language) {
		case "javascript":
		case "typescript":
			return javascript({ jsx: true, typescript: language === "typescript" });
		case "python":
			return python();
		case "html":
			return html();
		case "css":
			return css();
		default:
			return javascript();
	}
};

interface CodeRendererProps {
	isHovering?: boolean;
}

export function CodeRenderer({ isHovering }: CodeRendererProps) {
	const {
		getCurrentArtifactContent,
		updateArtifactContent,
		isEditing,
		setIsEditing,
		isStreaming,
	} = useCanvasStore();

	const currentContent =
		getCurrentArtifactContent() as ArtifactCodeContent | null;

	const extensions = useMemo(() => {
		const exts = [EditorView.lineWrapping];
		if (currentContent?.language) {
			exts.push(getLanguageExtension(currentContent.language));
		}
		return exts;
	}, [currentContent?.language]);

	const handleChange = useCallback(
		(value: string) => {
			if (isEditing) {
				updateArtifactContent(value);
			}
		},
		[isEditing, updateArtifactContent]
	);

	const handleClick = useCallback(() => {
		if (!isStreaming && isHovering) {
			setIsEditing(true);
		}
	}, [isStreaming, isHovering, setIsEditing]);

	if (!currentContent) {
		return (
			<div className="flex items-center justify-center h-64 text-gray-500">
				No code content available
			</div>
		);
	}

	return (
		<div className="h-full w-full relative" onClick={handleClick}>
			<CodeMirror
				value={currentContent.code}
				onChange={handleChange}
				extensions={extensions}
				editable={isEditing}
				placeholder="Start coding..."
				className="h-full"
				theme="light"
				basicSetup={{
					lineNumbers: true,
					foldGutter: true,
					dropCursor: false,
					allowMultipleSelections: false,
					indentOnInput: true,
					bracketMatching: true,
					closeBrackets: true,
					autocompletion: true,
					highlightSelectionMatches: false,
				}}
			/>
			{!isEditing && isHovering && !isStreaming && (
				<div className="absolute top-4 right-4 bg-black/20 text-white px-3 py-1 rounded-md text-sm">
					Click to edit
				</div>
			)}
		</div>
	);
}
