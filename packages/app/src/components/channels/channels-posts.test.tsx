import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ComponentProps } from "react";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { ChannelsPosts } from "./channels-posts.tsx";

const { mutation } = vi.hoisted(() => ({
	mutation: vi.fn(async (_query: unknown, _args: unknown) => ({ _yay: null })),
}));
vi.mock("@/lib/app-convex-client.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/app-convex-client.ts")>()),
	app_convex: { mutation },
}));
vi.mock("convex/react", async (importOriginal) => ({
	...(await importOriginal<typeof import("convex/react")>()),
	useQuery: () => ({ page: [], isDone: true, continueCursor: "" }),
	useConvexConnectionState: () => ({ isWebSocketConnected: true }),
}));
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: { useContext: () => ({ membershipId: "membership" }) },
}));

const observers: PostsObserver[] = [];
class PostsObserver implements IntersectionObserver {
	root = null;
	rootMargin = "0px";
	scrollMargin = "0px";
	thresholds = [0];
	observe = vi.fn();
	unobserve = vi.fn();
	disconnect = vi.fn();
	takeRecords = () => [];
	constructor(readonly callback: IntersectionObserverCallback) {
		observers.push(this);
	}
	emit(isIntersecting: boolean) {
		this.callback([{ isIntersecting } as IntersectionObserverEntry], this);
	}
}

function fixture(): ComponentProps<typeof ChannelsPosts> {
	return {
		channelId: "channel" as app_convex_Id<"channels">,
		canPost: false,
		mentionItems: [],
		onThread: vi.fn(),
		state: {
			activity: {
				_id: "activity" as app_convex_Id<"channels_activity">,
				_creationTime: 1,
				channelId: "channel" as app_convex_Id<"channels">,
				organizationId: "organization" as app_convex_Id<"organizations">,
				workspaceId: "workspace" as app_convex_Id<"organizations_workspaces">,
				lastChannelSequence: 4,
				lastMainSequence: 0,
				lastMessageAt: 1,
				memberCount: 1,
			},
			member: null,
			readSequence: 2,
			unread: false,
			mentionCount: 0,
		},
	};
}

beforeEach(() => {
	observers.length = 0;
	mutation.mockClear();
	vi.stubGlobal("IntersectionObserver", PostsObserver);
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("ChannelsPosts", () => {
	test("a closed comments list marks nothing read", async () => {
		render(<ChannelsPosts {...fixture()} />);
		await act(async () => observers[0]!.emit(false));
		expect(mutation, "a hidden Comments tab must not mark posts read").not.toHaveBeenCalled();
	});
	test("a visit captures its head once and a later visit gets a new head", async () => {
		const props = fixture();
		const view = render(<ChannelsPosts {...props} />);
		await act(async () => observers[0]!.emit(true));
		expect(mutation.mock.calls[0]?.[1], "the visit must mark only its captured head").toEqual({
			membershipId: "membership",
			channelId: "channel",
			sequence: 4,
		});
		view.rerender(
			<ChannelsPosts
				{...props}
				state={{ ...props.state!, activity: { ...props.state!.activity, lastChannelSequence: 5 }, readSequence: 4 }}
			/>,
		);
		expect(mutation, "new activity during a visit must stay unread").toHaveBeenCalledTimes(1);
		await act(async () => observers[0]!.emit(false));
		await act(async () => observers[0]!.emit(true));
		expect(mutation.mock.calls[1]?.[1]).toEqual({ membershipId: "membership", channelId: "channel", sequence: 5 });
	});
});
