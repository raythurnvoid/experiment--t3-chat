import { Command, CommandInput } from "../../../ui/command.tsx";
import { useCompletion } from "@ai-sdk/react";
import { ArrowUp, Loader, Sparkles } from "lucide-react";
import { useEditor, addAIHighlight } from "novel";
import { useState } from "react";
import Markdown from "react-markdown";
import { toast } from "sonner";
import { Button } from "../../../ui/button.tsx";
import AICompletionCommands from "./ai-completion-command.tsx";
import AISelectorCommands from "./ai-selector-commands.tsx";
import { app_fetch_main_api_url } from "../../../../lib/fetch.ts";

interface AISelectorProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function AISelector({ onOpenChange }: AISelectorProps) {
	const { editor } = useEditor();
	const [inputValue, setInputValue] = useState("");

	const { completion, complete, isLoading } = useCompletion({
		// id: "novel",
		api: app_fetch_main_api_url("/api/ai-docs-temp/contextual-prompt"),
		fetch: async (input, requestInit) => {
			const response = await fetch(input, requestInit);
			if (response.status === 429) {
				toast.error("You have reached your request limit for the day.");
				return response;
			}
			return response;
		},
		onError: (e) => {
			toast.error(e.message);
		},
	});

	const hasCompletion = completion.length > 0;

	return (
		<Command className="w-[350px]">
			{hasCompletion && (
				<div className="flex max-h-[400px]">
					<div className="prose dark:prose-invert prose-sm overflow-x-auto p-2 px-4">
						<Markdown>{completion}</Markdown>
					</div>
				</div>
			)}

			{isLoading && (
				<div className="flex h-12 w-full items-center px-4 text-sm font-medium text-purple-500">
					<Sparkles className="mr-2 h-4 w-4 shrink-0" />
					AI is thinking
					<div className="mt-1 ml-2">
						<Loader />
					</div>
				</div>
			)}
			{!isLoading && (
				<>
					<div className="relative">
						<CommandInput
							value={inputValue}
							onValueChange={setInputValue}
							autoFocus
							placeholder={hasCompletion ? "Tell AI what to do next" : "Ask AI to edit or generate..."}
							onFocus={() => {
								if (!editor) {
									return;
								}

								addAIHighlight(editor);
							}}
						/>
						<Button
							size="icon"
							className="absolute top-1/2 right-2 h-6 w-6 -translate-y-1/2 rounded-full bg-purple-500 hover:bg-purple-900"
							onClick={() => {
								if (!editor) {
									return;
								}

								if (completion)
									return complete(completion, {
										body: { option: "zap", command: inputValue },
									}).then(() => setInputValue(""));

								const slice = editor.state.selection.content();
								const text = editor.storage.markdown.serializer.serialize(slice.content);

								complete(text, {
									body: { option: "zap", command: inputValue },
								})
									.then(() => setInputValue(""))
									.catch((e) => {
										toast.error(e.message);
									});
							}}
						>
							<ArrowUp className="h-4 w-4" />
						</Button>
					</div>
					{hasCompletion ? (
						<AICompletionCommands
							onDiscard={() => {
								if (!editor) {
									return;
								}

								editor.chain().unsetHighlight().focus().run();
								onOpenChange(false);
							}}
							completion={completion}
						/>
					) : (
						<AISelectorCommands onSelect={(value, option) => complete(value, { body: { option } })} />
					)}
				</>
			)}
		</Command>
	);
}
