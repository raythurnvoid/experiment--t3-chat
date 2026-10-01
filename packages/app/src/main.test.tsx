import { Children, isValidElement, type ReactNode } from "react";
import type { RootOptions } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";

const { routerState, createRoot } = vi.hoisted(() => ({
	routerState: { pathname: "/" },
	createRoot: vi.fn<(container: unknown, options?: RootOptions) => { render: (tree: ReactNode) => void }>(),
}));

// `main.tsx` renders at import time. Mock what it touches, so the test only reads what it would render.
vi.mock("react-dom/client", () => ({ createRoot }));
vi.mock("./lib/app-router.ts", () => ({
	app_router: () => ({ state: { location: { pathname: routerState.pathname } } }),
}));
vi.mock("./lib/app-convex-client.ts", () => ({ app_convex: { connectionState: () => {} } }));
vi.mock("./lib/app-qa.ts", () => ({ app_qa_install: () => {} }));
vi.mock("./lib/app-scrollbar.ts", () => ({ app_scrollbar_install: () => {} }));
vi.mock("@clerk/clerk-react", () => ({ ClerkProvider: () => null }));
vi.mock("./components/app-auth.tsx", () => ({
	AppAuthProvider: Object.assign(() => null, { useConvexAuth: () => null }),
}));

/**
 * Run `main.tsx` again for one pathname and return what it passed to React.
 */
async function run_main(pathname: string) {
	routerState.pathname = pathname;
	const render = vi.fn<(tree: ReactNode) => void>();
	createRoot.mockReset();
	createRoot.mockReturnValue({ render });

	vi.resetModules();
	await import("./main.tsx");
	// Read the mocks from the same module registry that `main.tsx` used.
	const { ClerkProvider } = await import("@clerk/clerk-react");
	const { AppAuthProvider } = await import("./components/app-auth.tsx");

	return {
		options: createRoot.mock.calls[0]?.[1],
		types: element_types(render.mock.calls[0]?.[0]),
		ClerkProvider,
		AppAuthProvider,
	};
}

function element_types(node: ReactNode): unknown[] {
	if (!isValidElement<{ children?: ReactNode }>(node)) {
		return [];
	}

	return [node.type, ...Children.toArray(node.props.children).flatMap(element_types)];
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("main", () => {
	test("renders the share page without Clerk or app auth, and logs no error details", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubEnv("VITE_CLERK_FRONTEND_API_HOST", "clerk.test");

		const { options, types, ClerkProvider, AppAuthProvider } = await run_main("/share/abc");

		expect(types).not.toContain(ClerkProvider);
		expect(types).not.toContain(AppAuthProvider);
		expect(document.head.querySelector('link[href*="clerk.test"]')).toBeNull();

		const error = new Error("tok_1");
		options!.onCaughtError!(error, { componentStack: "" });
		options!.onUncaughtError!(error, { componentStack: "" });
		options!.onRecoverableError!(error, { componentStack: "" });
		expect(consoleError.mock.calls).toEqual(Array(3).fill(["[main.renderSharePage] Share page error"]));
	});

	test("renders the app with Clerk and app auth", async () => {
		vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_main");

		const { types, ClerkProvider, AppAuthProvider } = await run_main("/w/a/b/files");

		expect(types).toContain(ClerkProvider);
		expect(types).toContain(AppAuthProvider);
	});
});
