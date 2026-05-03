import { expectTypeOf, test } from "vitest";
import type { Id } from "../convex/_generated/dataModel.js";
import { billing_event, type billing_Event } from "./billing.ts";

test("billing_Event exposes the full event name union", () => {
	expectTypeOf<billing_Event["name"]>().toEqualTypeOf<"manual_credit" | "file_save" | "monthly_credit" | "ai_usage">();
});

test("billing_Event can be discriminated by built payload name", () => {
	type FileSaveEvent = Extract<billing_Event, { name: "file_save" }>;
	type ExtractedFileSaveEvent = Extract<billing_Event, { name: "file_save" }>;

	expectTypeOf<FileSaveEvent>().toEqualTypeOf<ExtractedFileSaveEvent>();
	expectTypeOf<FileSaveEvent>().toHaveProperty("externalCustomerId");
	expectTypeOf<FileSaveEvent>().toHaveProperty("externalId");
	expectTypeOf<FileSaveEvent>().toHaveProperty("metadata");
});

test("billing_event preserves the matching source-specific payload type", () => {
	const fileSaveEvent = billing_event({
		name: "file_save",
		externalCustomerId: "billed_user_1" as Id<"users">,
		externalMemberId: "actor_user_1" as Id<"users">,
		externalId: "file_save::billed_user_1::actor_user_1::workspace_1::project_1::file_1::1",
		metadata: {
			amount: 1,
			actorUserId: "actor_user_1" as Id<"users">,
			billedUserId: "billed_user_1" as Id<"users">,
			workspaceId: "workspace_1",
			projectId: "project_1",
			nodeId: "file_1",
			yjsSequence: "1",
		},
	});

	expectTypeOf(fileSaveEvent.name).toEqualTypeOf<"file_save">();
	expectTypeOf(fileSaveEvent.externalCustomerId).toEqualTypeOf<Id<"users">>();
	expectTypeOf(fileSaveEvent.externalMemberId).toEqualTypeOf<Id<"users">>();
	expectTypeOf(fileSaveEvent.externalId).toBeString();
	expectTypeOf(fileSaveEvent.metadata.actorUserId).toEqualTypeOf<Id<"users">>();
	expectTypeOf(fileSaveEvent.metadata.billedUserId).toEqualTypeOf<Id<"users">>();
	expectTypeOf(fileSaveEvent.metadata.workspaceId).toBeString();
	expectTypeOf(fileSaveEvent.metadata.projectId).toBeString();
	expectTypeOf(fileSaveEvent.metadata.nodeId).toBeString();
	expectTypeOf(fileSaveEvent.metadata.yjsSequence).toBeString();
});
