import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
	fixture,
	type Fixture,
	read_state,
	read_activity,
	run_to_end,
	archive,
	restore,
	folder,
	read_node,
	find_node,
	lock_archived,
} from "./files_archive_runs.setup.test.ts";
import { test_finish_transfer_run, test_rename_node } from "./setup.test.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { files_NAME_MAX_LENGTH } from "../shared/files.ts";

// Scheduled steps never run on their own under fake timers. Each test drives the op's steps itself.
beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// Three folder names of 255 characters. `/p` and these make a path of 770 characters.
const NAMES = [..."abc"].map((letter) => letter.repeat(files_NAME_MAX_LENGTH));

/**
 * Give the folder at `path` the name `name` and change no other node. Its archived items keep their
 * old paths, like a rename they did not follow. With `isWholeTree`, every path inside changes too,
 * like a path stored before the limit.
 */
async function rename_directly(f: Fixture, args: { path: string; name: string; isWholeTree?: boolean }) {
	const newPath = `/${args.name}`;
	await f.t.run(async (ctx) => {
		for (const node of await ctx.db.query("files_nodes").collect()) {
			const isInside = args.isWholeTree === true && node.path.startsWith(`${args.path}/`);
			if (node.path !== args.path && !isInside) continue;
			const path = `${newPath}${node.path.slice(args.path.length)}`;
			await ctx.db.patch("files_nodes", node._id, {
				...(node.path === args.path ? { name: args.name, sortName: files_sort_text_key(args.name) } : {}),
				path,
				treePath: node.kind === "folder" ? `${path}/` : path,
			});
		}
	});
}

async function resolve(f: Fixture, runId: Id<"files_archive_runs">, choice: "keep_both" | "skip") {
	const run = (await f.t.run((ctx) => ctx.db.get("files_archive_runs", runId)))!;
	return await f.asOwner.mutation(api.files_archive_runs.resolve_conflicts, {
		membershipId: f.db.membershipId,
		runId,
		revision: run.revision,
		choice,
		applyToRemaining: { file: null, folder: null },
	});
}

describe("unarchive_nodes path limit", () => {
	test("refuses a restore before any write when paths would get longer than 1,024 characters", async () => {
		const f = await fixture();
		const chain = `/p/${NAMES.join("/")}`;
		// Three folders of 1,021 to 1,023 characters. A name 7 characters longer pushes them over.
		for (const name of ["d".repeat(250), "e".repeat(251), "f".repeat(252)]) await folder(f, `${chain}/${name}`);
		const top = await find_node(f, `/p/${NAMES[0]}`);
		expect(await archive(f, [top._id])).toEqual({ _yay: null });
		await rename_directly(f, { path: "/p", name: "pppppppp" });
		const nodesBefore = (await read_state(f)).nodes;

		expect(await restore(f, [top._id])).toEqual({
			_nay: {
				name: "path_too_long",
				message: `Can't restore. 3 items would have paths over 1,024 characters, like …/${"f".repeat(252)} (1,030). Shorten a folder name, then restore again.`,
			},
		});
		expect((await read_state(f)).nodes, "nodes after the refused restore").toEqual(nodesBefore);
	});

	test("a restore job that would make a path too long fails with the same message and writes nothing", async () => {
		const f = await fixture();
		await folder(f, `/p/${NAMES.join("/")}/${"d".repeat(250)}`);
		const top = await find_node(f, `/p/${NAMES[0]}`);
		// `/first` comes first in the request and waits on a name clash, so the second job runs in the background.
		const first = await folder(f, "/first");
		expect(await archive(f, [first])).toEqual({ _yay: null });
		expect(await archive(f, [top._id])).toEqual({ _yay: null });
		await folder(f, "/first");
		await rename_directly(f, { path: "/p", name: "pppppppp" });

		const firstJob = (await restore(f, [first, top._id]))._yay!;
		expect(await resolve(f, firstJob.runId, "skip")).toEqual({ _yay: null });
		await run_to_end(f, firstJob);
		const secondRun = (await f.t.run((ctx) => ctx.db.query("files_archive_runs").collect())).find(
			(run) => run._id !== firstJob.runId,
		)!;
		const activity = (await f.t.run((ctx) => ctx.db.query("activities").collect())).find(
			(item) => item.source.kind === "files_archive_run" && item.source.id === secondRun._id,
		)!;
		const nodesBefore = (await read_state(f)).nodes;

		const ended = await run_to_end(f, { runId: secondRun._id, activityId: activity._id });
		expect(ended.activity).toMatchObject({
			status: "failed",
			errorMessage: `Can't restore. 1 item would have a path over 1,024 characters: …/${"d".repeat(250)} (1,028). Shorten a folder name, then restore again.`,
		});
		expect((await read_state(f)).nodes, "nodes after the refused restore").toEqual(nodesBefore);
	});

	test("restores a path over 1,024 characters that gets shorter", async () => {
		const f = await fixture();
		const chain = `${NAMES.join("/")}/${"d".repeat(250)}`;
		await folder(f, `/p/${chain}`);
		// Assume this path was stored before the normal limit. Its first Archive must keep its length.
		await rename_directly(f, { path: "/p", name: "pppppppppp", isWholeTree: true });
		const top = await find_node(f, `/pppppppppp/${NAMES[0]}`);
		const deepest = await find_node(f, `/pppppppppp/${chain}`);
		expect(deepest.path.length).toBe(1030);
		expect(await archive(f, [top._id])).toEqual({ _yay: null });
		expect((await read_node(f, top._id)).archivedPathLength, "ordinary paths need no stored allowance").toBeUndefined();
		expect((await read_node(f, deepest._id)).archivedPathLength, "first Archive keeps the historical path length").toBe(
			1030,
		);
		await rename_directly(f, { path: "/pppppppppp", name: "ppppppp" });
		expect(
			(await read_node(f, deepest._id)).archivedPathLength,
			"the archived allowance does not follow a rename",
		).toBe(1030);

		expect(await restore(f, [top._id])).toEqual({ _yay: null });
		expect(await read_node(f, deepest._id), "the deepest folder is back, 3 characters shorter").toMatchObject({
			archiveOperationId: null,
			path: `/ppppppp/${chain}`,
		});
		expect(
			(await read_node(f, deepest._id)).archivedPathLength,
			"Restore clears the historical allowance",
		).toBeUndefined();
		const parent = await find_node(f, "/ppppppp");
		expect(
			(await test_rename_node(f.t, f.asOwner, { membershipId: f.db.membershipId, nodeId: parent._id, path: "p" }))._nay,
		).toBeUndefined();
		expect((await read_node(f, deepest._id)).path).toBe(`/p/${chain}`);
		expect(await archive(f, [top._id])).toEqual({ _yay: null });
		expect(
			(await read_node(f, deepest._id)).archivedPathLength,
			"a new Archive does not reuse the old allowance",
		).toBeUndefined();
	});

	test("Keep both of a folder cuts the name, so the paths inside stay within 1,024 characters", async () => {
		const f = await fixture();
		// The deepest path has 1,023 characters, so the folder name may grow by one character.
		const deepestPath = `/p/${"x".repeat(10)}/${NAMES.join("/")}/${"d".repeat(241)}`;
		await folder(f, deepestPath);
		const top = await find_node(f, `/p/${"x".repeat(10)}`);
		expect(await archive(f, [top._id])).toEqual({ _yay: null });
		await folder(f, `/p/${"x".repeat(10)}`);

		const job = (await restore(f, [top._id]))._yay!;
		expect(await resolve(f, job.runId, "keep_both")).toEqual({ _yay: null });
		expect((await run_to_end(f, job)).activity.status).toBe("succeeded");
		expect((await read_node(f, top._id)).name, "the cut Keep both name").toBe(`${"x".repeat(9)}-2`);
		const deepest = await find_node(f, `/p/${"x".repeat(9)}-2/${NAMES.join("/")}/${"d".repeat(241)}`);
		expect(deepest).toMatchObject({ archiveOperationId: null });
		expect(deepest.path.length).toBe(1024);
	});

	test("Keep both asks again when no new folder name keeps the paths within 1,024 characters", async () => {
		const f = await fixture();
		// The deepest path has 1,024 characters already, so `xx` cannot get a counter.
		await folder(f, `/p/xx/${NAMES.join("/")}/${"d".repeat(250)}`);
		const top = await find_node(f, "/p/xx");
		expect(await archive(f, [top._id])).toEqual({ _yay: null });
		await folder(f, "/p/xx");

		const job = (await restore(f, [top._id]))._yay!;
		expect(await resolve(f, job.runId, "keep_both")).toEqual({ _yay: null });
		expect((await run_to_end(f, job)).activity.status, "the job asks again").toBe("awaiting_input");
		const shown = await f.asOwner.query(api.files_archive_runs.get, {
			membershipId: f.db.membershipId,
			runId: job.runId,
		});
		expect(shown?.conflict).toMatchObject({ canKeepBoth: false });
		expect((await read_node(f, top._id)).archiveOperationId).not.toBeNull();
	});

	test("Keep both of a folder is cut only by the paths inside that folder", async () => {
		const f = await fixture();
		// Another item of the same job has a path of 1,024 characters. `/notes` has nothing inside.
		await folder(f, `/p/${NAMES.join("/")}/${"d".repeat(253)}`);
		const deepTop = await find_node(f, `/p/${NAMES[0]}`);
		const notes = await folder(f, "/notes");
		expect(await archive(f, [deepTop._id, notes])).toEqual({ _yay: null });
		await folder(f, "/notes");

		const job = (await restore(f, [notes]))._yay!;
		expect(await resolve(f, job.runId, "keep_both")).toEqual({ _yay: null });
		expect((await run_to_end(f, job)).activity.status).toBe("succeeded");
		expect((await read_node(f, notes)).name, "the Keep both name is not cut").toBe("notes-2");
	});

	/**
	 * Archive `/first` and `/p/<NAMES>/<d * 250>` (1,021 characters) with a short folder `e` next to it
	 * as one operation, and put a new
	 * `/first` in the way. The restore checks, then waits on the `/first` clash. Then `/p` gets a name 7
	 * characters longer, like a rename that ran while the job waited.
	 */
	async function seed_late_long_path(f: Fixture) {
		const deepestPath = `/p/${NAMES.join("/")}/${"d".repeat(250)}`;
		await folder(f, deepestPath);
		const top = await find_node(f, `/p/${NAMES[0]}`);
		const deepest = await find_node(f, deepestPath);
		const short = await folder(f, `/p/${NAMES.join("/")}/e`);
		// `/first` is in the same operation and comes first. Its clash pauses the job after the check.
		const first = await folder(f, "/first");
		expect(await archive(f, [first, top._id])).toEqual({ _yay: null });
		await folder(f, "/first");
		const job = (await restore(f, [top._id]))._yay!;
		expect((await read_activity(f, job.activityId)).status).toBe("awaiting_input");
		await rename_directly(f, { path: "/p", name: "pppppppp" });
		return { first, deepest, short, job };
	}

	test("an item whose path gets too long after the check stays archived on its own, and the job is partly done", async () => {
		const f = await fixture();
		const { first, deepest, job } = await seed_late_long_path(f);

		expect(await resolve(f, job.runId, "skip")).toEqual({ _yay: null });
		const ended = await run_to_end(f, job);
		expect(ended.activity).toMatchObject({
			status: "partial",
			progress: { completed: 4, skipped: 2 },
			errorMessage: `1 item stayed archived because its path would be too long: …/${"d".repeat(250)} (1,028 characters). Shorten a folder name, then restore it again.`,
		});
		const run = (await f.t.run((ctx) => ctx.db.get("files_archive_runs", job.runId)))!;
		expect((await read_node(f, deepest._id)).archiveOperationId, "the deepest folder stays archived").toBe(
			run.longPathOperationId,
		);
		expect(run.longPathOperationId).not.toBe(run.skipOperationId);

		// With a shorter folder name it comes back alone. The skipped `/first` does not ask again.
		await rename_directly(f, { path: "/pppppppp", name: "p", isWholeTree: true });
		expect(await restore(f, [deepest._id]), "the restore of the deepest folder alone").toEqual({ _yay: null });
		expect((await read_node(f, deepest._id)).archiveOperationId).toBeNull();
		expect((await read_node(f, first)).archiveOperationId).toBe(run.skipOperationId);
	});

	test("a job that fails after an item stayed archived for its path still says so", async () => {
		const f = await fixture();
		const { short, job } = await seed_late_long_path(f);
		// `e` comes after the deepest folder. It becomes read-only after the check, so it stops the job.
		await lock_archived(f, short);

		expect(await resolve(f, job.runId, "skip")).toEqual({ _yay: null });
		const ended = await run_to_end(f, job);
		expect(ended.activity.status).toBe("failed");
		expect(ended.activity.errorMessage).toMatch(
			/^Stopped partway: .+ 1 item stayed archived because its path would be too long: …\/d+ \(1,028 characters\)\. Shorten a folder name, then restore it again\.$/,
		);
	});

	test("a child archived on its own that followed its folder past 1,024 characters cannot come back longer", async () => {
		const f = await fixture();
		const chain = `${NAMES.join("/")}/${"d".repeat(250)}`;
		// 1,023 characters.
		const deepestId = await folder(f, `/p/x/${chain}`);
		const top = await find_node(f, "/p/x");
		expect(await archive(f, [deepestId])).toEqual({ _yay: null });
		expect(
			(await read_node(f, deepestId)).archivedPathLength,
			"Archive within the limit stores no allowance",
		).toBeUndefined();
		expect(await archive(f, [top._id])).toEqual({ _yay: null });
		await folder(f, "/p/x");
		const job = (await restore(f, [top._id]))._yay!;
		expect(await resolve(f, job.runId, "keep_both")).toEqual({ _yay: null });
		expect((await run_to_end(f, job)).activity.status).toBe("succeeded");
		const followed = await read_node(f, deepestId);
		expect(followed.archiveOperationId, "the child stays archived").not.toBeNull();
		expect(followed.path, "the child follows its folder to 1,025 characters").toBe(`/p/x-2/${chain}`);

		expect(await restore(f, [deepestId]), "the child cannot come back 2 characters longer").toEqual({
			_nay: {
				name: "path_too_long",
				message: `Can't restore. 1 item would have a path over 1,024 characters: …/${"d".repeat(250)} (1,025). Shorten a folder name, then restore again.`,
			},
		});
		// A real Rename makes the folder shorter. The child follows and can come back.
		expect(
			(await test_rename_node(f.t, f.asOwner, { membershipId: f.db.membershipId, nodeId: top._id, path: "y" }))._nay,
		).toBeUndefined();
		expect(await restore(f, [deepestId])).toEqual({ _yay: null });
		expect(await read_node(f, deepestId)).toMatchObject({ archiveOperationId: null, path: `/p/y/${chain}` });
		expect(
			(await read_node(f, deepestId)).archivedPathLength,
			"an active restored child has no allowance",
		).toBeUndefined();
	});

	test("a Move replacement cannot restore its archived child past the normal path limit", async () => {
		const f = await fixture();
		const create_folder = async (parentId: Id<"files_nodes"> | "root", name: string) => {
			const created = await f.asOwner.mutation(api.files_nodes.create_folder_node, {
				membershipId: f.db.membershipId,
				parentId,
				path: name,
			});
			if (created._nay) throw new Error(created._nay.message);
			return created._yay.nodeId;
		};
		const parentId = await create_folder("root", "p");
		const topId = await create_folder(parentId, "x");
		let targetParentId = topId;
		for (const name of NAMES) targetParentId = await create_folder(targetParentId, name);
		const name = "d".repeat(250);
		const chain = `${NAMES.join("/")}/${name}`;
		const childId = await create_folder(targetParentId, name);
		expect((await read_node(f, childId)).path.length).toBe(1023);
		const incomingId = await create_folder("root", name);
		const move_incoming = async (targetParentId: Id<"files_nodes"> | "root") => {
			const started = await f.asOwner.mutation(api.files_transfer.start, {
				membershipId: f.db.membershipId,
				requestId: crypto.randomUUID(),
				kind: "move",
				sourceIds: [incomingId],
				expectedSourceCount: 1,
				targetParentId,
			});
			if (started._nay) throw new Error(started._nay.message);
			expect(
				await f.asOwner.mutation(api.files_transfer.seal, {
					membershipId: f.db.membershipId,
					runId: started._yay.runId,
				}),
			).toEqual({ _yay: null });
			await test_finish_transfer_run(f.asOwner, started._yay.runId);
			return started._yay;
		};
		const move = await move_incoming(targetParentId);
		expect((await f.t.run((ctx) => ctx.db.get("activities", move.activityId)))?.status).toBe("awaiting_input");
		const page = await f.asOwner.query(api.files_transfer.list_items, {
			membershipId: f.db.membershipId,
			runId: move.runId,
			state: "conflict",
			paginationOpts: { cursor: null, numItems: 16 },
		});
		expect(page?.page).toHaveLength(1);
		const item = page!.page[0]!;
		const run = (await f.t.run((ctx) => ctx.db.get("files_transfer_runs", move.runId)))!;
		expect(
			await f.asOwner.mutation(api.files_transfer.resolve_conflicts, {
				membershipId: f.db.membershipId,
				runId: move.runId,
				revision: run.revision,
				choices: [
					{
						itemId: item.itemId,
						choice: "replace",
						reviewedTarget: item.conflict!.target!,
						reviewedVersion: item.conflict!.version,
					},
				],
				applyToRemaining: { file: null, folder: null },
			}),
		).toEqual({ _yay: null });
		await test_finish_transfer_run(f.asOwner, move.runId);
		expect((await f.t.run((ctx) => ctx.db.get("activities", move.activityId)))?.status).toBe("succeeded");
		const archived = await read_node(f, childId);
		expect(archived).toMatchObject({ _id: childId, path: `/p/x/${chain}` });
		expect(archived.archiveOperationId).not.toBeNull();
		expect(archived.archivedPathLength, "Move Replace within the limit stores no allowance").toBeUndefined();
		expect(await read_node(f, incomingId)).toMatchObject({
			_id: incomingId,
			path: archived.path,
			archiveOperationId: null,
		});
		const movedOut = await move_incoming("root");
		expect((await f.t.run((ctx) => ctx.db.get("activities", movedOut.activityId)))?.status).toBe("succeeded");
		expect(await read_node(f, incomingId)).toMatchObject({
			_id: incomingId,
			path: `/${name}`,
			archiveOperationId: null,
		});

		expect(await archive(f, [topId])).toEqual({ _yay: null });
		await create_folder(parentId, "x");
		const job = (await restore(f, [topId]))._yay!;
		expect(await resolve(f, job.runId, "keep_both")).toEqual({ _yay: null });
		expect((await run_to_end(f, job)).activity.status).toBe("succeeded");
		const followed = await read_node(f, childId);
		expect(followed).toMatchObject({
			_id: childId,
			path: `/p/x-2/${chain}`,
			archiveOperationId: archived.archiveOperationId,
		});
		expect(followed.path.length).toBe(1025);
		expect(followed.archivedPathLength, "parent Restore preserves the child's missing allowance").toBeUndefined();
		const stateBefore = await read_state(f);
		expect(await restore(f, [childId]), "Restore refuses the archived child's growth beyond the normal limit").toEqual({
			_nay: {
				name: "path_too_long",
				message: `Can't restore. 1 item would have a path over 1,024 characters: …/${name} (1,025). Shorten a folder name, then restore again.`,
			},
		});
		expect(await read_state(f), "early Restore refusal leaves the full stored file state unchanged").toEqual(
			stateBefore,
		);
	});
});
