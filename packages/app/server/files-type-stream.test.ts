import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "../convex/_generated/api.js";
import { test_create_saved_placement_fixture } from "./files-saved-placement.test-fixtures.ts";
import { files_saved_placement_db_get_view } from "./files-saved-placement.ts";
import * as typeStream from "./files-type-stream.ts";
import {
	files_type_query_db_consume,
	files_type_query_db_fill_stream,
	files_type_query_db_open_stream,
} from "./files-type-query.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("type-stream-test-work" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

test.each(["to_selected", "to_normal"] as const)(
	"keeps every MIME candidate when sources migrate %s between native pages",
	async (direction) => {
		const paths = Array.from({ length: 41 }, (_, index) => `/typed/${String(index).padStart(2, "0")}.txt`);
		const f = await test_create_saved_placement_fixture({ normalPaths: paths });
		const selected = paths.filter((_, index) => index % 2 === 0);
		for (const path of selected) await f.stageNode(f.normalNodes.get(path)!);
		if (direction === "to_normal") await f.publish();
		const started = await f.t.mutation(internal.files_type_queries.begin, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			overlay: false,
			rootPath: "/typed",
			contentType: "text/",
			directoriesOnly: false,
			limit: 50,
		});
		if (started._nay) throw new Error(started._nay.message);
		const queryId = started._yay.queryId;
		const streamId = await f.t.run((ctx) =>
			files_type_query_db_open_stream(ctx.db, {
				queryId,
				kind: "saved",
				moveTargetId: null,
				savedPrefix: "/typed/",
				ownerPrefix: "/typed/",
			}),
		);
		const fill = () =>
			f.t.run(async (ctx) => {
				const query = (await ctx.db.get("files_type_queries", queryId))!;
				const stream = (await ctx.db.get("files_type_query_streams", streamId))!;
				await files_type_query_db_fill_stream(
					ctx.db,
					query,
					stream,
					await files_saved_placement_db_get_view(ctx.db, query),
				);
			});
		await fill();
		expect(await f.t.run((ctx) => ctx.db.get("files_type_query_streams", streamId))).toMatchObject({ readSource: 1 });
		// Move docs after reading the source they are leaving, before reading their destination.
		if (direction === "to_normal") {
			for (const path of selected) await f.materializeNode(f.normalNodes.get(path)!);
		} else {
			for (const path of paths.filter((_, index) => index % 2 !== 0)) await f.stageNode(f.normalNodes.get(path)!);
		}
		const found: string[] = [];
		let done = false;
		for (let step = 0; step < 500; step++) {
			const stream = (await f.t.run((ctx) => ctx.db.get("files_type_query_streams", streamId)))!;
			if (stream.done) {
				done = true;
				break;
			}
			if (stream.buffer.length === 0) await fill();
			else {
				found.push(stream.buffer[0]!.key.path);
				await f.t.run((ctx) => files_type_query_db_consume(ctx.db, stream));
			}
		}
		expect(done).toBe(true);
		expect(found).toEqual(paths);
	},
);

test("keeps an empty native page cursor until its source has results", async () => {
	const f = await test_create_saved_placement_fixture({ normalPaths: ["/typed/a.txt"] });
	const started = await f.t.mutation(internal.files_type_queries.begin, {
		organizationId: f.db.organizationId,
		workspaceId: f.db.workspaceId,
		userId: f.db.userId,
		overlay: false,
		rootPath: "/typed",
		contentType: "text/",
		directoriesOnly: false,
		limit: 50,
	});
	if (started._nay) throw new Error(started._nay.message);
	const queryId = started._yay.queryId;
	const streamId = await f.t.run((ctx) =>
		files_type_query_db_open_stream(ctx.db, {
			queryId,
			kind: "saved",
			moveTargetId: null,
			savedPrefix: "/typed/",
			ownerPrefix: "/typed/",
		}),
	);
	const nativePage = typeStream.files_type_stream_db_page;
	const page = vi
		.spyOn(typeStream, "files_type_stream_db_page")
		.mockResolvedValueOnce({ items: [], frontier: null, done: false, nextPhase: 0, cursor: "empty-native-page" })
		.mockImplementationOnce(async (db, args) => {
			expect(args.stream.readCursor).toBe("empty-native-page");
			return nativePage(db, { ...args, stream: { ...args.stream, readCursor: null } });
		});
	const fill = () =>
		f.t.run(async (ctx) => {
			const query = (await ctx.db.get("files_type_queries", queryId))!;
			const stream = (await ctx.db.get("files_type_query_streams", streamId))!;
			await files_type_query_db_fill_stream(
				ctx.db,
				query,
				stream,
				await files_saved_placement_db_get_view(ctx.db, query),
			);
		});
	await fill();
	expect(await f.t.run((ctx) => ctx.db.get("files_type_query_streams", streamId))).toMatchObject({
		readSource: 0,
		readCursor: "empty-native-page",
		done: false,
		buffer: [],
		batches: [],
	});
	await fill();
	await fill();
	expect(page).toHaveBeenCalledTimes(3);
	const stream = (await f.t.run((ctx) => ctx.db.get("files_type_query_streams", streamId)))!;
	expect(stream.buffer.map((item) => item.key.path)).toEqual(["/typed/a.txt"]);
	await f.t.run((ctx) => files_type_query_db_consume(ctx.db, stream));
	expect(await f.t.run((ctx) => ctx.db.get("files_type_query_streams", streamId))).toMatchObject({ done: true });
});
