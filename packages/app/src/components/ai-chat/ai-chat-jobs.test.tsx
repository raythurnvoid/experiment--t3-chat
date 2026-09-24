import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { AiChatJobs } from "./ai-chat-jobs.tsx";
import type { AiChatThreadRuntime } from "@/hooks/ai-chat-controller.tsx";

type AiChatJobsTestJob = AiChatThreadRuntime["liveJobs"][number];

const liveJob = (overrides: Partial<AiChatJobsTestJob> & { jobNumber: number }): AiChatJobsTestJob => ({
	status: "running",
	shellName: "default",
	scriptPreview: "sleep 30",
	parentJobNumber: null,
	invocationId: `invocation_${overrides.jobNumber}` as AiChatJobsTestJob["invocationId"],
	startedAt: Date.now() - 65_000,
	finishedAt: undefined,
	...overrides,
});

afterEach(() => {
	cleanup();
});

describe("AiChatJobs", () => {
	test("renders nothing without live jobs", () => {
		render(<AiChatJobs liveJobs={[]} />);

		expect(screen.queryByRole("button")).toBeNull();
	});

	test("shows the count and lists each job in the popover", async () => {
		render(
			<AiChatJobs
				liveJobs={[
					liveJob({ jobNumber: 1, scriptPreview: "sleep 30" }),
					liveJob({ jobNumber: 2, shellName: "work", scriptPreview: "cp -r a b", startedAt: undefined }),
				]}
			/>,
		);

		const button = screen.getByRole("button", { name: "Background jobs, 2 running" });
		expect(button.textContent).toContain("2");
		fireEvent.click(button);

		expect(await screen.findByRole("heading", { name: "Background jobs" })).not.toBeNull();
		expect(screen.getByRole("dialog", { name: "Background jobs" })).not.toBeNull();
		expect(screen.getByText("#1 · default")).not.toBeNull();
		expect(screen.getByText("sleep 30")).not.toBeNull();
		expect(screen.getByText("1m 5s")).not.toBeNull();
		expect(screen.getByText("#2 · work")).not.toBeNull();
		expect(screen.getByText("queued")).not.toBeNull();
	});

	test("shows the empty state when the jobs drain while open", async () => {
		const view = render(<AiChatJobs liveJobs={[liveJob({ jobNumber: 1 })]} />);
		fireEvent.click(screen.getByRole("button", { name: "Background jobs, 1 running" }));
		expect(await screen.findByText("#1 · default")).not.toBeNull();

		view.rerender(<AiChatJobs liveJobs={[]} />);

		expect(await screen.findByText("No running jobs.")).not.toBeNull();
		expect(screen.getByRole("button", { name: "Background jobs" })).not.toBeNull();
		expect(view.container.querySelector(".AiChatJobs-badge")).toBeNull();
	});
});
