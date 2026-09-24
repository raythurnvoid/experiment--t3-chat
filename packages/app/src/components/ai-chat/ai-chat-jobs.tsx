import "./ai-chat-jobs.css";

import { memo, useState } from "react";
import { History } from "lucide-react";

import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MyPopover, MyPopoverContent, MyPopoverTrigger } from "@/components/my-popover.tsx";
import type { AiChatThreadRuntime } from "@/hooks/ai-chat-controller.tsx";

type AiChatJobs_ClassNames =
	| "AiChatJobs-trigger"
	| "AiChatJobs-badge"
	| "AiChatJobs-popover"
	| "AiChatJobs-title"
	| "AiChatJobs-list"
	| "AiChatJobs-empty"
	| "AiChatJobs-row"
	| "AiChatJobs-row-head"
	| "AiChatJobs-row-command"
	| "AiChatJobs-row-meta";

function ai_chat_jobs_elapsed_text(startedAt: number | undefined, now: number) {
	if (startedAt === undefined) {
		return "queued";
	}

	const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}

	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ${seconds % 60}s`;
	}

	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

type AiChatJobs_Props = {
	liveJobs: AiChatThreadRuntime["liveJobs"];
};

const AiChatJobs = memo(function AiChatJobs(props: AiChatJobs_Props) {
	const { liveJobs } = props;
	const [open, setOpen] = useState(false);
	// Elapsed times freeze at mount. The popover unmounts on hide, so each open reads fresh.
	const [mountedAt] = useState(() => Date.now());
	const hasLiveJobs = liveJobs.length > 0;

	// Stay mounted while open so the popover can show its empty state instead of
	// vanishing under the keyboard.
	if (!hasLiveJobs && !open) {
		return null;
	}

	const label = hasLiveJobs ? `Background jobs, ${liveJobs.length} running` : "Background jobs";

	return (
		<MyPopover open={open} setOpen={setOpen}>
			<MyPopoverTrigger>
				<MyIconButton
					type="button"
					variant="ghost-highlightable"
					tooltip={label}
					className={"AiChatJobs-trigger" satisfies AiChatJobs_ClassNames}
				>
					<MyIconButtonIcon>
						<History />
					</MyIconButtonIcon>
					{hasLiveJobs ? (
						<span className={"AiChatJobs-badge" satisfies AiChatJobs_ClassNames}>{liveJobs.length}</span>
					) : null}
				</MyIconButton>
			</MyPopoverTrigger>
			<MyPopoverContent
				unmountOnHide
				className={"AiChatJobs-popover" satisfies AiChatJobs_ClassNames}
				aria-label="Background jobs"
			>
				<h2 className={"AiChatJobs-title" satisfies AiChatJobs_ClassNames}>Background jobs</h2>
				{hasLiveJobs ? (
					<ul className={"AiChatJobs-list" satisfies AiChatJobs_ClassNames}>
						{liveJobs.map((job) => (
							<li key={job.jobNumber} className={"AiChatJobs-row" satisfies AiChatJobs_ClassNames}>
								<span className={"AiChatJobs-row-head" satisfies AiChatJobs_ClassNames}>
									#{job.jobNumber} · {job.shellName}
								</span>
								<span className={"AiChatJobs-row-command" satisfies AiChatJobs_ClassNames}>{job.scriptPreview}</span>
								<span className={"AiChatJobs-row-meta" satisfies AiChatJobs_ClassNames}>
									{ai_chat_jobs_elapsed_text(job.startedAt, mountedAt)}
								</span>
							</li>
						))}
					</ul>
				) : (
					<p className={"AiChatJobs-empty" satisfies AiChatJobs_ClassNames}>No running jobs.</p>
				)}
			</MyPopoverContent>
		</MyPopover>
	);
});

export { AiChatJobs };
