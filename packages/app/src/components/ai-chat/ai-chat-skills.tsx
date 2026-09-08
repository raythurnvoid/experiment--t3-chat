import "./ai-chat-skills.css";
import { memo, useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { BookOpen, X } from "lucide-react";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { ai_chat_skills_LIMITS } from "../../../shared/ai-chat-skills.ts";
import { MyButton } from "@/components/my-button.tsx";
import { MyIconButton } from "@/components/my-icon-button.tsx";
import { MyChip, MyChipLabel, MyChipRemove, MyChipRow } from "@/components/my-chip.tsx";
import { MyLink } from "@/components/my-link.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalDescription,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
	MyModalScrollableArea,
	MyModalTrigger,
} from "@/components/my-modal.tsx";

type AiChatSkillsDialog_ClassNames = "AiChatSkillsControl" | "AiChatSkillsDialog" | "AiChatSkillsDialog-section";

export const AiChatSkillChips = memo(function AiChatSkillChips(props: {
	skillIds: readonly string[];
	onRemove: (skillId: string, focusEditor: boolean) => void;
	onFocusExit: () => void;
}) {
	const { skillIds, onRemove, onFocusExit } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const catalog = useQuery(app_convex_api.ai_chat_context.get_catalog, { membershipId });

	return (
		<MyChipRow aria-label="Selected skills" onFocusExit={onFocusExit}>
			{skillIds.map((skillId) => {
				const skill = catalog?.skills.find((skill) => skill.skillId === skillId);
				const name = skill?.name ?? "Source unavailable";
				return (
					<li key={skillId}>
						<MyChip>
							<MyChipLabel>{name}</MyChipLabel>
							<MyChipRemove tooltip={`Remove skill ${name}`} onClick={(event) => onRemove(skillId, event.detail > 0)}>
								<X />
							</MyChipRemove>
						</MyChip>
					</li>
				);
			})}
		</MyChipRow>
	);
});

export const AiChatSkillsControl = memo(function AiChatSkillsControl(props: {
	skillIds: readonly string[];
	onSkillIdsChange: (skillIds: readonly string[]) => void;
	onDialogElementChange: (element: HTMLElement | null) => void;
	onDialogOpenChange: (open: boolean) => void;
}) {
	const { skillIds, onSkillIdsChange, onDialogElementChange, onDialogOpenChange } = props;
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();
	const catalog = useQuery(app_convex_api.ai_chat_context.get_catalog, { membershipId });
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		if (!catalog?.enabled) {
			setOpen(false);
			onDialogOpenChange(false);
		}
	}, [catalog?.enabled, onDialogOpenChange]);

	const handleOpenChange = (nextOpen: boolean) => {
		setOpen(nextOpen);
		onDialogOpenChange(nextOpen);
		if (!nextOpen) {
			queueMicrotask(() => triggerRef.current?.focus());
		}
	};

	if (!catalog?.enabled) {
		return null;
	}

	return (
		<MyModal open={open} setOpen={handleOpenChange}>
			<MyModalTrigger>
				<MyIconButton
					ref={triggerRef}
					className={"AiChatSkillsControl" satisfies AiChatSkillsDialog_ClassNames}
					variant="ghost-highlightable"
					tooltip="Instructions and skills"
				>
					<BookOpen />
				</MyIconButton>
			</MyModalTrigger>
			<MyModalPopover
				ref={onDialogElementChange}
				className={"AiChatSkillsDialog" satisfies AiChatSkillsDialog_ClassNames}
				onKeyDown={(event) => {
					// MyModal makes the page inert; wrap Tab at this dialog's ends as well.
					if (event.key === "Tab") {
						const controls = event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]");
						const first = controls.item(0);
						const last = controls.item(controls.length - 1);
						if (event.shiftKey ? event.target === first : event.target === last) {
							event.preventDefault();
							(event.shiftKey ? last : first)?.focus();
						}
					}
					// Escape closes this dialog without cancelling the composer edit behind it.
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						handleOpenChange(false);
					}
				}}
			>
				<MyModalHeader>
					<MyModalHeading>Instructions and skills</MyModalHeading>
					<MyModalDescription>
						Save changes before the next message. Accept and save agent proposals.
					</MyModalDescription>
				</MyModalHeader>
				<MyModalScrollableArea>
					{catalog.status === "limit" && (
						<p role="alert">Sources exceed the count or size limit. Shorten or remove sources, or wait for saved content to finish updating.</p>
					)}
					<section
						aria-label="Workspace instructions"
						className={"AiChatSkillsDialog-section" satisfies AiChatSkillsDialog_ClassNames}
					>
						<h3>Workspace instructions</h3>
						{catalog.instructions.length === 0 && <p>No saved AGENTS.md files.</p>}
						<ul>
							{catalog.instructions.map((instruction) => (
								<li key={instruction.nodeId}>
									<MyLink
										to="/w/$organizationName/$workspaceName/files"
										params={{ organizationName, workspaceName }}
										search={{ nodeId: instruction.nodeId }}
										onClick={() => handleOpenChange(false)}
									>
										{instruction.path}
									</MyLink>
									<p>
										{instruction.status === "ready"
											? "Ready"
											: instruction.status === "updating"
												? "Updating saved content"
												: instruction.status === "too_large"
													? "Source exceeds the size limit"
													: "Source unavailable"}
									</p>
								</li>
							))}
						</ul>
					</section>
					<section aria-label="Skills" className={"AiChatSkillsDialog-section" satisfies AiChatSkillsDialog_ClassNames}>
						<h3>Skills</h3>
						<p>Select up to {ai_chat_skills_LIMITS.selected} skills for the next message.</p>
						{catalog.skills.length === 0 && <p>No saved skills in .agents/skills.</p>}
						<ul>
							{catalog.skills.map((skill) => {
								const selected = skillIds.includes(skill.skillId);
								return (
									<li key={skill.skillId}>
										<MyButton
											variant="outline"
											aria-label={`${selected ? "Deselect" : "Select"} skill ${skill.name}`}
											aria-pressed={selected}
											disabled={
												!selected &&
												(skill.status !== "available" ||
													catalog.status === "limit" ||
													skillIds.length >= ai_chat_skills_LIMITS.selected)
											}
											onClick={() =>
												onSkillIdsChange(
													selected ? skillIds.filter((id) => id !== skill.skillId) : [...skillIds, skill.skillId],
												)
											}
										>
											{skill.name}
										</MyButton>
										<p>{skill.description}</p>
										<p>{skill.status === "available" ? "Available" : (skill.message ?? "Source unavailable")}</p>
										{skill.scriptStatus === "unsupported" && (
											<p>Instructions available. Scripts use an unsupported runtime.</p>
										)}
										{skill.compatibility && <p>Compatibility: {skill.compatibility}</p>}
										<MyLink
											to="/w/$organizationName/$workspaceName/files"
											params={{ organizationName, workspaceName }}
											search={{ nodeId: skill.skillId }}
											onClick={() => handleOpenChange(false)}
										>
											{skill.path}
										</MyLink>
									</li>
								);
							})}
						</ul>
					</section>
				</MyModalScrollableArea>
				<MyModalCloseTrigger tooltip="Close instructions and skills" />
			</MyModalPopover>
		</MyModal>
	);
});
