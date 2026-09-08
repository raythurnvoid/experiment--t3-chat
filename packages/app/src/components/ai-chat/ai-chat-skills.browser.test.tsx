import "@/app.css";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode, type MouseEventHandler } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { AiChatComposer } from "./ai-chat-composer.tsx";

const mocks = vi.hoisted(() => ({
	enabled: true,
	onSubmit: vi.fn(),
	onOutside: vi.fn(),
	onClose: vi.fn(),
}));

vi.mock("convex/react", async (importOriginal) => ({
	...(await importOriginal<typeof import("convex/react")>()),
	useQuery: () => ({
		enabled: mocks.enabled,
		status: "complete",
		instructions: [{ nodeId: "instruction", path: "/AGENTS.md", status: "ready" }],
		skills: Array.from({ length: 10 }, (_, index) => ({
			skillId: `skill_${index}`,
			name: `skill-${index}`,
			description: `Description ${index}`,
			path: `/.agents/skills/skill-${index}/SKILL.md`,
			compatibility: "Requires JavaScript",
			status: index === 9 ? "invalid" : "available",
			scriptStatus: index === 2 ? "unsupported" : undefined,
			message: index === 9 ? "Repair the name in SKILL.md." : undefined,
		})),
	}),
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({ membershipId: "membership", organizationName: "personal", workspaceName: "home" }),
	},
}));

vi.mock("@tanstack/react-router", () => ({
	Link: (props: { children?: ReactNode; to: string; onClick?: MouseEventHandler<HTMLAnchorElement> }) => (
		<a href={props.to} onClick={(event) => { event.preventDefault(); props.onClick?.(event); }}>{props.children}</a>
	),
}));

function Composer(props: { initialSkillIds?: string[]; attachment?: boolean }) {
	const [skillIds, setSkillIds] = useState<readonly string[]>(props.initialSkillIds ?? []);
	return (
		<div style={{ width: 360, "--app-scrollbar-w": "8px" } as React.CSSProperties}>
			<button type="button">Outside</button>
			<AiChatComposer
				canCancel={false}
				canQueue
				canSend
				isQueueing={false}
				isQueueEditing
				isRunning={false}
				initialValue="Queued draft"
				initialSkillIds={skillIds}
				onSkillIdsChange={setSkillIds}
				initialAttachments={
					props.attachment
						? [
								{
									type: "file",
									mediaType: "image/png",
									filename: "image.png",
									url: "data:image/png;base64,iVBORw0KGgo=",
								},
							]
						: []
				}
				selectedModelId="gpt-5.4-nano"
				selectedModeId="agent"
				onSelectedModelIdChange={vi.fn()}
				onSelectedModeIdChange={vi.fn()}
				onSubmit={mocks.onSubmit}
				onInteractedOutside={mocks.onOutside}
				onClose={mocks.onClose}
			/>
		</div>
	);
}

async function tabTo(target: HTMLElement) {
	for (let index = 0; document.activeElement !== target && index < 35; index++) {
		await userEvent.tab();
	}
	expect(document.activeElement).toBe(target);
}

describe("Instructions and skills keyboard interaction", () => {
	beforeEach(() => {
		mocks.enabled = true;
		mocks.onSubmit.mockReset();
		mocks.onOutside.mockReset();
		mocks.onClose.mockReset();
	});

	afterEach(() => cleanup());

	test("keeps focus in the dialog, returns it on Escape, and removes chips with the keyboard", async () => {
		render(<Composer />);
		await userEvent.click(screen.getByRole("button", { name: "Outside" }));
		expect(mocks.onOutside).toHaveBeenCalled();
		mocks.onOutside.mockClear();
		const trigger = screen.getByRole("button", { name: "Instructions and skills" });
		await tabTo(trigger);
		await userEvent.keyboard("{Enter}");
		const dialog = await screen.findByRole("dialog", { name: "Instructions and skills" });
		expect(dialog.textContent).toContain("Save changes before the next message. Accept and save agent proposals.");
		expect(dialog.textContent).toContain("Compatibility: Requires JavaScript");
		expect(screen.getByRole<HTMLButtonElement>("button", { name: "Select skill skill-9" }).disabled).toBe(true);
		await tabTo(screen.getByRole("button", { name: "Select skill skill-0" }));
		await userEvent.keyboard("{Enter}");
		await tabTo(screen.getByRole("button", { name: "Select skill skill-1" }));
		await userEvent.keyboard(" ");
		for (let index = 0; index < 28; index++) {
			await userEvent.tab();
			await waitFor(() =>
				expect(dialog.contains(document.activeElement), document.activeElement?.outerHTML).toBe(true),
			);
		}
		await userEvent.tab({ shift: true });
		await waitFor(() => expect(dialog.contains(document.activeElement), document.activeElement?.outerHTML).toBe(true));
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(document.activeElement).toBe(trigger));
		expect(screen.queryByRole("dialog", { name: "Instructions and skills" })).toBeNull();
		expect(mocks.onOutside).not.toHaveBeenCalled();
		expect(mocks.onClose).not.toHaveBeenCalled();
		await tabTo(screen.getByRole("button", { name: "Remove skill skill-0" }));
		await userEvent.keyboard("{ArrowRight}{Delete}");
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove skill skill-0" }));
		await userEvent.keyboard("{Backspace}");
		expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Send a message..." }));
		await userEvent.keyboard("{Enter}");
		expect(mocks.onSubmit).toHaveBeenCalledWith("Queued draft", [], []);
	});

	test.each(["/AGENTS.md", "/.agents/skills/skill-0/SKILL.md"])("closes after opening source %s with the keyboard", async (path) => {
		render(<Composer />);
		const trigger = screen.getByRole("button", { name: "Instructions and skills" });
		await tabTo(trigger);
		// Reaching the trigger may first focus the outside setup button.
		mocks.onOutside.mockClear();
		await userEvent.keyboard("{Enter}");
		await tabTo(screen.getByRole("link", { name: path }));
		await userEvent.keyboard("{Enter}");
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Instructions and skills" })).toBeNull());
		expect(document.activeElement).toBe(trigger);
		expect(mocks.onOutside).not.toHaveBeenCalled();
	});

	test("caps selection at eight and keeps images, skills and text in separate rows", async () => {
		render(<Composer initialSkillIds={Array.from({ length: 8 }, (_, index) => `skill_${index}`)} attachment />);
		const imageRow = document.querySelector<HTMLElement>(".AiChatComposer-attachments")!;
		const skillsRow = document.querySelector<HTMLElement>(".AiChatComposer-skills")!;
		const textRow = document.querySelector<HTMLElement>(".AiChatComposer-editor-content-container")!;
		expect(imageRow.getBoundingClientRect().bottom).toBeLessThanOrEqual(skillsRow.getBoundingClientRect().top);
		expect(skillsRow.getBoundingClientRect().bottom).toBeLessThanOrEqual(textRow.getBoundingClientRect().top);
		await tabTo(screen.getByRole("button", { name: "Instructions and skills" }));
		await userEvent.keyboard("{Enter}");
		expect(screen.getByRole<HTMLButtonElement>("button", { name: "Select skill skill-8" }).disabled).toBe(true);
		await tabTo(screen.getByRole("button", { name: "Deselect skill skill-0" }));
		await userEvent.keyboard("{Enter}");
		expect(screen.getByRole<HTMLButtonElement>("button", { name: "Select skill skill-8" }).disabled).toBe(false);
	});

	test("hides the control when the feature is off", () => {
		mocks.enabled = false;
		render(<Composer />);
		expect(screen.queryByRole("button", { name: "Instructions and skills" })).toBeNull();
	});

	test("keeps skill instructions selectable when their script runtime is unsupported", async () => {
		render(<Composer />);
		await tabTo(screen.getByRole("button", { name: "Instructions and skills" }));
		await userEvent.keyboard("{Enter}");
		const select = screen.getByRole<HTMLButtonElement>("button", { name: "Select skill skill-2" });
		expect(select.disabled).toBe(false);
		expect(select.closest("li")?.textContent).toContain("Instructions available. Scripts use an unsupported runtime.");
		expect(select.closest("li")?.textContent).not.toContain("bonobo-script-runtime");
		expect(screen.getAllByText("Instructions available. Scripts use an unsupported runtime.")).toHaveLength(1);
		await tabTo(select);
		await userEvent.keyboard("{Enter}");
		expect(screen.getByRole("button", { name: "Deselect skill skill-2" }).getAttribute("aria-pressed")).toBe("true");
		await userEvent.keyboard("{Escape}");
		expect(screen.getByRole("button", { name: "Remove skill skill-2" })).not.toBeNull();
	});
});
