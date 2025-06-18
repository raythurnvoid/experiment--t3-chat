import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { cn } from "../lib/utils";
import { useEffect, useState } from "react";
import { BlockNoteEditor } from "@blocknote/core";
import { MantineProvider } from "@mantine/core";

export function BlockNoteIsolated() {
	const [error, setError] = useState<string | null>(null);
	const [mounted, setMounted] = useState(false);

	let editor: BlockNoteEditor | null = null;
	try {
		editor = useCreateBlockNote({
			initialContent: [
				{
					type: "paragraph",
					content: "Start typing here...",
				},
			],
		});
	} catch (err) {
		console.error("Error creating BlockNote editor:", err);
		setError(err instanceof Error ? err.message : String(err));
	}

	// Log when component mounts
	useEffect(() => {
		console.log("BlockNoteIsolated component mounted");
		setMounted(true);
	}, []);

	// Log editor creation
	useEffect(() => {
		if (editor) {
			console.log("BlockNote editor created:", editor);
			console.log("Editor document:", editor.document);
		}
	}, [editor]);

	if (error) {
		return (
			<div
				className={cn(
					"BlockNoteIsolated-error",
					"w-full h-screen p-8 bg-background"
				)}
			>
				<h1
					className={cn(
						"BlockNoteIsolated-error-title",
						"text-2xl font-bold mb-4 text-destructive"
					)}
				>
					BlockNote Error
				</h1>
				<pre
					className={cn(
						"BlockNoteIsolated-error-message",
						"p-4 bg-destructive/10 rounded text-destructive"
					)}
				>
					{error}
				</pre>
			</div>
		);
	}

	if (!editor) {
		return (
			<div
				className={cn(
					"BlockNoteIsolated-loading",
					"w-full h-screen p-8 bg-background flex items-center justify-center"
				)}
			>
				<p
					className={cn(
						"BlockNoteIsolated-loading-text",
						"text-muted-foreground"
					)}
				>
					Loading BlockNote editor...
				</p>
			</div>
		);
	}

	return (
		<MantineProvider>
			<div
				className={cn("BlockNoteIsolated", "w-full h-screen p-8 bg-background")}
			>
				<h1
					className={cn(
						"BlockNoteIsolated-title",
						"text-2xl font-bold mb-4 text-foreground"
					)}
				>
					BlockNote Isolated Test (Mantine)
				</h1>

				<div
					className={cn(
						"BlockNoteIsolated-info",
						"mb-4 text-sm text-muted-foreground"
					)}
				>
					<p>
						Theme:{" "}
						{typeof window !== "undefined" &&
						document.documentElement.classList.contains("dark")
							? "dark"
							: "light"}
					</p>
					<p>Editor initialized: {editor ? "Yes" : "No"}</p>
					<p>Component mounted: {mounted ? "Yes" : "No"}</p>
					<p>Using: BlockNote Mantine</p>
				</div>

				<div
					className={cn(
						"BlockNoteIsolated-container",
						"w-full h-[calc(100vh-12rem)] border rounded-lg p-4 bg-card"
					)}
				>
					<BlockNoteView
						editor={editor}
						theme={
							typeof window !== "undefined" &&
							document.documentElement.classList.contains("dark")
								? "dark"
								: "light"
						}
						onChange={() => console.log("BlockNote content changed")}
					/>
				</div>
			</div>
		</MantineProvider>
	);
}
