import "@/app.css";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useState, type CSSProperties, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { MyIconButton } from "./my-icon-button.tsx";
import { MyModal, MyModalHeading, MyModalPopover } from "./my-modal.tsx";
import { MyPopover, MyPopoverClose, MyPopoverContent, MyPopoverTrigger, type MyPopover_Props } from "./my-popover.tsx";

/**
 * Render the app containers first. `MyModalPopover` reads `#app_hoisting_container` while it renders.
 */
function renderInShell(children: ReactNode) {
	const shell = render(
		<div id="root">
			<div data-testid="content" />
			<div id="app_hoisting_container" />
		</div>,
	);
	return render(children, { container: shell.getByTestId("content") });
}

type TestPopover_Props = Omit<MyPopover_Props, "children"> & {
	label: string;
	triggerStyle?: CSSProperties;
	contentStyle?: CSSProperties;
	gutter?: number;
	unmountOnHide?: boolean;
	children: ReactNode;
};

function TestPopover(props: TestPopover_Props) {
	const { label, triggerStyle, contentStyle, gutter, unmountOnHide, children, ...rest } = props;

	return (
		<MyPopover {...rest}>
			<MyPopoverTrigger>
				<button type="button" style={triggerStyle}>
					{label}
				</button>
			</MyPopoverTrigger>
			<MyPopoverContent aria-label={label} style={contentStyle} gutter={gutter} unmountOnHide={unmountOnHide}>
				{children}
			</MyPopoverContent>
		</MyPopover>
	);
}

function trigger(name: string) {
	return screen.getByRole("button", { name });
}

function dialog(name: string) {
	return screen.queryByRole("dialog", { name });
}

async function openByClick(name: string) {
	await userEvent.click(trigger(name));
	await waitFor(() => expect(dialog(name)).not.toBeNull());
	return dialog(name)!;
}

beforeEach(async () => {
	// The placement tests copy the real trigger positions and Ariakit's numbers at this screen size.
	await page.viewport(1440, 900);
});

afterEach(() => cleanup());

describe("MyPopover placement", () => {
	// The fixed boxes copy the real triggers: the notifications bell, the chat jobs button, and the
	// rich text link and comment buttons.
	const fixedTrigger = (style: CSSProperties): CSSProperties => ({
		position: "fixed",
		boxSizing: "border-box",
		...style,
	});

	test("bottom with the default gutter stays 8px from the right edge, like Ariakit", async () => {
		renderInShell(
			<TestPopover
				label="Notifications"
				triggerStyle={fixedTrigger({ top: 5, right: 12, width: 36, height: 36 })}
				contentStyle={{ width: 380, height: 200 }}
			>
				Items
			</TestPopover>,
		);

		const content = (await openByClick("Notifications")).getBoundingClientRect();
		const button = trigger("Notifications").getBoundingClientRect();
		expect(Math.abs(content.top - button.bottom - 4)).toBeLessThanOrEqual(0.5);
		expect(content.width).toBe(380);
		expect(Math.abs(innerWidth - content.right - 8)).toBeLessThanOrEqual(0.5);
	});

	test("flips to the top when there is no room below", async () => {
		renderInShell(
			<TestPopover
				label="Jobs"
				triggerStyle={fixedTrigger({ top: 834, left: 1125, width: 36, height: 36 })}
				contentStyle={{ width: 320, height: 130 }}
			>
				Job list
			</TestPopover>,
		);

		const content = (await openByClick("Jobs")).getBoundingClientRect();
		const button = trigger("Jobs").getBoundingClientRect();
		expect(Math.abs(button.top - content.bottom - 4)).toBeLessThanOrEqual(0.5);
		expect(content.width).toBe(320);
		expect(Math.abs(content.left + content.width / 2 - (button.left + button.width / 2))).toBeLessThanOrEqual(0.5);
	});

	test("bottom-end with gutter 10 ends at the trigger's right edge", async () => {
		renderInShell(
			<TestPopover
				label="Comment"
				placement="bottom-end"
				gutter={10}
				triggerStyle={fixedTrigger({ top: 319, left: 961, width: 106, height: 36 })}
				contentStyle={{ width: 350, height: 52 }}
			>
				Composer
			</TestPopover>,
		);

		const content = (await openByClick("Comment")).getBoundingClientRect();
		const button = trigger("Comment").getBoundingClientRect();
		expect(Math.abs(content.top - button.bottom - 10)).toBeLessThanOrEqual(0.5);
		expect(Math.abs(content.right - button.right)).toBeLessThanOrEqual(0.5);
		expect(content.width).toBe(350);
	});

	test("bottom with gutter 10 is centered under the trigger", async () => {
		renderInShell(
			<TestPopover
				label="Link"
				gutter={10}
				triggerStyle={fixedTrigger({ top: 52, left: 550, width: 74, height: 36 })}
				contentStyle={{ width: 240, height: 36 }}
			>
				URL
			</TestPopover>,
		);

		const content = (await openByClick("Link")).getBoundingClientRect();
		const button = trigger("Link").getBoundingClientRect();
		expect(Math.abs(content.top - button.bottom - 10)).toBeLessThanOrEqual(0.5);
		expect(Math.abs(content.left + content.width / 2 - (button.left + button.width / 2))).toBeLessThanOrEqual(0.5);
		expect(content.width).toBe(240);
	});
});

describe("MyPopover focus on open", () => {
	test("moves to the first tabbable element", async () => {
		renderInShell(
			<TestPopover label="Notifications">
				<p>Recent</p>
				<button type="button">Dismiss all</button>
				<button type="button">Open item</button>
			</TestPopover>,
		);

		await openByClick("Notifications");
		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Dismiss all" })));
	});

	test("moves to an input when it comes first", async () => {
		renderInShell(
			<TestPopover label="Add link">
				<input aria-label="Link URL" />
				<button type="button">Apply link</button>
			</TestPopover>,
		);

		await openByClick("Add link");
		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Link URL" })));
	});

	test("moves to the content when nothing inside is tabbable", async () => {
		renderInShell(
			<TestPopover label="Jobs">
				<p>No running jobs.</p>
			</TestPopover>,
		);

		const content = await openByClick("Jobs");
		await waitFor(() => expect(document.activeElement).toBe(content));
	});
});

describe("MyPopover closing", () => {
	test("Escape closes and moves focus back to the trigger", async () => {
		renderInShell(
			<TestPopover label="Notifications">
				<button type="button">Dismiss all</button>
			</TestPopover>,
		);

		await openByClick("Notifications");
		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Dismiss all" })));
		await userEvent.keyboard("{Escape}");

		await waitFor(() => expect(dialog("Notifications")).toBeNull());
		expect(document.activeElement).toBe(trigger("Notifications"));
	});

	test("MyPopoverClose closes and moves focus back to the trigger", async () => {
		renderInShell(
			<TestPopover label="Filters">
				<MyPopoverClose>Done</MyPopoverClose>
			</TestPopover>,
		);

		await openByClick("Filters");
		await userEvent.click(screen.getByRole("button", { name: "Done" }));

		await waitFor(() => expect(dialog("Filters")).toBeNull());
		expect(document.activeElement).toBe(trigger("Filters"));
	});

	test("an outside click closes and leaves focus where the user clicked", async () => {
		renderInShell(
			<>
				<TestPopover label="Notifications">
					<button type="button">Dismiss all</button>
				</TestPopover>
				<button type="button">Outside</button>
			</>,
		);

		await openByClick("Notifications");
		await userEvent.click(screen.getByRole("button", { name: "Outside" }));

		await waitFor(() => expect(dialog("Notifications")).toBeNull());
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Outside" }));
	});

	test("a trigger click while open closes it once and never reopens it", async () => {
		const requests: boolean[] = [];

		function Controlled() {
			const [open, setOpen] = useState(false);

			return (
				<TestPopover
					label="Jobs"
					open={open}
					setOpen={(next) => {
						requests.push(next);
						setOpen(next);
					}}
				>
					<p>Job list</p>
				</TestPopover>
			);
		}

		renderInShell(<Controlled />);
		await openByClick("Jobs");
		await userEvent.click(trigger("Jobs"));

		await waitFor(() => expect(dialog("Jobs")).toBeNull());
		// Wait past a possible late reopen, then check once.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(dialog("Jobs")).toBeNull();
		expect(requests).toEqual([true, false]);
		expect(document.activeElement).toBe(trigger("Jobs"));
	});
});

describe("MyPopover nesting", () => {
	test("Escape closes a tooltip inside the popover first, then the popover", async () => {
		renderInShell(
			<TestPopover label="Add link">
				<input aria-label="Link URL" />
				<MyIconButton tooltip="Apply link">+</MyIconButton>
			</TestPopover>,
		);

		await openByClick("Add link");
		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Link URL" })));
		await userEvent.keyboard("{Tab}");
		await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeNull());

		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
		expect(dialog("Add link")).not.toBeNull();

		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(dialog("Add link")).toBeNull());
		expect(document.activeElement).toBe(trigger("Add link"));
	});

	test("a modal opened from inside the popover closes first, and the popover waits under it", async () => {
		function NotificationsWithModal() {
			const [modalOpen, setModalOpen] = useState(false);

			return (
				<>
					<TestPopover label="Notifications" unmountOnHide>
						<button type="button" onClick={() => setModalOpen(true)}>
							View review progress
						</button>
					</TestPopover>
					{/* Outside the popover, like the review modal that a provider renders. */}
					<MyModal open={modalOpen} setOpen={setModalOpen}>
						<MyModalPopover>
							<MyModalHeading>Review progress</MyModalHeading>
							<button type="button">Close review</button>
						</MyModalPopover>
					</MyModal>
				</>
			);
		}

		renderInShell(<NotificationsWithModal />);
		await openByClick("Notifications");
		const viewButton = screen.getByRole("button", { name: "View review progress" });
		await waitFor(() => expect(document.activeElement).toBe(viewButton));
		await userEvent.keyboard("{Enter}");

		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Review progress" })).not.toBeNull());
		// The modal made the popover inert, and the popover is hidden under it but still open.
		expect(dialog("Notifications")).toBeNull();
		expect(trigger("Notifications").getAttribute("aria-expanded")).toBe("true");

		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Review progress" })).toBeNull());
		await waitFor(() => expect(dialog("Notifications")).not.toBeNull());
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole("button", { name: "View review progress" })),
		);

		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(dialog("Notifications")).toBeNull());
		expect(document.activeElement).toBe(trigger("Notifications"));
	});

	test("a popover inside a modal closes first on Escape and on a click in the modal", async () => {
		renderInShell(
			<MyModal defaultOpen>
				<MyModalPopover>
					<MyModalHeading>Settings</MyModalHeading>
					<TestPopover label="Options">
						<button type="button">Option</button>
					</TestPopover>
				</MyModalPopover>
			</MyModal>,
		);

		const settings = await screen.findByRole("dialog", { name: "Settings" });
		await openByClick("Options");
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(dialog("Options")).toBeNull());
		expect(screen.queryByRole("dialog", { name: "Settings" })).toBe(settings);

		await openByClick("Options");
		await userEvent.click(screen.getByRole("heading", { name: "Settings" }));
		await waitFor(() => expect(dialog("Options")).toBeNull());
		expect(screen.queryByRole("dialog", { name: "Settings" })).toBe(settings);

		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
	});
});

describe("MyPopover controlled under StrictMode", () => {
	test("open and setOpen follow the parent, and the parent can refuse a close", async () => {
		const requests: boolean[] = [];
		let refuseClose = false;

		function Controlled() {
			const [open, setOpen] = useState(false);

			return (
				<TestPopover
					label="Jobs"
					open={open}
					setOpen={(next) => {
						requests.push(next);
						if (next || !refuseClose) setOpen(next);
					}}
					unmountOnHide
				>
					<button type="button" onClick={() => setOpen(false)}>
						Close from the parent
					</button>
				</TestPopover>
			);
		}

		renderInShell(
			<StrictMode>
				<Controlled />
			</StrictMode>,
		);

		await openByClick("Jobs");
		expect(screen.getAllByRole("dialog")).toHaveLength(1);
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(dialog("Jobs")).toBeNull());
		expect(requests).toEqual([true, false]);

		// The parent closes it without a popover request.
		await openByClick("Jobs");
		await userEvent.click(screen.getByRole("button", { name: "Close from the parent" }));
		await waitFor(() => expect(dialog("Jobs")).toBeNull());
		expect(document.activeElement).toBe(trigger("Jobs"));
		expect(requests).toEqual([true, false, true]);

		// The parent ignores the close: the popover stays open, and setOpen still heard it.
		refuseClose = true;
		await openByClick("Jobs");
		await userEvent.keyboard("{Escape}");
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(dialog("Jobs")).not.toBeNull();
		expect(requests).toEqual([true, false, true, true, false]);
	});

	test("a popover that starts open stays open and asks for nothing", async () => {
		const requests: boolean[] = [];

		function StartsOpen() {
			const [open, setOpen] = useState(true);

			return (
				<TestPopover
					label="Jobs"
					open={open}
					setOpen={(next) => {
						requests.push(next);
						setOpen(next);
					}}
				>
					<p>Job list</p>
				</TestPopover>
			);
		}

		renderInShell(
			<StrictMode>
				<StartsOpen />
			</StrictMode>,
		);

		await waitFor(() => expect(dialog("Jobs")).not.toBeNull());
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(dialog("Jobs")).not.toBeNull();
		expect(requests).toEqual([]);
	});
});
