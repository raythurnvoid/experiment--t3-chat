import "./file-editor-rich-text-tools-inline-ai.css";
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
import { useRef, useState, type ReactNode } from "react";
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
import { MySpinner } from "@/components/my-spinner.tsx";
import { cn } from "@/lib/utils.ts";
import type { Editor } from "@tiptap/core";
import { AppAuthProvider } from "@/components/app-auth.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";

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
export type FileEditorRichTextToolsInlineAiCompletionPreview_ClassNames =
	| "FileEditorRichTextToolsInlineAiCompletionPreview"
	| "FileEditorRichTextToolsInlineAiCompletionPreview-wrapper"
	| "FileEditorRichTextToolsInlineAiCompletionPreview-content"
	| "FileEditorRichTextToolsInlineAiCompletionPreview-loader";

export type FileEditorRichTextToolsInlineAiCompletionPreview_Props = {
	completion: string;
	isLoading: boolean;
};

function FileEditorRichTextToolsInlineAiCompletionPreview(
	props: FileEditorRichTextToolsInlineAiCompletionPreview_Props,
) {
	const { completion, isLoading } = props;

	return (
		<div
			className={cn(
				"FileEditorRichTextToolsInlineAiCompletionPreview-wrapper" satisfies FileEditorRichTextToolsInlineAiCompletionPreview_ClassNames,
			)}
		>
			<div
				className={cn(
					"FileEditorRichTextToolsInlineAiCompletionPreview-content" satisfies FileEditorRichTextToolsInlineAiCompletionPreview_ClassNames,
				)}
			>
				{isLoading ? (
					<div
						className={cn(
							"FileEditorRichTextToolsInlineAiCompletionPreview-loader" satisfies FileEditorRichTextToolsInlineAiCompletionPreview_ClassNames,
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
export type FileEditorRichTextToolsInlineAiInputArea_ClassNames =
	| "FileEditorRichTextToolsInlineAiInputArea"
	| "FileEditorRichTextToolsInlineAiInputArea-input"
	| "FileEditorRichTextToolsInlineAiInputArea-control";

export type FileEditorRichTextToolsInlineAiInputArea_Props = {
	placeholder: string;
	disabled: boolean;
};

function FileEditorRichTextToolsInlineAiInputArea(props: FileEditorRichTextToolsInlineAiInputArea_Props) {
	const { placeholder, disabled } = props;

	return (
		<div
			className={cn(
				"FileEditorRichTextToolsInlineAiInputArea" satisfies FileEditorRichTextToolsInlineAiInputArea_ClassNames,
			)}
		>
			<MyComboboxInput
				className={cn(
					"FileEditorRichTextToolsInlineAiInputArea-input" satisfies FileEditorRichTextToolsInlineAiInputArea_ClassNames,
				)}
			>
				<MyComboboxInputBox />
				<MyComboboxInputArea>
					<MyComboboxInputControl
						className={cn(
							"FileEditorRichTextToolsInlineAiInputArea-control" satisfies FileEditorRichTextToolsInlineAiInputArea_ClassNames,
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
export type FileEditorRichTextToolsInlineAiGenerationActions_ClassNames =
	| "FileEditorRichTextToolsInlineAiGenerationActions"
	| "FileEditorRichTextToolsInlineAiGenerationActions-icon";

export type FileEditorRichTextToolsInlineAiGenerationActions_Props = {
	onReplaceSelection: () => void;
	onInsertBelow: () => void;
	onDiscard: () => void;
	disabled: boolean;
};

function FileEditorRichTextToolsInlineAiGenerationActions(
	props: FileEditorRichTextToolsInlineAiGenerationActions_Props,
) {
	const { onReplaceSelection, onInsertBelow, onDiscard, disabled } = props;

	return (
		<div
			className={cn(
				"FileEditorRichTextToolsInlineAiGenerationActions" satisfies FileEditorRichTextToolsInlineAiGenerationActions_ClassNames,
			)}
		>
			<MyButton onClick={onReplaceSelection} variant="outline" disabled={disabled}>
				<MyButtonIcon>
					<Check
						className={cn(
							"FileEditorRichTextToolsInlineAiGenerationActions-icon" satisfies FileEditorRichTextToolsInlineAiGenerationActions_ClassNames,
						)}
					/>
				</MyButtonIcon>
				Replace selection
			</MyButton>
			<MyButton onClick={onInsertBelow} variant="outline" disabled={disabled}>
				<MyButtonIcon>
					<TextQuote
						className={cn(
							"FileEditorRichTextToolsInlineAiGenerationActions-icon" satisfies FileEditorRichTextToolsInlineAiGenerationActions_ClassNames,
						)}
					/>
				</MyButtonIcon>
				Insert below
			</MyButton>
			<MyButton onClick={onDiscard} variant="ghost" disabled={disabled}>
				<MyButtonIcon>
					<TrashIcon
						className={cn(
							"FileEditorRichTextToolsInlineAiGenerationActions-icon" satisfies FileEditorRichTextToolsInlineAiGenerationActions_ClassNames,
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
export type FileEditorRichTextToolsInlineAiOptionItem_ClassNames =
	| "FileEditorRichTextToolsInlineAiOptionItem"
	| "FileEditorRichTextToolsInlineAiOptionItem-icon";

export type FileEditorRichTextToolsInlineAiOptionItem_Props = {
	value: GenerationOptionSelectable;
	label: string;
	onClick: () => void;
	icon: ReactNode;
};

function FileEditorRichTextToolsInlineAiOptionItem(props: FileEditorRichTextToolsInlineAiOptionItem_Props) {
	const { value, label, onClick, icon } = props;

	return (
		<MyComboboxItem
			className={cn(
				"FileEditorRichTextToolsInlineAiOptionItem" satisfies FileEditorRichTextToolsInlineAiOptionItem_ClassNames,
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
export type FileEditorRichTextToolsInlineAiOptionList_ClassNames = "FileEditorRichTextToolsInlineAiOptionList";

export type FileEditorRichTextToolsInlineAiOptionList_Props = {
	filter: string;
	onSelect: (option: GenerationOptionSelectable) => void;
};

function FileEditorRichTextToolsInlineAiOptionList(props: FileEditorRichTextToolsInlineAiOptionList_Props) {
	const { filter, onSelect } = props;

	const filteredOptions = {
		transform: OPTIONS.transform.filter((option) => option.label.toLowerCase().includes(filter.toLowerCase())),
		continue: OPTIONS.continue.filter((option) => option.label.toLowerCase().includes(filter.toLowerCase())),
	} as const;

	return (
		<MyComboboxList
			className={cn(
				"FileEditorRichTextToolsInlineAiOptionList" satisfies FileEditorRichTextToolsInlineAiOptionList_ClassNames,
			)}
		>
			<MyComboboxGroup heading="Edit or review selection">
				{filteredOptions.transform.map((option) => (
					<FileEditorRichTextToolsInlineAiOptionItem
						key={option.value}
						value={option.value}
						label={option.label}
						icon={
							<MyIcon
								className={cn(
									"FileEditorRichTextToolsInlineAiOptionItem-icon" satisfies FileEditorRichTextToolsInlineAiOptionItem_ClassNames,
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
							<FileEditorRichTextToolsInlineAiOptionItem
								key={option.value}
								value={option.value}
								label={option.label}
								icon={
									<MyIcon
										className={cn(
											"FileEditorRichTextToolsInlineAiOptionItem-icon" satisfies FileEditorRichTextToolsInlineAiOptionItem_ClassNames,
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

// #region FileEditorRichTextToolsInlineAi
export type FileEditorRichTextToolsInlineAi_ClassNames =
	| "FileEditorRichTextToolsInlineAi"
	| "FileEditorRichTextToolsInlineAi-container";

export type FileEditorRichTextToolsInlineAi_Props = {
	editor: Editor;
	onDiscard: () => void;
};

export function FileEditorRichTextToolsInlineAi(props: FileEditorRichTextToolsInlineAi_Props) {
	const { editor, onDiscard } = props;

	const { membershipId } = AppTenantProvider.useContext();

	const [inputValue, setInputValue] = useState("");
	const formRef = useRef<HTMLFormElement>(null);

	const completionInst = useCompletion({
		api: app_fetch_main_api_url("/api/files/contextual-prompt"),
		fetch: async (input, requestInit) => {
			const headers = new Headers(requestInit?.headers);
			const token = await AppAuthProvider.getToken();
			if (token) {
				headers.set("Authorization", `Bearer ${token}`);
			}

			const response = await fetch(input, { ...requestInit, headers });

			if (response.status === 402 || response.status === 429) {
				const body = await response
					.clone()
					.json()
					.catch(() => null);

				if (response.status === 402) {
					throw new Error(body?.message ?? "Insufficient funds");
				}

				throw new Error(body?.message ?? "You have reached your request limit. Try again shortly.");
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
		if (!editor.markdown) {
			return;
		}

		completionInst
			.complete(args.text, {
				body: {
					option: args.option,
					command: args.command,
					membershipId,
					requestId: crypto.randomUUID(),
				},
			})
			.catch((e) => {
				console.error(e);
				toast.error(e.message);
			});
	}

	const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();

		if (!editor.markdown) {
			return;
		}

		if (completionInst.completion) {
			completionInst
				.complete(completionInst.completion, {
					body: {
						option: "zap",
						command: inputValue,
						membershipId,
						requestId: crypto.randomUUID(),
					},
				})
				.catch((error) => {
					console.error(error);
					toast.error(error.message);
				});
			return;
		}

		const slice = editor.state.selection.content();
		const text = editor.markdown.serialize(slice.content.toJSON());

		triggerGeneration({ text, option: "zap", command: inputValue });

		setInputValue("");
	};

	const handleOptionSelect = (option: GenerationOptionSelectable) => {
		if (!editor.markdown) {
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
		const selection = editor.view.state.selection;
		editor
			.chain()
			.focus()
			.insertContentAt(selection.to + 1, completionInst.completion)
			.run();
	};

	const handleDiscard = () => {
		editor.chain().clearDecorationHighlight().focus().run();
		onDiscard();
	};

	return (
		<MyCombobox value={inputValue} setValue={setInputValue} open={true}>
			<form ref={formRef} onSubmit={handleSubmit}>
				<div
					className={cn(
						"FileEditorRichTextToolsInlineAi-container" satisfies FileEditorRichTextToolsInlineAi_ClassNames,
					)}
				>
					{(hasCompletion || isLoading) && (
						<FileEditorRichTextToolsInlineAiCompletionPreview
							completion={completionInst.completion}
							isLoading={isLoading}
						/>
					)}

					<FileEditorRichTextToolsInlineAiInputArea
						placeholder={hasCompletion ? "Tell AI what to do next" : "Ask AI to edit or generate..."}
						disabled={isLoading}
					/>

					{hasCompletion || isLoading ? (
						<FileEditorRichTextToolsInlineAiGenerationActions
							onReplaceSelection={handleReplaceSelection}
							onInsertBelow={handleInsertBelow}
							onDiscard={handleDiscard}
							disabled={isLoading}
						/>
					) : (
						<FileEditorRichTextToolsInlineAiOptionList filter={inputValue} onSelect={handleOptionSelect} />
					)}
				</div>
			</form>
		</MyCombobox>
	);
}
// #endregion FileEditorRichTextToolsInlineAi
