import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { AiChatComposer } from "./ai-chat-composer.tsx";

describe("AiChatComposer", () => {
	afterEach(() => {
		cleanup();
	});

	test("names the composer textbox and configuration comboboxes", () => {
		render(
			<AiChatComposer
				canCancel={false}
				canSend={true}
				isRunning={false}
				initialValue=""
				selectedModelId="gpt-5.4-nano"
				selectedModeId="agent"
				onSelectedModelIdChange={vi.fn()}
				onSelectedModeIdChange={vi.fn()}
				onSubmit={vi.fn()}
			/>,
		);

		expect(screen.getByRole("textbox", { name: "Send a message..." })).not.toBeNull();
		expect(screen.getByRole("combobox", { name: "Chat mode: Agent" })).not.toBeNull();
		expect(screen.getByRole("combobox", { name: "Chat model: GPT-5.4 Nano" })).not.toBeNull();
	});

	test("disables send when the parent controller says sending is unsafe", () => {
		render(
			<AiChatComposer
				canCancel={false}
				canSend={false}
				isRunning={false}
				initialValue="next message"
				selectedModelId="gpt-5.4-nano"
				selectedModeId="agent"
				onSelectedModelIdChange={vi.fn()}
				onSelectedModeIdChange={vi.fn()}
				onSubmit={vi.fn()}
			/>,
		);

		expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send message" }).disabled).toBe(true);
	});
});
