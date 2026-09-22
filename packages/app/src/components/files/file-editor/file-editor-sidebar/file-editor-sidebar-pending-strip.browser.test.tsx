import "@/app.css";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ count: 1, truncated: false }));

vi.mock("convex/react", async (importOriginal) => ({
	...(await importOriginal<typeof import("convex/react")>()),
	useQuery: (_query: unknown, args: unknown) =>
		args === "skip"
			? undefined
			: [
					{ workspace: "current", organizationName: "team", workspaceName: "work", ...mocks },
					{ workspace: "personal", organizationName: "personal", workspaceName: "home", ...mocks },
				],
}));
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: { useContext: () => ({ membershipId: "membership_test" }) },
}));
vi.mock("@tanstack/react-router", () => ({
	Link: (props: {
		children: ReactNode;
		className: string;
		"aria-label": string;
		params: { organizationName: string; workspaceName: string };
	}) => (
		<a
			href={`/w/${props.params.organizationName}/${props.params.workspaceName}/files`}
			className={props.className}
			aria-label={props["aria-label"]}
		>
			{props.children}
		</a>
	),
}));

import { FileEditorSidebarPendingStrip } from "./file-editor-sidebar-pending-strip.tsx";

beforeEach(() => {
	mocks.count = 1;
	mocks.truncated = false;
});
afterEach(cleanup);

describe("FileEditorSidebarPendingStrip layout", () => {
	test.each([
		{ width: 123, count: 1, truncated: false },
		{ width: 150, count: 1, truncated: false },
		{ width: 260, count: 1, truncated: false },
		{ width: 123, count: 500, truncated: true },
	])("keeps both destinations and count $count readable at $width px", ({ width, count, truncated }) => {
		mocks.count = count;
		mocks.truncated = truncated;
		// The real chat provides this container. Viewport width alone does not size its sidebar.
		render(
			<div style={{ width, containerType: "inline-size" }}>
				<FileEditorSidebarPendingStrip threadId="thread_saved" />
			</div>,
		);
		const links = screen.getAllByRole("link");
		expect(links).toHaveLength(2);
		expect(links.map((link) => link.getAttribute("href"))).toEqual(["/w/team/work/files", "/w/personal/home/files"]);
		for (const link of links) {
			const label = link.querySelector<HTMLElement>(".FileEditorSidebarPendingStrip-label")!;
			const icon = link.querySelector<SVGElement>(".FileEditorSidebarPendingStrip-icon")!;
			const count = link.querySelector<HTMLElement>(".FileEditorSidebarPendingStrip-count")!;
			const review = link.querySelector<HTMLElement>(".FileEditorSidebarPendingStrip-review")!;
			const rowRect = link.getBoundingClientRect();
			const labelRect = label.getBoundingClientRect();
			const iconRect = icon.getBoundingClientRect();
			const countRect = count.getBoundingClientRect();
			const reviewRect = review.getBoundingClientRect();
			expect(label.clientWidth).toBeGreaterThan(60);
			expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
			expect(label.scrollHeight).toBeLessThanOrEqual(label.clientHeight);
			expect(labelRect.bottom).toBeLessThanOrEqual(reviewRect.top);
			expect(countRect.left).toBeGreaterThanOrEqual(iconRect.right);
			expect(countRect.right).toBeLessThanOrEqual(rowRect.right);
			expect(countRect.right <= reviewRect.left || countRect.bottom <= reviewRect.top).toBe(true);
			expect(reviewRect.right).toBeLessThanOrEqual(rowRect.right);
			expect(reviewRect.bottom).toBeLessThanOrEqual(rowRect.bottom);
			expect(rowRect.width).toBeLessThanOrEqual(width);
		}
		expect(links[0].getBoundingClientRect().bottom).toBeLessThanOrEqual(links[1].getBoundingClientRect().top);
	});

	test("keeps the compact one-line rows in a wide chat", () => {
		render(
			<div style={{ width: 480, containerType: "inline-size" }}>
				<FileEditorSidebarPendingStrip threadId="thread_saved" />
			</div>,
		);
		for (const link of screen.getAllByRole("link")) expect(link.getBoundingClientRect().height).toBe(42);
	});
});
