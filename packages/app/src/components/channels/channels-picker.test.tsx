import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ChannelsNamedPicker } from "./channels-picker.tsx";
import { AppChannelsProvider } from "@/lib/app-channels-context.tsx";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

const scope = vi.hoisted(() => ({ key: "access-1" as string | null, status: "delayed" }));
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: { useContext: () => ({ membershipId: "member" }) },
}));
const router = vi.hoisted(() => ({
	state: { location: { pathname: "/files", href: "/files", state: {} } },
	history: { subscribe: () => () => {} },
	subscribe: () => () => {},
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useRouter: () => router,
}));

const values = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();
let client: ConvexReactClient;
const selected = vi.fn();
function key(name: string, args: Record<string, unknown>) {
	const { paginationOpts, ...rest } = args as { paginationOpts?: { cursor: string | null } };
	return JSON.stringify({
		name,
		...Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b))),
		cursor: paginationOpts?.cursor,
	});
}
function receive(
	kind: "public" | "private",
	prefix: string,
	page: unknown[],
	accessScopeKey = scope.key,
	cursor: string | null = null,
	next = "",
) {
	act(() => {
		const id = key(`channels:${kind === "public" ? "browse_public_channels" : "search_my_private_channels"}`, {
			membershipId: "member",
			archived: false,
			prefix,
			accessScopeKey,
			paginationOpts: { cursor },
		});
		values.set(id, { page, isDone: !next, continueCursor: next });
		listeners.get(id)?.forEach((callback) => callback());
	});
}
function View(props: { prefix: string }) {
	return (
		<ConvexProvider client={client}>
			<AppChannelsProvider membershipId={"member" as app_convex_Id<"organizations_workspaces_users">}>
				<ChannelsNamedPicker prefix={props.prefix} archived={false} onSelect={(id) => selected(id)} />
			</AppChannelsProvider>
		</ConvexProvider>
	);
}
function updateScope() {
	act(() => {
		const id = key("channels_notifications:get_summary", { membershipId: "member" });
		values.set(
			id,
			scope.key === null
				? new Error("summary failed")
				: {
						state: scope.status,
						accessScopeKey: scope.key,
						...(scope.status === "delayed" && { mentionChannels: 0, unreadInbox: 0, unreadThreads: 0 }),
					},
		);
		listeners.get(id)?.forEach((callback) => callback());
	});
}
beforeEach(() => {
	scope.key = "access-1";
	scope.status = "delayed";
	values.clear();
	listeners.clear();
	selected.mockClear();
	client = new ConvexReactClient("https://picker-test.convex.cloud");
	vi.spyOn(client, "watchQuery").mockImplementation((...[query, args = {}]) => {
		const id = key(getFunctionName(query), args);
		return {
			onUpdate: (callback) => {
				const callbacks = listeners.get(id) ?? new Set<() => void>();
				callbacks.add(callback);
				listeners.set(id, callbacks);
				return () => callbacks.delete(callback);
			},
			localQueryResult: () => {
				const value = values.get(id);
				if (value instanceof Error) throw value;
				return value as never;
			},
			localQueryLogs: () => undefined,
			journal: () => undefined,
		};
	});
	updateScope();
});
afterEach(async () => {
	cleanup();
	await client.close();
	vi.restoreAllMocks();
});

test("waits for both first pages, holds disabled old rows, and keeps locked candidates", () => {
	const view = render(<View prefix="" />);
	receive("public", "", [{ _id: "public", kind: "public", name: "alpha" }]);
	expect(screen.queryByText("#alpha")).toBeNull();
	receive(
		"private",
		"",
		[
			{ state: "locked", memberId: "locked", kind: "private" },
			{ state: "unavailable", memberId: "gone", kind: "private" },
		],
		scope.key,
		null,
		"next",
	);
	expect(screen.getByRole("button", { name: "#alpha" })).toBeTruthy();
	const locked = screen.getByRole("button", { name: "No access" });
	expect(locked.matches(":disabled")).toBe(false);
	locked.focus();
	expect(document.activeElement).toBe(locked);
	fireEvent.click(locked);
	expect(screen.getByRole("status").textContent).toBe("Permission denied");
	expect(selected).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Unavailable" }));
	expect(screen.getByRole("status").textContent).toBe("Unavailable");
	expect(selected).not.toHaveBeenCalled();
	expect([...listeners].filter(([, callbacks]) => callbacks.size)).toHaveLength(3);
	fireEvent.click(screen.getByRole("button", { name: "Show more your private channels" }));
	expect([...listeners].filter(([id, callbacks]) => callbacks.size && id.includes('"cursor":"next"'))).toHaveLength(1);
	view.rerender(<View prefix="b" />);
	expect(screen.getByRole("button", { name: "#alpha" }).matches(":disabled")).toBe(true);
	fireEvent.click(screen.getByRole("button", { name: "#alpha" }));
	expect(selected).not.toHaveBeenCalled();
	receive("public", "b", [{ _id: "beta", kind: "public", name: "beta" }]);
	expect(screen.queryByText("#beta")).toBeNull();
	receive("private", "b", []);
	expect(screen.queryByText("#alpha")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "#beta" }));
	expect(selected).toHaveBeenCalledWith("beta");
});

test("access identity clears old and late pages even during repeated repair or equal totals", () => {
	const view = render(<View prefix="a" />);
	receive("public", "a", []);
	receive("private", "a", [
		{
			state: "readable",
			memberId: "private-member",
			channel: { _id: "private", kind: "private", name: "alpha secret" },
		},
	]);
	view.rerender(<View prefix="b" />);
	expect(screen.getByText("#alpha secret")).toBeTruthy();
	scope.status = "updating";
	scope.key = "access-2";
	updateScope();
	view.rerender(<View prefix="b" />);
	expect(screen.queryByText("#alpha secret")).toBeNull();
	receive("public", "b", []);
	receive("private", "b", [
		{ state: "readable", memberId: "b-member", channel: { _id: "b", kind: "private", name: "beta secret" } },
	]);
	view.rerender(<View prefix="c" />);
	scope.key = "access-3";
	updateScope();
	view.rerender(<View prefix="c" />);
	expect(screen.queryByText("#beta secret")).toBeNull();
	receive(
		"private",
		"c",
		[{ state: "readable", memberId: "late", channel: { _id: "late", kind: "private", name: "late secret" } }],
		"access-2",
	);
	expect(screen.queryByText("#late secret")).toBeNull();
	scope.status = "delayed";
	scope.key = "access-4";
	updateScope();
	view.rerender(<View prefix="c" />);
	expect(
		[...listeners]
			.filter(([id, callbacks]) => callbacks.size && !id.includes("get_summary"))
			.every(([id]) => id.includes('"accessScopeKey":"access-4"')),
	).toBe(true);
	scope.key = null;
	scope.status = "error";
	updateScope();
	view.rerender(<View prefix="c" />);
	expect([...listeners].filter(([id, callbacks]) => callbacks.size && !id.includes("get_summary"))).toHaveLength(0);
	expect(screen.getByText("Could not load channels")).toBeTruthy();
});
