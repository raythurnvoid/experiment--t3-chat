import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

const { routeParams, pathAccess } = vi.hoisted(() => ({
	routeParams: { _splat: "" },
	pathAccess: { value: "missing" },
}));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: (_path: string) => (options: unknown) => ({
		options,
		useParams: () => routeParams,
		useSearch: () => ({}),
	}),
	useNavigate: () => vi.fn(),
}));

// A link shows its search query, so the test can read where it goes.
vi.mock("@/components/my-link.tsx", () => ({
	MyLink: (props: { search: { q?: string }; children: ReactNode }) => (
		<a href={`?q=${props.search.q ?? ""}`}>{props.children}</a>
	),
}));

// The path lookup answers null, and the access query says why.
vi.mock("convex/react", async (importOriginal) => ({
	...(await importOriginal<typeof import("convex/react")>()),
	useQuery: (_query: unknown, args: unknown) =>
		args === "skip" ? undefined : _query === "access" ? pathAccess.value : null,
}));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex_api: { files_nodes: { get_visible_target_by_path: "target", get_path_access_for_membership: "access" } },
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({ membershipId: "membership_1", organizationName: "personal", workspaceName: "home" }),
	},
}));

import { Route } from "./$.tsx";

afterEach(() => {
	cleanup();
	pathAccess.value = "missing";
});

describe("File not found", () => {
	const RouteFilesPath = (Route as unknown as { options: { component: () => ReactNode } }).options.component;

	test("searches for the last name of the missing path", () => {
		routeParams._splat = "docs/old/api notes.md";
		render(<RouteFilesPath />);

		expect(screen.getByRole("heading", { name: "File not found" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "Search for api notes.md" }).getAttribute("href")).toBe("?q=api notes.md");
	});

	test("has no search button for the root path", () => {
		routeParams._splat = "";
		render(<RouteFilesPath />);

		expect(screen.getByRole("heading", { name: "File not found" })).toBeTruthy();
		expect(screen.queryByRole("link", { name: /^Search for/ })).toBeNull();
		expect(screen.getByRole("link", { name: "Go to files home" })).toBeTruthy();
	});
});

describe("Locked path", () => {
	const RouteFilesPath = (Route as unknown as { options: { component: () => ReactNode } }).options.component;

	test("a locked path shows the access screen with no search", () => {
		routeParams._splat = "Team/plan.md";
		pathAccess.value = "locked";
		render(<RouteFilesPath />);

		expect(screen.getByRole("heading", { name: "You don't have access to this item" })).toBeTruthy();
		expect(screen.getByText("/Team/plan.md")).toBeTruthy();
		expect(screen.queryByRole("link", { name: /^Search for/ })).toBeNull();
		expect(screen.getByRole("link", { name: "Go to files home" })).toBeTruthy();
	});
});
