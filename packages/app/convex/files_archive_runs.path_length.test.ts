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
} from "./files_archive_runs.setup.test.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";

// Scheduled steps never run on their own under fake timers. Each test drives the op's steps itself.
beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// Three folder names of 255 characters. `/p` and these make a path of 770 characters.
const NAMES = [..."abc"].map((letter) => letter.repeat(255));

async function find_node(f: Fixture, path: string) {
	const nodes = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
	const node = nodes.find((fileNode) => fileNode.path === path);
	if (!node) throw new Error(`Missing node ${path}`);
	return node;
}

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
		// 1,030 characters, like a path stored before the limit.
		await rename_directly(f, { path: "/p", name: "pppppppppp", isWholeTree: true });
		const top = await find_node(f, `/pppppppppp/${NAMES[0]}`);
		const deepest = await find_node(f, `/pppppppppp/${chain}`);
		expect(deepest.path.length).toBe(1030);
		expect(await archive(f, [top._id])).toEqual({ _yay: null });
		await rename_directly(f, { path: "/pppppppppp", name: "ppppppp" });

		expect(await restore(f, [top._id])).toEqual({ _yay: null });
		expect(await read_node(f, deepest._id), "the deepest folder is back, 3 characters shorter").toMatchObject({
			archiveOperationId: null,
			path: `/ppppppp/${chain}`,
		});
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

	test("an item whose path gets too long after the check stays archived, and the job says so", async () => {
		const f = await fixture();
		const deepestPath = `/p/${NAMES.join("/")}/${"d".repeat(250)}`;
		await folder(f, deepestPath);
		const top = await find_node(f, `/p/${NAMES[0]}`);
		const deepest = await find_node(f, deepestPath);
		// `/first` is in the same operation and comes first. Its clash pauses the job after the check.
		const first = await folder(f, "/first");
		expect(await archive(f, [first, top._id])).toEqual({ _yay: null });
		await folder(f, "/first");
		const job = (await restore(f, [top._id]))._yay!;
		expect((await read_activity(f, job.activityId)).status).toBe("awaiting_input");
		await rename_directly(f, { path: "/p", name: "pppppppp" });

		expect(await resolve(f, job.runId, "skip")).toEqual({ _yay: null });
		const ended = await run_to_end(f, job);
		expect(ended.activity).toMatchObject({
			status: "succeeded",
			progress: { completed: 3, skipped: 2 },
			errorMessage: `1 item would have a path over 1,024 characters: …/${"d".repeat(250)} (1,028), so it stayed archived. Shorten a folder name, then restore it again.`,
		});
		const run = (await f.t.run((ctx) => ctx.db.get("files_archive_runs", job.runId)))!;
		expect((await read_node(f, deepest._id)).archiveOperationId, "the deepest folder stays archived").toBe(
			run.skipOperationId,
		);
	});

	test("a child archived on its own follows its restored folder over 1,024 characters and comes back later", async () => {
		const f = await fixture();
		const deepestPath = `/p/${NAMES.join("/")}/${"d".repeat(250)}`;
		const deepestId = await folder(f, deepestPath);
		const top = await find_node(f, `/p/${NAMES[0]}`);
		expect(await archive(f, [deepestId])).toEqual({ _yay: null });
		expect(await archive(f, [top._id])).toEqual({ _yay: null });
		await rename_directly(f, { path: "/p", name: "pppppppp" });

		expect(await restore(f, [top._id])).toEqual({ _yay: null });
		const followed = await read_node(f, deepestId);
		expect(followed.archiveOperationId, "the child stays archived").not.toBeNull();
		expect(followed.path.length).toBe(1028);

		expect(await restore(f, [deepestId])).toEqual({ _yay: null });
		expect(await read_node(f, deepestId), "the child is back where it was").toMatchObject({
			archiveOperationId: null,
			path: followed.path,
		});
	});
});
