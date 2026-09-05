import { describe, expect, test, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: (_path: string) => (options: unknown) => ({ options }),
}));

vi.mock("@/components/files/file-node-view/file-node-view.tsx", () => ({
	FileNodeView: () => null,
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({ organizationName: "personal", workspaceName: "home" }),
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
});
