import "./ai-selector.css";
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
import { useEditor, addAIHighlight, getPrevText } from "novel";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
export type AiSelectorCompletionPreview_ClassNames =
	| "AiSelectorCompletionPreview"
	| "AiSelectorCompletionPreview-wrapper"
	| "AiSelectorCompletionPreview-content"
	| "AiSelectorCompletionPreview-loader";

export type AiSelectorCompletionPreview_Props = {
	completion: string;
	isLoading: boolean;
};

function AiSelectorCompletionPreview(props: AiSelectorCompletionPreview_Props) {
	const { completion, isLoading } = props;

	return (
		<div className={cn("AiSelectorCompletionPreview-wrapper" satisfies AiSelectorCompletionPreview_ClassNames)}>
			<div className={cn("AiSelectorCompletionPreview-content" satisfies AiSelectorCompletionPreview_ClassNames)}>
				{isLoading ? (
					<div className={cn("AiSelectorCompletionPreview-loader" satisfies AiSelectorCompletionPreview_ClassNames)}>
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
export type AiSelectorInputArea_ClassNames =
	| "AiSelectorInputArea"
	| "AiSelectorInputArea-input"
	| "AiSelectorInputArea-control";

export type AiSelectorInputArea_Props = {
	placeholder: string;
	disabled: boolean;
};

function AiSelectorInputArea(props: AiSelectorInputArea_Props) {
	const { placeholder, disabled } = props;

	return (
		<div className={cn("AiSelectorInputArea" satisfies AiSelectorInputArea_ClassNames)}>
			<MyComboboxInput className={cn("AiSelectorInputArea-input" satisfies AiSelectorInputArea_ClassNames)}>
				<MyComboboxInputBox />
				<MyComboboxInputArea>
					<MyComboboxInputControl
						className={cn("AiSelectorInputArea-control" satisfies AiSelectorInputArea_ClassNames)}
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
export type AiSelectorGenerationActions_ClassNames = "AiSelectorGenerationActions" | "AiSelectorGenerationActions-icon";

export type AiSelectorGenerationActions_Props = {
	onReplaceSelection: () => void;
	onInsertBelow: () => void;
	onDiscard: () => void;
	disabled: boolean;
};

function AiSelectorGenerationActions(props: AiSelectorGenerationActions_Props) {
	const { onReplaceSelection, onInsertBelow, onDiscard, disabled } = props;

	return (
		<div className={cn("AiSelectorGenerationActions" satisfies AiSelectorGenerationActions_ClassNames)}>
			<MyButton onClick={onReplaceSelection} variant="outline" disabled={disabled}>
				<MyButtonIcon>
					<Check className={cn("AiSelectorGenerationActions-icon" satisfies AiSelectorGenerationActions_ClassNames)} />
				</MyButtonIcon>
				Replace selection
			</MyButton>
			<MyButton onClick={onInsertBelow} variant="outline" disabled={disabled}>
				<MyButtonIcon>
					<TextQuote
						className={cn("AiSelectorGenerationActions-icon" satisfies AiSelectorGenerationActions_ClassNames)}
					/>
				</MyButtonIcon>
				Insert below
			</MyButton>
			<MyButton onClick={onDiscard} variant="ghost" disabled={disabled}>
				<MyButtonIcon>
					<TrashIcon
						className={cn("AiSelectorGenerationActions-icon" satisfies AiSelectorGenerationActions_ClassNames)}
					/>
				</MyButtonIcon>
				Discard
			</MyButton>
		</div>
	);
}
// #endregion GenerationActions

// #region OptionItem
export type AiSelectorOptionItem_ClassNames = "AiSelectorOptionItem" | "AiSelectorOptionItem-icon";

export type AiSelectorOptionItem_Props = {
	value: GenerationOptionSelectable;
	label: string;
	onClick: () => void;
	icon: ReactNode;
};

function AiSelectorOptionItem(props: AiSelectorOptionItem_Props) {
	const { value, label, onClick, icon } = props;

	return (
		<MyComboboxItem
			className={cn("AiSelectorOptionItem" satisfies AiSelectorOptionItem_ClassNames)}
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
export type AiSelectorOptionList_ClassNames = "AiSelectorOptionList";

export type AiSelectorOptionList_Props = {
	filter: string;
	onSelect: (option: GenerationOptionSelectable) => void;
};

function AiSelectorOptionList(props: AiSelectorOptionList_Props) {
	const { filter, onSelect } = props;

	const filteredOptions = {
		transform: OPTIONS.transform.filter((option) => option.label.toLowerCase().includes(filter.toLowerCase())),
		continue: OPTIONS.continue.filter((option) => option.label.toLowerCase().includes(filter.toLowerCase())),
	} as const;

	return (
		<MyComboboxList className={cn("AiSelectorOptionList" satisfies AiSelectorOptionList_ClassNames)}>
			<MyComboboxGroup heading="Edit or review selection">
				{filteredOptions.transform.map((option) => (
					<AiSelectorOptionItem
						key={option.value}
						value={option.value}
						label={option.label}
						icon={
							<MyIcon className={cn("AiSelectorOptionItem-icon" satisfies AiSelectorOptionItem_ClassNames)}>
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
							<AiSelectorOptionItem
								key={option.value}
								value={option.value}
								label={option.label}
								icon={
									<MyIcon className={cn("AiSelectorOptionItem-icon" satisfies AiSelectorOptionItem_ClassNames)}>
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

// #region AiSelector
export type AiSelector_ClassNames = "AiSelector" | "AiSelector-container";

export type AiSelector_Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

export function AiSelector(props: AiSelector_Props) {
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
				const text = getPrevText(editor, pos);
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

		editor.chain().unsetHighlight().focus().run();
		onOpenChange(false);
	};

	useEffect(() => {
		if (!editor) {
			return;
		}

		addAIHighlight(editor);
	}, [editor]);

	return (
		<MyCombobox value={inputValue} setValue={setInputValue} open={true}>
			{editor && (
				<form ref={formRef} onSubmit={handleSubmit}>
					<div className={cn("AiSelector-container" satisfies AiSelector_ClassNames)}>
						{(hasCompletion || isLoading) && (
							<AiSelectorCompletionPreview completion={completionInst.completion} isLoading={isLoading} />
						)}

						<AiSelectorInputArea
							placeholder={hasCompletion ? "Tell AI what to do next" : "Ask AI to edit or generate..."}
							disabled={isLoading}
						/>

						{hasCompletion || isLoading ? (
							<AiSelectorGenerationActions
								onReplaceSelection={handleReplaceSelection}
								onInsertBelow={handleInsertBelow}
								onDiscard={handleDiscard}
								disabled={isLoading}
							/>
						) : (
							<AiSelectorOptionList filter={inputValue} onSelect={handleOptionSelect} />
						)}
					</div>
				</form>
			)}
		</MyCombobox>
	);
}
// #endregion AiSelector
