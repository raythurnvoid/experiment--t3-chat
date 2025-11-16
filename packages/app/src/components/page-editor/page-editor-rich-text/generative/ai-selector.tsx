import "./ai-selector.css";
import { useCompletion } from "@ai-sdk/react";
import {
	ArrowDownWideNarrow,
	ArrowUp,
	Check,
	CheckCheck,
	Loader,
	RefreshCcwDot,
	Sparkles,
	StepForward,
	TextQuote,
	TrashIcon,
	WrapText,
} from "lucide-react";
import { useEditor, addAIHighlight, getPrevText } from "novel";
import { useState } from "react";
import Markdown from "react-markdown";
import { toast } from "sonner";
import { app_fetch_main_api_url } from "../../../../lib/fetch.ts";
import {
	MyCombobox,
	MyComboboxInput,
	MyComboboxInputBox,
	MyComboboxInputArea,
	MyComboboxInputControl,
	MyComboboxList,
	MyComboboxGroup,
	MyComboboxItem,
} from "@/components/my-combobox.tsx";
import { MySeparator } from "@/components/my-separator.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { cn } from "@/lib/utils.ts";

// #region AISelector
export type AISelector_ClassNames = "AISelector" | "AISelector-container";

export type AISelector_Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

export function AISelector(props: AISelector_Props) {
	const { onOpenChange } = props;
	const { editor } = useEditor();
	const [inputValue, setInputValue] = useState("");

	const { completion, complete, isLoading } = useCompletion({
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
		<MyCombobox value={inputValue} setValue={setInputValue} open={true}>
			<div className={cn("AISelector-container" satisfies AISelector_ClassNames)}>
				{hasCompletion && <AISelector.CompletionPreview completion={completion} />}

				{isLoading && <AISelector.LoadingState />}

				{!isLoading && (
					<>
						<AISelector.InputArea
							hasCompletion={hasCompletion}
							inputValue={inputValue}
							setInputValue={setInputValue}
							completion={completion}
							complete={complete}
							editor={editor}
						/>
						{hasCompletion ? (
							<MyComboboxList>
								<AISelector.CompletionActions
									completion={completion}
									onDiscard={() => {
										if (!editor) {
											return;
										}

										editor.chain().unsetHighlight().focus().run();
										onOpenChange(false);
									}}
								/>
							</MyComboboxList>
						) : (
							<MyComboboxList>
								<AISelector.OptionList onSelect={(value, option) => complete(value, { body: { option } })} />
							</MyComboboxList>
						)}
					</>
				)}
			</div>
		</MyCombobox>
	);
}
// #endregion AISelector

// #region CompletionPreview
export type AISelectorCompletionPreview_ClassNames =
	| "AISelectorCompletionPreview"
	| "AISelectorCompletionPreview-wrapper"
	| "AISelectorCompletionPreview-content";

export type AISelectorCompletionPreview_Props = {
	completion: string;
};

function AISelectorCompletionPreview(props: AISelectorCompletionPreview_Props) {
	const { completion } = props;

	return (
		<div className={cn("AISelectorCompletionPreview-wrapper" satisfies AISelectorCompletionPreview_ClassNames)}>
			<div className={cn("AISelectorCompletionPreview-content" satisfies AISelectorCompletionPreview_ClassNames)}>
				<Markdown>{completion}</Markdown>
			</div>
		</div>
	);
}
// #endregion CompletionPreview

// #region LoadingState
export type AISelectorLoadingState_ClassNames =
	| "AISelectorLoadingState"
	| "AISelectorLoadingState-icon"
	| "AISelectorLoadingState-loader";

export type AISelectorLoadingState_Props = {};

function AISelectorLoadingState(props: AISelectorLoadingState_Props) {
	return (
		<div className={cn("AISelectorLoadingState" satisfies AISelectorLoadingState_ClassNames)}>
			<Sparkles className={cn("AISelectorLoadingState-icon" satisfies AISelectorLoadingState_ClassNames)} />
			AI is thinking
			<div className={cn("AISelectorLoadingState-loader" satisfies AISelectorLoadingState_ClassNames)}>
				<Loader />
			</div>
		</div>
	);
}
// #endregion LoadingState

// #region InputArea
export type AISelectorInputArea_ClassNames =
	| "AISelectorInputArea"
	| "AISelectorInputArea-form"
	| "AISelectorInputArea-input"
	| "AISelectorInputArea-control";

export type AISelectorInputArea_Props = {
	hasCompletion: boolean;
	inputValue: string;
	setInputValue: (value: string) => void;
	completion: string;
	complete: (prompt: string, options?: any) => Promise<any>;
	editor: ReturnType<typeof useEditor>["editor"];
};

function AISelectorInputArea(props: AISelectorInputArea_Props) {
	const { hasCompletion, inputValue, setInputValue, completion, complete, editor } = props;

	const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();

		if (!editor) {
			return;
		}

		if (completion)
			return complete(completion, {
				body: { option: "zap", command: inputValue },
			}).then(() => setInputValue(""));

		const slice = editor.state.selection.content();
		const text = (editor.storage.markdown as any).serializer.serialize(slice.content);

		complete(text, {
			body: { option: "zap", command: inputValue },
		})
			.then(() => setInputValue(""))
			.catch((e) => {
				toast.error(e.message);
			});
	};

	return (
		<div className={cn("AISelectorInputArea" satisfies AISelectorInputArea_ClassNames)}>
			<form onSubmit={handleSubmit} className={cn("AISelectorInputArea-form" satisfies AISelectorInputArea_ClassNames)}>
				<MyComboboxInput className={cn("AISelectorInputArea-input" satisfies AISelectorInputArea_ClassNames)}>
					<MyComboboxInputBox />
					<MyComboboxInputArea>
						<MyComboboxInputControl
							className={cn("AISelectorInputArea-control" satisfies AISelectorInputArea_ClassNames)}
							autoFocus
							autoSelect={false}
							placeholder={hasCompletion ? "Tell AI what to do next" : "Ask AI to edit or generate..."}
							onFocus={() => {
								if (!editor) {
									return;
								}

								addAIHighlight(editor);
							}}
							onChange={(e) => {
								setInputValue(e.target.value);
							}}
						/>
					</MyComboboxInputArea>
					<MyIconButton type="submit" variant="default">
						<MyIconButtonIcon>
							<ArrowUp />
						</MyIconButtonIcon>
					</MyIconButton>
				</MyComboboxInput>
			</form>
		</div>
	);
}
// #endregion InputArea

// #region CompletionActions
export type AISelectorCompletionActions_ClassNames =
	| "AISelectorCompletionActions-item"
	| "AISelectorCompletionActions-icon";

export type AISelectorCompletionActions_Props = {
	completion: string;
	onDiscard: () => void;
};

function AISelectorCompletionActions(props: AISelectorCompletionActions_Props) {
	const { completion, onDiscard } = props;
	const { editor } = useEditor();

	return (
		<>
			<MyComboboxGroup>
				<MyComboboxItem
					className={cn("AISelectorCompletionActions-item" satisfies AISelectorCompletionActions_ClassNames)}
					value="replace"
					hideOnClick={false}
					setValueOnClick={false}
					onClick={() => {
						if (!editor) {
							return;
						}

						const selection = editor.view.state.selection;

						editor
							.chain()
							.focus()
							.insertContentAt(
								{
									from: selection.from,
									to: selection.to,
								},
								completion,
							)
							.run();
					}}
				>
					<Check className={cn("AISelectorCompletionActions-icon" satisfies AISelectorCompletionActions_ClassNames)} />
					Replace selection
				</MyComboboxItem>
				<MyComboboxItem
					className={cn("AISelectorCompletionActions-item" satisfies AISelectorCompletionActions_ClassNames)}
					value="insert"
					hideOnClick={false}
					setValueOnClick={false}
					onClick={() => {
						if (!editor) {
							return;
						}

						const selection = editor.view.state.selection;
						editor
							.chain()
							.focus()
							.insertContentAt(selection.to + 1, completion)
							.run();
					}}
				>
					<TextQuote
						className={cn("AISelectorCompletionActions-icon" satisfies AISelectorCompletionActions_ClassNames)}
					/>
					Insert below
				</MyComboboxItem>
			</MyComboboxGroup>
			<MySeparator />

			<MyComboboxGroup>
				<MyComboboxItem
					onClick={onDiscard}
					value="thrash"
					hideOnClick={false}
					setValueOnClick={false}
					className={cn("AISelectorCompletionActions-item" satisfies AISelectorCompletionActions_ClassNames)}
				>
					<TrashIcon
						className={cn("AISelectorCompletionActions-icon" satisfies AISelectorCompletionActions_ClassNames)}
					/>
					Discard
				</MyComboboxItem>
			</MyComboboxGroup>
		</>
	);
}
// #endregion CompletionActions

// #region OptionList
export type AISelectorOptionList_ClassNames = "AISelectorOptionList-item" | "AISelectorOptionList-icon";

const options = [
	{
		value: "improve",
		label: "Improve writing",
		icon: RefreshCcwDot,
	},
	{
		value: "fix",
		label: "Fix grammar",
		icon: CheckCheck,
	},
	{
		value: "shorter",
		label: "Make shorter",
		icon: ArrowDownWideNarrow,
	},
	{
		value: "longer",
		label: "Make longer",
		icon: WrapText,
	},
] as const;

export type AISelectorOptionList_Props = {
	onSelect: (value: string, option: string) => void;
};

function AISelectorOptionList(props: AISelectorOptionList_Props) {
	const { onSelect } = props;
	const { editor } = useEditor();

	return (
		<>
			<MyComboboxGroup heading="Edit or review selection">
				{options.map((option) => (
					<MyComboboxItem
						onClick={() => {
							if (!editor) {
								return;
							}

							const slice = editor.state.selection.content();
							const text = (editor.storage.markdown as any).serializer.serialize(slice.content);
							onSelect(text, option.value);
						}}
						hideOnClick={false}
						setValueOnClick={false}
						className={cn("AISelectorOptionList-item" satisfies AISelectorOptionList_ClassNames)}
						key={option.value}
						value={option.value}
					>
						<option.icon className={cn("AISelectorOptionList-icon" satisfies AISelectorOptionList_ClassNames)} />
						{option.label}
					</MyComboboxItem>
				))}
			</MyComboboxGroup>
			<MySeparator />
			<MyComboboxGroup heading="Use AI to do more">
				<MyComboboxItem
					onClick={() => {
						if (!editor) {
							return;
						}

						const pos = editor.state.selection.from;

						const text = getPrevText(editor, pos);
						onSelect(text, "continue");
					}}
					hideOnClick={false}
					setValueOnClick={false}
					value="continue"
					className={cn("AISelectorOptionList-item" satisfies AISelectorOptionList_ClassNames)}
				>
					<StepForward className={cn("AISelectorOptionList-icon" satisfies AISelectorOptionList_ClassNames)} />
					Continue writing
				</MyComboboxItem>
			</MyComboboxGroup>
		</>
	);
}
// #endregion OptionList

// Assign compound components
AISelector.CompletionPreview = AISelectorCompletionPreview;
AISelector.LoadingState = AISelectorLoadingState;
AISelector.InputArea = AISelectorInputArea;
AISelector.CompletionActions = AISelectorCompletionActions;
AISelector.OptionList = AISelectorOptionList;
