import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { AiChatThreadRuntime } from "@/hooks/ai-chat-controller.tsx";

// Network boundary: the real hooks talk to a live Convex client.
vi.mock("convex/react", () => ({
	useQuery: () => undefined,
}));

// The real module creates a live ConvexReactClient at import (needs VITE_CONVEX_URL).
vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex_api: {},
}));

// Provider boundary: the real useContext throws without an AppTenantProvider mounted above.
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({ membershipId: "membership_1" }),
	},
}));

// The controller store lives outside the component; the thread only reads the editing map.
vi.mock("@/hooks/ai-chat-controller.tsx", () => ({
	AiChatController: {
		useStore: (selector: (state: { editingMessageIdByThreadId: Map<string, string> }) => unknown) =>
			selector({ editingMessageIdByThreadId: new Map() }),
	},
}));

// The real composer boots a Tiptap editor; the stub only needs the class the test asserts on.
vi.mock("@/components/ai-chat/ai-chat-composer.tsx", () => ({
	AiChatComposer: function AiChatComposer() {
		return <div className="AiChatComposer" />;
	},
}));

vi.mock("@/components/ai-chat/ai-chat-message.tsx", () => ({
	AiChatMessage: function AiChatMessage() {
		return <div />;
	},
}));

vi.mock("@/components/ai-chat/ai-chat-threads.tsx", () => ({
	AiChatThreads: function AiChatThreads() {
		return <div />;
	},
}));

vi.mock("@/components/main-app-sidebar-toggle.tsx", () => ({
	MainAppSidebarToggle: function MainAppSidebarToggle() {
		return <div />;
	},
}));

// CatchBoundary is a plain error boundary; the stub renders children without a router.
vi.mock("@tanstack/react-router", () => ({
	CatchBoundary: function CatchBoundary(props: { children?: ReactNode }) {
		return <>{props.children}</>;
	},
}));

// The real hook attaches scroll listeners to live elements; the thread only reads isAtBottom.
vi.mock("@/lib/ui.tsx", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ui.tsx")>()),
	useUiStickToBottom: () => ({ isAtBottom: true, scrollToBottom: vi.fn() }),
}));

import { AiChatThread } from "./ai-chat.tsx";

/** Minimal idle-thread runtime: empty branch, nothing streaming, welcome screen state. */
function makeController(): AiChatThreadRuntime {
	return {
		selectedThreadId: null,
		selectedModelId: "model_1",
		selectedModeId: "mode_agent",
		session: null,
		status: "ready",
		error: null,
		isRunning: false,
		canSendUserText: true,
		activeBranchMessages: { list: [], anchorId: null },
		addToolOutput: vi.fn(),
		resumeStream: vi.fn(),
		stop: vi.fn(),
		setSelectedModelId: vi.fn(),
		setSelectedModeId: vi.fn(),
		sendUserText: vi.fn(),
		regenerate: vi.fn(),
		setComposerValue: vi.fn(),
	} as unknown as AiChatThreadRuntime;
}

afterEach(() => {
	cleanup();
});

describe("AiChatThread", () => {
	test("renders composerTopSlot inside the composer stack, above the composer", () => {
		const { container } = render(
			<AiChatThread
				controller={makeController()}
				scrollableContainer={null}
				composerTopSlot={<div data-testid="composer-top-slot" />}
			/>,
		);

		const stack = container.querySelector(".AiChatThread-composer-stack");
		expect(stack).toBeTruthy();

		const slot = stack?.querySelector("[data-testid='composer-top-slot']");
		const composer = stack?.querySelector(".AiChatComposer");
		expect(slot).toBeTruthy();
		expect(composer).toBeTruthy();
		// The slot must come before the composer in DOM order.
		expect(slot && composer && slot.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	test("renders only the composer in the stack when no slot is passed", () => {
		const { container } = render(<AiChatThread controller={makeController()} scrollableContainer={null} />);

		const stack = container.querySelector(".AiChatThread-composer-stack");
		expect(stack).toBeTruthy();
		expect(stack?.childElementCount).toBe(1);
		expect(stack?.firstElementChild?.classList.contains("AiChatComposer")).toBe(true);
	});
});
