import { useCanvasStore } from "../../stores/canvas-store";
import { useThread } from "@assistant-ui/react";
import type { ArtifactCodeContent } from "../../types/canvas";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { EditorView } from "@codemirror/view";
import { useCallback, useMemo, useEffect, useState } from "react";
import { cn } from "../../lib/utils";

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
	} = useCanvasStore();

	const thread = useThread();
	const isStreaming = thread.isRunning;

	const [isDarkMode, setIsDarkMode] = useState(false);

	const currentContent =
		getCurrentArtifactContent() as ArtifactCodeContent | null;

	// Detect dark mode
	useEffect(() => {
		const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
		const htmlElement = document.documentElement;

		const checkDarkMode = () => {
			setIsDarkMode(
				htmlElement.classList.contains("dark") || mediaQuery.matches
			);
		};

		checkDarkMode();

		const observer = new MutationObserver(checkDarkMode);
		observer.observe(htmlElement, {
			attributes: true,
			attributeFilter: ["class"],
		});

		mediaQuery.addEventListener("change", checkDarkMode);

		return () => {
			observer.disconnect();
			mediaQuery.removeEventListener("change", checkDarkMode);
		};
	}, []);

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
			<div
				className={cn(
					"CodeRenderer-empty",
					"flex items-center justify-center h-64 text-gray-500 dark:text-gray-400"
				)}
			>
				No code content available
			</div>
		);
	}

	return (
		<div
			className={cn("CodeRenderer", "h-full w-full relative")}
			onClick={handleClick}
		>
			<CodeMirror
				value={currentContent.code}
				onChange={handleChange}
				extensions={extensions}
				editable={isEditing}
				placeholder="Start coding..."
				className={cn("CodeRenderer-editor", "h-full")}
				theme={isDarkMode ? "dark" : "light"}
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
				<div
					className={cn(
						"CodeRenderer-edit-hint",
						"absolute top-4 right-4 bg-black/20 dark:bg-white/20 text-white dark:text-gray-900 px-3 py-1 rounded-md text-sm"
					)}
				>
					Click to edit
				</div>
			)}
		</div>
	);
}
