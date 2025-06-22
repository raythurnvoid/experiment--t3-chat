import {
	ActionBarPrimitive,
	BranchPickerPrimitive,
	ComposerPrimitive,
	MessagePrimitive,
	ThreadPrimitive,
} from "@assistant-ui/react";
import { memo, type FC } from "react";
import {
	ArrowDownIcon,
	CheckIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	CopyIcon,
	PencilIcon,
	RefreshCwIcon,
	SendHorizontalIcon,
} from "lucide-react";
import { cn } from "../../lib/utils";

import { Button } from "../ui/button";
import { TooltipIconButton } from "./tooltip-icon-button";
import { MarkdownText } from "./markdown-text.tsx";

export const Thread: FC = memo(() => {
	return (
		<ThreadPrimitive.Root
			className={cn(
				"Thread",
				"flex flex-1 flex-col bg-white dark:bg-black text-black dark:text-white"
			)}
		>
			<ThreadPrimitive.Viewport
				autoScroll
				className={cn(
					"Thread-viewport",
					"flex flex-1 flex-col items-center px-4 pt-8 min-h-0 max-h-full overflow-y-auto"
				)}
			>
				<ThreadWelcome />

				<ThreadPrimitive.Messages
					components={{
						UserMessage: UserMessage,
						EditComposer: EditComposer,
						AssistantMessage: AssistantMessage,
					}}
				/>

				<ThreadPrimitive.If empty={false}>
					<div className={cn("Thread-spacer", "min-h-8 flex-grow")} />
				</ThreadPrimitive.If>

				<div
					className={cn(
						"Thread-composer-container",
						"sticky bottom-0 mt-3 flex w-full max-w-[var(--thread-max-width)] flex-col items-center justify-end rounded-t-lg bg-white dark:bg-black pb-4"
					)}
				>
					<ThreadScrollToBottom />
					<Composer />
				</div>
			</ThreadPrimitive.Viewport>
		</ThreadPrimitive.Root>
	);
});

const ThreadScrollToBottom: FC = memo(() => {
	return (
		<ThreadPrimitive.ScrollToBottom asChild>
			<TooltipIconButton
				tooltip="Scroll to bottom"
				variant="outline"
				className={cn(
					"ThreadScrollToBottom",
					"absolute -top-8 rounded-full disabled:invisible"
				)}
			>
				<ArrowDownIcon />
			</TooltipIconButton>
		</ThreadPrimitive.ScrollToBottom>
	);
});

const ThreadWelcome: FC = memo(() => {
	return (
		<ThreadPrimitive.Empty>
			<div
				className={cn(
					"ThreadWelcome",
					"flex w-full max-w-[var(--thread-max-width)] flex-grow flex-col"
				)}
			>
				<div
					className={cn(
						"ThreadWelcome-content",
						"flex w-full flex-grow flex-col items-center justify-center"
					)}
				>
					<p className={cn("ThreadWelcome-title", "mt-4 font-medium")}>
						How can I help you today?
					</p>
				</div>
				<ThreadWelcomeSuggestions />
			</div>
		</ThreadPrimitive.Empty>
	);
});

const ThreadWelcomeSuggestions: FC = memo(() => {
	return (
		<div
			className={cn(
				"ThreadWelcomeSuggestions",
				"mt-3 flex w-full items-stretch justify-center gap-4"
			)}
		>
			<ThreadPrimitive.Suggestion
				className={cn(
					"ThreadWelcomeSuggestions-item",
					"hover:bg-muted/80 flex max-w-sm grow basis-0 flex-col items-center justify-center rounded-lg border p-3 transition-colors ease-in"
				)}
				prompt="What is the weather in Tokyo?"
				method="replace"
				autoSend
			>
				<span
					className={cn(
						"ThreadWelcomeSuggestions-text",
						"line-clamp-2 text-ellipsis text-sm font-semibold"
					)}
				>
					What is the weather in Tokyo?
				</span>
			</ThreadPrimitive.Suggestion>
			<ThreadPrimitive.Suggestion
				className={cn(
					"ThreadWelcomeSuggestions-item",
					"hover:bg-muted/80 flex max-w-sm grow basis-0 flex-col items-center justify-center rounded-lg border p-3 transition-colors ease-in"
				)}
				prompt="Explain quantum computing in simple terms"
				method="replace"
				autoSend
			>
				<span
					className={cn(
						"ThreadWelcomeSuggestions-text",
						"line-clamp-2 text-ellipsis text-sm font-semibold"
					)}
				>
					Explain quantum computing in simple terms
				</span>
			</ThreadPrimitive.Suggestion>
		</div>
	);
});

const Composer: FC = memo(() => {
	return (
		<ComposerPrimitive.Root
			className={cn(
				"Composer",
				"focus-within:border-ring/20 flex w-full flex-wrap items-end rounded-lg border bg-inherit px-2.5 shadow-sm transition-colors ease-in"
			)}
		>
			<ComposerPrimitive.Input
				rows={1}
				autoFocus
				autoComplete={`off-${Date.now()}`}
				placeholder="Write a message..."
				className={cn(
					"Composer-input",
					"placeholder:text-muted-foreground max-h-40 flex-grow resize-none border-none bg-transparent px-2 py-4 text-sm outline-none focus:ring-0 disabled:cursor-not-allowed"
				)}
			/>
			<ComposerAction />
		</ComposerPrimitive.Root>
	);
});

const ComposerAction: FC = memo(() => {
	return (
		<>
			<ThreadPrimitive.If running={false}>
				<ComposerPrimitive.Send asChild>
					<TooltipIconButton
						tooltip="Send"
						variant="default"
						className={cn(
							"ComposerAction-send-button",
							"my-2.5 size-8 p-2 transition-opacity ease-in"
						)}
					>
						<SendHorizontalIcon />
					</TooltipIconButton>
				</ComposerPrimitive.Send>
			</ThreadPrimitive.If>
			<ThreadPrimitive.If running>
				<ComposerPrimitive.Cancel asChild>
					<TooltipIconButton
						tooltip="Cancel"
						variant="default"
						className={cn(
							"ComposerAction-cancel-button",
							"my-2.5 size-8 p-2 transition-opacity ease-in"
						)}
					>
						<CircleStopIcon />
					</TooltipIconButton>
				</ComposerPrimitive.Cancel>
			</ThreadPrimitive.If>
		</>
	);
});

const UserMessage: FC = memo(() => {
	return (
		<MessagePrimitive.Root
			className={cn(
				"UserMessage",
				"grid w-full max-w-[var(--thread-max-width)] auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] gap-y-2 py-4 [&:where(>*)]:col-start-2"
			)}
		>
			<UserActionBar />

			<div
				className={cn(
					"UserMessage-content",
					"bg-muted text-foreground col-start-2 row-start-2 max-w-[calc(var(--thread-max-width)*0.8)] break-words rounded-3xl px-5 py-2.5"
				)}
			>
				<MessagePrimitive.Content />
			</div>

			<BranchPicker
				className={cn(
					"UserMessage-branch-picker",
					"col-span-full col-start-1 row-start-3 -mr-1 justify-end"
				)}
			/>
		</MessagePrimitive.Root>
	);
});

const UserActionBar: FC = memo(() => {
	return (
		<ActionBarPrimitive.Root
			hideWhenRunning
			autohide="not-last"
			className={cn(
				"UserActionBar",
				"col-start-1 row-start-2 mr-3 mt-2.5 flex flex-col items-end"
			)}
		>
			<ActionBarPrimitive.Edit asChild>
				<TooltipIconButton tooltip="Edit" className="UserActionBar-edit-button">
					<PencilIcon />
				</TooltipIconButton>
			</ActionBarPrimitive.Edit>
		</ActionBarPrimitive.Root>
	);
});

const EditComposer: FC = memo(() => {
	return (
		<ComposerPrimitive.Root
			className={cn(
				"EditComposer",
				"bg-muted my-4 flex w-full max-w-[var(--thread-max-width)] flex-col gap-2 rounded-xl"
			)}
		>
			<ComposerPrimitive.Input
				autoComplete={`off-${Date.now()}`}
				className={cn(
					"EditComposer-input",
					"text-foreground flex h-8 w-full resize-none bg-transparent p-4 pb-0 outline-none"
				)}
			/>

			<div
				className={cn(
					"EditComposer-actions",
					"mx-3 mb-3 flex items-center justify-center gap-2 self-end"
				)}
			>
				<ComposerPrimitive.Cancel asChild>
					<Button variant="ghost" className="EditComposer-cancel-button">
						Cancel
					</Button>
				</ComposerPrimitive.Cancel>
				<ComposerPrimitive.Send asChild>
					<Button className="EditComposer-send-button">Send</Button>
				</ComposerPrimitive.Send>
			</div>
		</ComposerPrimitive.Root>
	);
});

const AssistantMessage: FC = memo(() => {
	return (
		<MessagePrimitive.Root
			className={cn(
				"AssistantMessage",
				"relative grid w-full max-w-[var(--thread-max-width)] grid-cols-[auto_auto_1fr] grid-rows-[auto_1fr] py-4"
			)}
		>
			<div
				className={cn(
					"AssistantMessage-content",
					"text-foreground col-span-2 col-start-2 row-start-1 my-1.5 max-w-[calc(var(--thread-max-width)*0.8)] break-words leading-7"
				)}
			>
				<MessagePrimitive.Content components={{ Text: MarkdownText }} />
			</div>

			<AssistantActionBar />

			<BranchPicker
				className={cn(
					"AssistantMessage-branch-picker",
					"col-start-2 row-start-2 -ml-2 mr-2"
				)}
			/>
		</MessagePrimitive.Root>
	);
});

const AssistantActionBar: FC = memo(() => {
	return (
		<ActionBarPrimitive.Root
			hideWhenRunning
			autohide="not-last"
			autohideFloat="single-branch"
			className={cn(
				"AssistantActionBar",
				"text-muted-foreground data-[floating]:bg-background col-start-3 row-start-2 -ml-1 flex gap-1 data-[floating]:absolute data-[floating]:rounded-md data-[floating]:border data-[floating]:p-1 data-[floating]:shadow-sm"
			)}
		>
			<ActionBarPrimitive.Copy asChild>
				<TooltipIconButton
					tooltip="Copy"
					className="AssistantActionBar-copy-button"
				>
					<MessagePrimitive.If copied>
						<CheckIcon />
					</MessagePrimitive.If>
					<MessagePrimitive.If copied={false}>
						<CopyIcon />
					</MessagePrimitive.If>
				</TooltipIconButton>
			</ActionBarPrimitive.Copy>
			<ActionBarPrimitive.Reload asChild>
				<TooltipIconButton
					tooltip="Refresh"
					className="AssistantActionBar-reload-button"
				>
					<RefreshCwIcon />
				</TooltipIconButton>
			</ActionBarPrimitive.Reload>
		</ActionBarPrimitive.Root>
	);
});

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = memo(
	({ className, ...rest }) => {
		return (
			<BranchPickerPrimitive.Root
				hideWhenSingleBranch
				className={cn(
					"BranchPicker",
					"text-muted-foreground inline-flex items-center text-xs",
					className
				)}
				{...rest}
			>
				<BranchPickerPrimitive.Previous asChild>
					<TooltipIconButton
						tooltip="Previous"
						className="BranchPicker-previous-button"
					>
						<ChevronLeftIcon />
					</TooltipIconButton>
				</BranchPickerPrimitive.Previous>
				<span className={cn("BranchPicker-counter", "font-medium")}>
					<BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
				</span>
				<BranchPickerPrimitive.Next asChild>
					<TooltipIconButton
						tooltip="Next"
						className="BranchPicker-next-button"
					>
						<ChevronRightIcon />
					</TooltipIconButton>
				</BranchPickerPrimitive.Next>
			</BranchPickerPrimitive.Root>
		);
	}
);

const CircleStopIcon = memo(() => {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 16 16"
			fill="currentColor"
			width="16"
			height="16"
		>
			<rect width="10" height="10" x="3" y="3" rx="2" />
		</svg>
	);
});
