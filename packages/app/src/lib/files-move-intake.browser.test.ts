import { afterEach, describe, expect, test } from "vitest";
import type { app_convex_Id } from "./app-convex-client.ts";
import {
	files_move_intake_delete,
	files_move_intake_load,
	files_move_intake_read_page,
	files_move_intake_save,
	files_move_intake_update,
	type FilesMoveIntake,
} from "./files-move-intake.ts";

const requests: FilesMoveIntake[] = [];

function make_request(sourceCount: number): FilesMoveIntake {
	const request: FilesMoveIntake = {
		userId: crypto.randomUUID(),
		membershipId: crypto.randomUUID() as app_convex_Id<"organizations_workspaces_users">,
		requestId: crypto.randomUUID(),
		revision: crypto.randomUUID(),
		targetParentId: "root",
		sourceCount,
		runId: null,
		stopRequested: false,
	};
	requests.push(request);
	return request;
}

afterEach(async () => {
	for (const request of requests.splice(0)) await files_move_intake_delete({ ...request, stopRequested: true });
});

describe("files_move_intake", () => {
	test.each([1, 100_000])("keeps exact pages across database reopen for %s sources", async (sourceCount) => {
		const request = make_request(sourceCount);
		const sourceIds = Array.from(
			{ length: sourceCount },
			(_, index) => `source-${index}` as app_convex_Id<"files_nodes">,
		);
		await files_move_intake_save({ request, sourceIds });
		const saved = await files_move_intake_load(request);
		expect(saved).toEqual(request);
		expect(saved).not.toHaveProperty("sourceIds");
		expect(await files_move_intake_read_page({ request, offset: 0 })).toEqual(sourceIds.slice(0, 100));
		const lastOffset = Math.floor((sourceCount - 1) / 100) * 100;
		expect(await files_move_intake_read_page({ request, offset: lastOffset })).toEqual(sourceIds.slice(lastOffset));
		expect(await files_move_intake_load({ ...request, userId: "another-user" })).toBeNull();
		expect(
			await files_move_intake_load({
				...request,
				membershipId: "another-membership" as FilesMoveIntake["membershipId"],
			}),
		).toBeNull();
		await files_move_intake_update({
			...request,
			runId: "run" as app_convex_Id<"files_transfer_runs">,
			stopRequested: true,
		});
		expect(await files_move_intake_load(request)).toMatchObject({ runId: "run", stopRequested: true });
		await files_move_intake_delete({ ...request, stopRequested: true });
		expect(await files_move_intake_load(request)).toBeNull();
		await expect(files_move_intake_read_page({ request, offset: lastOffset })).rejects.toThrow("missing a page");
	});

	test("keeps the same request's Stop and pages when a stale tab finishes", async () => {
		const request = make_request(201);
		const sourceIds = Array.from({ length: 201 }, (_, index) => `source-${index}` as app_convex_Id<"files_nodes">);
		await files_move_intake_save({ request, sourceIds });
		const stopped = { ...request, runId: "run" as app_convex_Id<"files_transfer_runs">, stopRequested: true };
		await files_move_intake_update(stopped);
		await files_move_intake_update({ ...request, runId: stopped.runId });
		expect(await files_move_intake_load(request)).toEqual(stopped);

		await files_move_intake_delete(request);
		expect(await files_move_intake_load(request)).toEqual(stopped);
		expect(await files_move_intake_read_page({ request, offset: 0 })).toEqual(sourceIds.slice(0, 100));
		expect(await files_move_intake_read_page({ request, offset: 200 })).toEqual(sourceIds.slice(200));

		await files_move_intake_delete(stopped);
		expect(await files_move_intake_load(request)).toBeNull();
		await expect(files_move_intake_read_page({ request, offset: 200 })).rejects.toThrow("missing a page");
	});

	test("keeps a second tab's request when an older request finishes", async () => {
		const oldRequest = make_request(1);
		await files_move_intake_save({ request: oldRequest, sourceIds: ["old" as app_convex_Id<"files_nodes">] });
		await expect(
			files_move_intake_save({
				request: { ...oldRequest, requestId: "other" },
				sourceIds: ["other" as app_convex_Id<"files_nodes">],
			}),
		).rejects.toBeTruthy();
		await files_move_intake_delete(oldRequest);
		const newRequest = { ...oldRequest, requestId: crypto.randomUUID() };
		requests.push(newRequest);
		await files_move_intake_save({ request: newRequest, sourceIds: ["new" as app_convex_Id<"files_nodes">] });
		await files_move_intake_update({ ...oldRequest, stopRequested: true });
		await files_move_intake_delete(oldRequest);
		expect(await files_move_intake_load(newRequest)).toEqual(newRequest);
		expect(await files_move_intake_read_page({ request: newRequest, offset: 0 })).toEqual(["new"]);
	});

	test("saves a Stop-only header after another tab retired the input", async () => {
		const request = make_request(1);
		await files_move_intake_save({ request, sourceIds: ["source" as app_convex_Id<"files_nodes">] });
		await files_move_intake_delete(request);
		await files_move_intake_update({ ...request, stopRequested: true });
		expect(await files_move_intake_load(request)).toBeNull();
		const stopped = { ...request, runId: "run" as app_convex_Id<"files_transfer_runs">, stopRequested: true };
		await files_move_intake_update(stopped);
		expect(await files_move_intake_load(request), "the Stop retry survives database reopen without pages").toEqual(
			stopped,
		);
		await expect(files_move_intake_read_page({ request, offset: 0 })).rejects.toThrow("missing a page");
		await files_move_intake_delete(stopped);
		await files_move_intake_update({ ...stopped, stopRequested: false });
		expect(await files_move_intake_load(request)).toBeNull();

		const newer = { ...request, requestId: crypto.randomUUID() };
		requests.push(newer);
		await files_move_intake_save({ request: newer, sourceIds: ["newer" as app_convex_Id<"files_nodes">] });
		await files_move_intake_update(stopped);
		expect(await files_move_intake_load(newer)).toEqual(newer);
		expect(await files_move_intake_read_page({ request: newer, offset: 0 })).toEqual(["newer"]);
	});
});
