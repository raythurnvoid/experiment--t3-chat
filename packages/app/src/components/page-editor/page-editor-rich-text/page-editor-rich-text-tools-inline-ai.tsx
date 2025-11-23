import "./page-editor-rich-text-tools-inline-ai.css";
import { useCompletion } from "@ai-sdk/react";
import {
	ArrowDownWideNarrow,
	ArrowUp,
	Check,
	CheckCheck,
	RefreshCcwDot,
	StepForward,
	TextQuote,
	TrashIcon,
	WrapText,
} from "lucide-react";
import { useEditor } from "novel";
import { useEffect, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import { toast } from "sonner";
import { app_fetch_main_api_url } from "../../../lib/fetch.ts";
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
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import { MySpinner } from "@/components/ui/my-spinner.tsx";
import { cn } from "@/lib/utils.ts";

const OPTIONS = {
	transform: [
		{
			value: "improve",
			label: "Improve writing",
			Icon: RefreshCcwDot,
		},
		{
			value: "fix",
			label: "Fix grammar",
			Icon: CheckCheck,
		},
		{
			value: "shorter",
			label: "Make shorter",
			Icon: ArrowDownWideNarrow,
		},
		{
			value: "longer",
			label: "Make longer",
			Icon: WrapText,
		},
	],
	continue: [
		{
			value: "continue",
			label: "Continue writing",
			Icon: StepForward,
		},
	],
} as const;

type GenerationOptionSelectable = "improve" | "fix" | "shorter" | "longer" | "continue";

type GenerationOption = GenerationOptionSelectable | "zap";

// #region CompletionPreview
export type PageEditorRichTextToolsInlineAiCompletionPreview_ClassNames =
	| "PageEditorRichTextToolsInlineAiCompletionPreview"
	| "PageEditorRichTextToolsInlineAiCompletionPreview-wrapper"
	| "PageEditorRichTextToolsInlineAiCompletionPreview-content"
	| "PageEditorRichTextToolsInlineAiCompletionPreview-loader";

export type PageEditorRichTextToolsInlineAiCompletionPreview_Props = {
	completion: string;
	isLoading: boolean;
};

function PageEditorRichTextToolsInlineAiCompletionPreview(
	props: PageEditorRichTextToolsInlineAiCompletionPreview_Props,
) {
	const { completion, isLoading } = props;

	return (
		<div
			className={cn(
				"PageEditorRichTextToolsInlineAiCompletionPreview-wrapper" satisfies PageEditorRichTextToolsInlineAiCompletionPreview_ClassNames,
			)}
		>
			<div
				className={cn(
					"PageEditorRichTextToolsInlineAiCompletionPreview-content" satisfies PageEditorRichTextToolsInlineAiCompletionPreview_ClassNames,
				)}
			>
				{isLoading ? (
					<div
						className={cn(
							"PageEditorRichTextToolsInlineAiCompletionPreview-loader" satisfies PageEditorRichTextToolsInlineAiCompletionPreview_ClassNames,
						)}
					>
						<MySpinner />
						Generating new content&hellip;
					</div>
				) : (
					completion && <Markdown>{completion}</Markdown>
				)}
			</div>
		</div>
	);
}
// #endregion CompletionPreview

// #region InputArea
export type PageEditorRichTextToolsInlineAiInputArea_ClassNames =
	| "PageEditorRichTextToolsInlineAiInputArea"
	| "PageEditorRichTextToolsInlineAiInputArea-input"
	| "PageEditorRichTextToolsInlineAiInputArea-control";

export type PageEditorRichTextToolsInlineAiInputArea_Props = {
	placeholder: string;
	disabled: boolean;
};

function PageEditorRichTextToolsInlineAiInputArea(props: PageEditorRichTextToolsInlineAiInputArea_Props) {
	const { placeholder, disabled } = props;

	return (
		<div
			className={cn(
				"PageEditorRichTextToolsInlineAiInputArea" satisfies PageEditorRichTextToolsInlineAiInputArea_ClassNames,
			)}
		>
			<MyComboboxInput
				className={cn(
					"PageEditorRichTextToolsInlineAiInputArea-input" satisfies PageEditorRichTextToolsInlineAiInputArea_ClassNames,
				)}
			>
				<MyComboboxInputBox />
				<MyComboboxInputArea>
					<MyComboboxInputControl
						className={cn(
							"PageEditorRichTextToolsInlineAiInputArea-control" satisfies PageEditorRichTextToolsInlineAiInputArea_ClassNames,
						)}
						autoSelect={false}
						placeholder={placeholder}
						autoFocus={!disabled}
						disabled={disabled}
					/>
				</MyComboboxInputArea>
				<MyIconButton type="submit" variant="default" disabled={disabled}>
					<MyIconButtonIcon>
						<ArrowUp />
					</MyIconButtonIcon>
				</MyIconButton>
			</MyComboboxInput>
		</div>
	);
}
// #endregion InputArea

// #region GenerationActions
export type PageEditorRichTextToolsInlineAiGenerationActions_ClassNames =
	| "PageEditorRichTextToolsInlineAiGenerationActions"
	| "PageEditorRichTextToolsInlineAiGenerationActions-icon";

export type PageEditorRichTextToolsInlineAiGenerationActions_Props = {
	onReplaceSelection: () => void;
	onInsertBelow: () => void;
	onDiscard: () => void;
	disabled: boolean;
};

function PageEditorRichTextToolsInlineAiGenerationActions(
	props: PageEditorRichTextToolsInlineAiGenerationActions_Props,
) {
	const { onReplaceSelection, onInsertBelow, onDiscard, disabled } = props;

	return (
		<div
			className={cn(
				"PageEditorRichTextToolsInlineAiGenerationActions" satisfies PageEditorRichTextToolsInlineAiGenerationActions_ClassNames,
			)}
		>
			<MyButton onClick={onReplaceSelection} variant="outline" disabled={disabled}>
				<MyButtonIcon>
					<Check
						className={cn(
							"PageEditorRichTextToolsInlineAiGenerationActions-icon" satisfies PageEditorRichTextToolsInlineAiGenerationActions_ClassNames,
						)}
					/>
				</MyButtonIcon>
				Replace selection
			</MyButton>
			<MyButton onClick={onInsertBelow} variant="outline" disabled={disabled}>
				<MyButtonIcon>
					<TextQuote
						className={cn(
							"PageEditorRichTextToolsInlineAiGenerationActions-icon" satisfies PageEditorRichTextToolsInlineAiGenerationActions_ClassNames,
						)}
					/>
				</MyButtonIcon>
				Insert below
			</MyButton>
			<MyButton onClick={onDiscard} variant="ghost" disabled={disabled}>
				<MyButtonIcon>
					<TrashIcon
						className={cn(
							"PageEditorRichTextToolsInlineAiGenerationActions-icon" satisfies PageEditorRichTextToolsInlineAiGenerationActions_ClassNames,
						)}
					/>
				</MyButtonIcon>
				Discard
			</MyButton>
		</div>
	);
}
// #endregion GenerationActions

// #region OptionItem
export type PageEditorRichTextToolsInlineAiOptionItem_ClassNames =
	| "PageEditorRichTextToolsInlineAiOptionItem"
	| "PageEditorRichTextToolsInlineAiOptionItem-icon";

export type PageEditorRichTextToolsInlineAiOptionItem_Props = {
	value: GenerationOptionSelectable;
	label: string;
	onClick: () => void;
	icon: ReactNode;
};

function PageEditorRichTextToolsInlineAiOptionItem(props: PageEditorRichTextToolsInlineAiOptionItem_Props) {
	const { value, label, onClick, icon } = props;

	return (
		<MyComboboxItem
			className={cn(
				"PageEditorRichTextToolsInlineAiOptionItem" satisfies PageEditorRichTextToolsInlineAiOptionItem_ClassNames,
			)}
			value={value}
			hideOnClick={false}
			setValueOnClick={false}
			onClick={onClick}
		>
			{icon}
			{label}
		</MyComboboxItem>
	);
}
// #endregion OptionItem

// #region OptionList
export type PageEditorRichTextToolsInlineAiOptionList_ClassNames = "PageEditorRichTextToolsInlineAiOptionList";

export type PageEditorRichTextToolsInlineAiOptionList_Props = {
	filter: string;
	onSelect: (option: GenerationOptionSelectable) => void;
};

function PageEditorRichTextToolsInlineAiOptionList(props: PageEditorRichTextToolsInlineAiOptionList_Props) {
	const { filter, onSelect } = props;

	const filteredOptions = {
		transform: OPTIONS.transform.filter((option) => option.label.toLowerCase().includes(filter.toLowerCase())),
		continue: OPTIONS.continue.filter((option) => option.label.toLowerCase().includes(filter.toLowerCase())),
	} as const;

	return (
		<MyComboboxList
			className={cn(
				"PageEditorRichTextToolsInlineAiOptionList" satisfies PageEditorRichTextToolsInlineAiOptionList_ClassNames,
			)}
		>
			<MyComboboxGroup heading="Edit or review selection">
				{filteredOptions.transform.map((option) => (
					<PageEditorRichTextToolsInlineAiOptionItem
						key={option.value}
						value={option.value}
						label={option.label}
						icon={
							<MyIcon
								className={cn(
									"PageEditorRichTextToolsInlineAiOptionItem-icon" satisfies PageEditorRichTextToolsInlineAiOptionItem_ClassNames,
								)}
							>
								<option.Icon />
							</MyIcon>
						}
						onClick={() => {
							onSelect(option.value);
						}}
					/>
				))}
			</MyComboboxGroup>
			{filteredOptions.continue.length > 0 && (
				<>
					{filteredOptions.transform.length > 0 && <MySeparator />}
					<MyComboboxGroup heading="Use AI to do more">
						{filteredOptions.continue.map((option) => (
							<PageEditorRichTextToolsInlineAiOptionItem
								key={option.value}
								value={option.value}
								label={option.label}
								icon={
									<MyIcon
										className={cn(
											"PageEditorRichTextToolsInlineAiOptionItem-icon" satisfies PageEditorRichTextToolsInlineAiOptionItem_ClassNames,
										)}
									>
										<option.Icon />
									</MyIcon>
								}
								onClick={() => {
									onSelect(option.value);
								}}
							/>
						))}
					</MyComboboxGroup>
				</>
			)}
		</MyComboboxList>
	);
}
// #endregion OptionList

// #region PageEditorRichTextToolsInlineAi
export type PageEditorRichTextToolsInlineAi_ClassNames =
	| "PageEditorRichTextToolsInlineAi"
	| "PageEditorRichTextToolsInlineAi-container";

export type PageEditorRichTextToolsInlineAi_Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

export function PageEditorRichTextToolsInlineAi(props: PageEditorRichTextToolsInlineAi_Props) {
	const { onOpenChange } = props;
	const { editor } = useEditor();
	const [inputValue, setInputValue] = useState("");
	const formRef = useRef<HTMLFormElement>(null);

	const completionInst = useCompletion({
		api: app_fetch_main_api_url("/api/ai-docs-temp/contextual-prompt"),
		fetch: async (input, requestInit) => {
			const response = await fetch(input, requestInit);
			if (response.status === 429) {
				throw new Error("You have reached your request limit for the day.");
			}
			return response;
		},
		onError: (e) => {
			toast.error(e.message);
		},
	});

	const isLoading = completionInst.isLoading;
	const hasCompletion = completionInst.completion.length > 0;

	function triggerGeneration(args: { text: string; option: GenerationOption; command?: string }) {
		if (!editor || !editor.markdown) {
			return;
		}

		completionInst
			.complete(args.text, {
				body: { option: args.option, command: args.command },
			})
			.catch((e) => {
				console.error(e);
				toast.error(e.message);
			});
	}

	const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();

		if (!editor || !editor.markdown) {
			return;
		}

		if (completionInst.completion) {
			return completionInst.complete(completionInst.completion, {
				body: { option: "zap", command: inputValue },
			});
		}

		const slice = editor.state.selection.content();
		const text = editor.markdown.serialize(slice.content.toJSON());

		triggerGeneration({ text, option: "zap", command: inputValue });

		setInputValue("");
	};

	const handleOptionSelect = (option: GenerationOptionSelectable) => {
		if (!editor || !editor.markdown) {
			return;
		}

		switch (option) {
			case "continue": {
				const pos = editor.state.selection.from;
				const slice = editor.state.doc.slice(0, pos);
				const json = slice.content.toJSON();
				const text = editor.markdown.serialize(json);
				triggerGeneration({ text, option });
				break;
			}
			default: {
				const slice = editor.state.selection.content();
				const text = editor.markdown.serialize(slice.content.toJSON());
				triggerGeneration({ text, option });
				break;
			}
		}

		setInputValue("");
	};

	const handleReplaceSelection = () => {
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
				completionInst.completion,
			)
			.run();
	};

	const handleInsertBelow = () => {
		if (!editor) {
			return;
		}

		const selection = editor.view.state.selection;
		editor
			.chain()
			.focus()
			.insertContentAt(selection.to + 1, completionInst.completion)
			.run();
	};

	const handleDiscard = () => {
		if (!editor) {
			return;
		}

		editor.chain().clearAIHighlight().focus().run();
		onOpenChange(false);
	};

	useEffect(() => {
		if (!editor) {
			return;
		}

		editor.chain().setAIHighlight().run();
	}, [editor]);

	return (
		<MyCombobox value={inputValue} setValue={setInputValue} open={true}>
			{editor && (
				<form ref={formRef} onSubmit={handleSubmit}>
					<div
						className={cn(
							"PageEditorRichTextToolsInlineAi-container" satisfies PageEditorRichTextToolsInlineAi_ClassNames,
						)}
					>
						{(hasCompletion || isLoading) && (
							<PageEditorRichTextToolsInlineAiCompletionPreview
								completion={completionInst.completion}
								isLoading={isLoading}
							/>
						)}

						<PageEditorRichTextToolsInlineAiInputArea
							placeholder={hasCompletion ? "Tell AI what to do next" : "Ask AI to edit or generate..."}
							disabled={isLoading}
						/>

						{hasCompletion || isLoading ? (
							<PageEditorRichTextToolsInlineAiGenerationActions
								onReplaceSelection={handleReplaceSelection}
								onInsertBelow={handleInsertBelow}
								onDiscard={handleDiscard}
								disabled={isLoading}
							/>
						) : (
							<PageEditorRichTextToolsInlineAiOptionList filter={inputValue} onSelect={handleOptionSelect} />
						)}
					</div>
				</form>
			)}
		</MyCombobox>
	);
}
// #endregion PageEditorRichTextToolsInlineAi
