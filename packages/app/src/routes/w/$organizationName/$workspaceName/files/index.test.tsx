import { act, render } from "@testing-library/react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { StrictMode, createElement, type ComponentType } from "react";
import { describe, expect, test, vi } from "vitest";

const { routerListeners, routerLocation, loadedNodes, preloadSnapshot } = vi.hoisted(() => ({
	routerListeners: [] as Array<(event: unknown) => void>,
	routerLocation: { search: {} as Record<string, unknown> },
	loadedNodes: new Map<string, unknown>(),
	preloadSnapshot: vi.fn(() => () => {}),
}));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: (_path: string) => (options: unknown) => ({
		options,
		useNavigate: () => () => Promise.resolve(),
		useSearch: () => ({}),
	}),
	useRouter: () => ({
		state: { location: routerLocation },
		subscribe: (_name: string, listener: (event: unknown) => void) => {
			routerListeners.push(listener);
			// StrictMode subscribes twice, so the first listener must really go away.
			return () => {
				routerListeners.splice(routerListeners.indexOf(listener), 1);
			};
		},
	}),
}));

vi.mock("@/lib/files-tree-context.tsx", () => ({
	FilesTreeProvider: { useGetLoadedNode: () => (nodeId: string) => loadedNodes.get(nodeId) },
}));

vi.mock("@/lib/files-yjs-snapshot-preload.ts", () => ({ files_yjs_preload_snapshot: preloadSnapshot }));

vi.mock("@/components/files/file-node-view/file-node-view.tsx", () => ({
	FileNodeView: () => null,
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({ membershipId: "m1", organizationName: "personal", workspaceName: "home" }),
	},
}));

import { Route } from "./index.tsx";

describe("validateSearch", () => {
	test("keeps a search query up to the cap and drops a longer one", () => {
		const validateSearch = Route.options.validateSearch as {
			parse: (input: unknown) => { q?: string; nodeId?: string };
		};
		expect(validateSearch.parse({ q: "a".repeat(2000) }).q).toHaveLength(2000);
		expect(validateSearch.parse({ q: "a".repeat(2001) }).q).toBeUndefined();
		expect(validateSearch.parse({}).q).toBeUndefined();
		// A hand-typed `?q=2026` reaches the schema as a JSON number and must stay a query.
		expect(validateSearch.parse({ q: 2026 }).q).toBe("2026");
		expect(validateSearch.parse({ q: true }).q).toBe("true");
		// A shared link keeps its file when only the query is too long.
		const withNode = validateSearch.parse({ nodeId: "k57", q: "a".repeat(2001) });
		expect(withNode.nodeId).toBe("k57");
		expect(withNode.q).toBeUndefined();
	});

	test("cleans the folder table filter and keeps the typed text up to the cap", () => {
		const validateSearch = Route.options.validateSearch as {
			parse: (input: unknown) => { filter?: string; view_q?: string };
		};
		// The cleaner keeps one filter or the allowed pair, and drops what cannot run: an old `contains`
		// or `missing` filter, and a sort the filter does not allow.
		expect(
			validateSearch.parse({
				filter:
					"junk file.name:contains:a file.name:starts_with:b file.size:is:1 metadata.x:missing sort_by:file.updated:desc sort_by:file.name:desc",
			}).filter,
		).toBe("file.name:starts_with:b file.size:is:1 sort_by:file.name:desc");
		expect(validateSearch.parse({ filter: "junk" }).filter).toBeUndefined();
		expect(validateSearch.parse({ view_q: "file.na" }).view_q).toBe("file.na");
		expect(validateSearch.parse({ view_q: "a".repeat(2001) }).view_q).toBeUndefined();
	});
});

describe("README preload", () => {
	test("two navigations to the same folder each end their own README subscription", () => {
		vi.useFakeTimers();
		// A socket that never opens keeps the real client local.
		const client = new ConvexReactClient("https://files-route-test.convex.cloud", {
			webSocketConstructor: class {} as unknown as typeof WebSocket,
		});
		const view = render(
			createElement(ConvexProvider, { client }, createElement(Route.options.component as ComponentType)),
		);
		const event = { pathChanged: false, toLocation: { search: { nodeId: "k57" } } };
		for (const listener of routerListeners) listener(event);
		for (const listener of routerListeners) listener(event);
		// The real client throws when one listener is removed twice.
		expect(() => act(() => vi.advanceTimersByTime(10_000))).not.toThrow();
		view.unmount();
		vi.useRealTimers();
	});
});

describe("snapshot preload", () => {
	test("preloads a page load once and a clicked rich text file, but not a known folder or the open file", () => {
		vi.useFakeTimers();
		routerListeners.length = 0;
		preloadSnapshot.mockClear();
		routerLocation.search = { nodeId: "unknown" };
		const richText = { kind: "file", locked: false, assetId: "a1", textKind: "rich_text", collaborationEnabled: true };
		loadedNodes.set("folder", { kind: "folder", locked: false, assetId: null, textKind: null });
		loadedNodes.set("text", { ...richText, textKind: "plain_text" });
		loadedNodes.set("file", richText);
		const client = new ConvexReactClient("https://files-route-test.convex.cloud", {
			webSocketConstructor: class {} as unknown as typeof WebSocket,
		});
		// Render the way the app does. StrictMode runs the mount effect twice in development.
		const view = render(
			createElement(ConvexProvider, { client }, createElement(Route.options.component as ComponentType)),
			{ wrapper: StrictMode },
		);
		act(() => vi.advanceTimersByTime(0));

		// A page load does not know the node's type yet.
		expect(preloadSnapshot).toHaveBeenCalledExactlyOnceWith({ membershipId: "m1", nodeId: "unknown" });
		preloadSnapshot.mockClear();

		// The router's `fromLocation` is the last finished navigation, so it can stay old.
		const navigate = (to: string) => {
			const event = {
				pathChanged: false,
				fromLocation: { search: { nodeId: "unknown" } },
				toLocation: { search: { nodeId: to } },
			};
			for (const listener of routerListeners) listener(event);
		};
		navigate("folder");
		navigate("text");
		expect(preloadSnapshot).not.toHaveBeenCalled();
		navigate("file");
		// The view writes its `view` param before the click's navigation finishes.
		navigate("file");
		expect(preloadSnapshot).toHaveBeenCalledExactlyOnceWith({ membershipId: "m1", nodeId: "file" });

		view.unmount();
		vi.useRealTimers();
	});
});
