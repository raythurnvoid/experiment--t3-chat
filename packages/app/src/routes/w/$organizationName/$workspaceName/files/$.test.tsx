import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

const { routeParams } = vi.hoisted(() => ({ routeParams: { _splat: "" } }));

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

// The path is looked up and missing.
vi.mock("convex/react", async (importOriginal) => ({
	...(await importOriginal<typeof import("convex/react")>()),
	useQuery: () => null,
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({ membershipId: "membership_1", organizationName: "personal", workspaceName: "home" }),
	},
}));

import { Route } from "./$.tsx";

afterEach(cleanup);

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
