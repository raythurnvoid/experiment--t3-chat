// Original file at: 263f9e51

import { ThreadListItemPrimitive, ThreadListPrimitive } from "@assistant-ui/react";
import { cn } from "@/lib/utils.ts";
import { ArchiveIcon, PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button.tsx";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button.tsx";

export function ThreadList() {
	return (
		<ThreadListPrimitive.Root className={cn("ThreadList", "flex w-[250px] flex-col items-stretch gap-1.5")}>
			<ThreadListNew />
			<ThreadListItems />
		</ThreadListPrimitive.Root>
	);
}

function ThreadListNew() {
	return (
		<ThreadListPrimitive.New asChild>
			<Button
				className="flex items-center justify-start gap-1 rounded-lg px-2.5 py-2 text-start hover:bg-muted data-[active]:bg-muted"
				variant="ghost"
			>
				<PlusIcon />
				New Thread
			</Button>
		</ThreadListPrimitive.New>
	);
}

function ThreadListItems() {
	return <ThreadListPrimitive.Items components={{ ThreadListItem }} />;
}

function ThreadListItem() {
	return (
		<ThreadListItemPrimitive.Root
			className={cn(
				"ThreadList-item",
				"flex items-center gap-2 rounded-lg transition-all hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[active]:bg-muted",
			)}
		>
			<ThreadListItemPrimitive.Trigger
				className={cn(
					"ThreadList-item-trigger",
					"min-w-0 flex-grow overflow-hidden px-3 py-2 text-start text-ellipsis whitespace-nowrap",
				)}
			>
				<ThreadListItemTitle />
			</ThreadListItemPrimitive.Trigger>
			<ThreadListItemArchive />
		</ThreadListItemPrimitive.Root>
	);
}

function ThreadListItemTitle() {
	return <ThreadListItemPrimitive.Title fallback="New Chat" />;
}

function ThreadListItemArchive() {
	return (
		<ThreadListItemPrimitive.Archive asChild>
			<TooltipIconButton
				className={cn("ThreadList-item-archive-button", "mr-3 ml-auto size-4 p-0 text-foreground hover:text-primary")}
				variant="ghost"
				tooltip="Archive thread"
			>
				<ArchiveIcon />
			</TooltipIconButton>
		</ThreadListItemPrimitive.Archive>
	);
}
