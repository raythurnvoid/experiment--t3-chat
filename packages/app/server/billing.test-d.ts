import { expectTypeOf, test } from "vitest";
import type { Id } from "../convex/_generated/dataModel.js";
import { billing_event, type billing_Event } from "./billing.ts";

test("billing_Event exposes the full event name union", () => {
	expectTypeOf<billing_Event["name"]>().toEqualTypeOf<"manual_credit" | "page_save" | "monthly_credit" | "ai_usage">();
});

test("billing_Event can be discriminated by built payload name", () => {
	type PageSaveEvent = Extract<billing_Event, { name: "page_save" }>;
	type ExtractedPageSaveEvent = Extract<billing_Event, { name: "page_save" }>;

	expectTypeOf<PageSaveEvent>().toEqualTypeOf<ExtractedPageSaveEvent>();
	expectTypeOf<PageSaveEvent>().toHaveProperty("externalCustomerId");
	expectTypeOf<PageSaveEvent>().toHaveProperty("externalId");
	expectTypeOf<PageSaveEvent>().toHaveProperty("metadata");
});

test("billing_event preserves the matching source-specific payload type", () => {
	const pageSaveEvent = billing_event({
		name: "page_save",
		externalCustomerId: "billed_user_1" as Id<"users">,
		externalMemberId: "actor_user_1" as Id<"users">,
		externalId: "page_save::billed_user_1::actor_user_1::workspace_1::project_1::page_1::1",
		metadata: {
			amount: 1,
			actorUserId: "actor_user_1" as Id<"users">,
			billedUserId: "billed_user_1" as Id<"users">,
			workspaceId: "workspace_1",
			projectId: "project_1",
			pageId: "page_1",
			yjsSequence: "1",
		},
	});

	expectTypeOf(pageSaveEvent.name).toEqualTypeOf<"page_save">();
	expectTypeOf(pageSaveEvent.externalCustomerId).toEqualTypeOf<Id<"users">>();
	expectTypeOf(pageSaveEvent.externalMemberId).toEqualTypeOf<Id<"users">>();
	expectTypeOf(pageSaveEvent.externalId).toBeString();
	expectTypeOf(pageSaveEvent.metadata.actorUserId).toEqualTypeOf<Id<"users">>();
	expectTypeOf(pageSaveEvent.metadata.billedUserId).toEqualTypeOf<Id<"users">>();
	expectTypeOf(pageSaveEvent.metadata.workspaceId).toBeString();
	expectTypeOf(pageSaveEvent.metadata.projectId).toBeString();
	expectTypeOf(pageSaveEvent.metadata.pageId).toBeString();
	expectTypeOf(pageSaveEvent.metadata.yjsSequence).toBeString();
});
