import { expectTypeOf, test } from "vitest";
import type { Id } from "../convex/_generated/dataModel.js";
import { billing_event, type billing_Event } from "./billing.ts";

test("billing_Event exposes the full event name union", () => {
	expectTypeOf<billing_Event["name"]>().toEqualTypeOf<"page_save" | "monthly_credit" | "manual_credit">();
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
		externalCustomerId: "user_1" as Id<"users">,
		externalId: "page_save::user_1::page_1::1",
		metadata: {
			amount: 1,
			workspaceId: "workspace_1",
			projectId: "project_1",
			pageId: "page_1",
			yjsSequence: "1",
		},
	});

	expectTypeOf(pageSaveEvent.name).toEqualTypeOf<"page_save">();
	expectTypeOf(pageSaveEvent.externalCustomerId).toEqualTypeOf<Id<"users">>();
	expectTypeOf(pageSaveEvent.externalId).toBeString();
	expectTypeOf(pageSaveEvent.metadata.workspaceId).toBeString();
	expectTypeOf(pageSaveEvent.metadata.projectId).toBeString();
	expectTypeOf(pageSaveEvent.metadata.pageId).toBeString();
	expectTypeOf(pageSaveEvent.metadata.yjsSequence).toBeString();
});
