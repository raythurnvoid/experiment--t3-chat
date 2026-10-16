import { describe, expect, test, vi } from "vitest";
import {
	files_visible_resolve_machine_create,
	type files_visible_resolve_Effect,
} from "./files-visible-resolve-machine.ts";

describe("files_visible_resolve_machine_create", () => {
	test.each([
		{
			name: "forbidden pagination does not report a page",
			effects: [true],
			steps: 10,
			readLimit: 10,
			allowPagination: false,
			status: "unfinished",
			reads: 0,
			paginated: false,
		},
		{
			name: "completion reports the page it read",
			effects: [true],
			steps: 10,
			readLimit: 10,
			allowPagination: true,
			status: "complete",
			reads: 1,
			paginated: true,
		},
		{
			name: "a step stop before pagination does not report a page",
			effects: [false, true],
			steps: 1,
			readLimit: 10,
			allowPagination: true,
			status: "unfinished",
			reads: 1,
			paginated: false,
		},
		{
			name: "a read stop before pagination does not report a page",
			effects: [false, true],
			steps: 10,
			readLimit: 1,
			allowPagination: true,
			status: "unfinished",
			reads: 1,
			paginated: false,
		},
		{
			name: "unfinished work reports the page it read",
			effects: [true, false],
			steps: 1,
			readLimit: 10,
			allowPagination: true,
			status: "unfinished",
			reads: 1,
			paginated: true,
		},
		{
			name: "a second page waits for another run",
			effects: [true, true],
			steps: 10,
			readLimit: 10,
			allowPagination: true,
			status: "unfinished",
			reads: 1,
			paginated: true,
		},
	])("$name", async ({ effects, steps, readLimit, allowPagination, status, reads, paginated }) => {
		const read = vi.fn(async () => null);
		const machine = files_visible_resolve_machine_create<string>({
			program: function* (): Generator<files_visible_resolve_Effect<string>, string, unknown> {
				for (const paginated of effects) yield { kind: "read", run: read, paginated };
				return "resolved";
			},
		});
		const result = await machine.run({ operation: "target", fence: "same-view", steps, readLimit, allowPagination });
		expect(result, "Only an executed page sets the pagination flag").toMatchObject({ status, reads, paginated });
		expect(read).toHaveBeenCalledTimes(reads);
	});

	test("a completed replay does not report or repeat its old page", async () => {
		const read = vi.fn(async () => null);
		const machine = files_visible_resolve_machine_create<string>({
			program: function* (): Generator<files_visible_resolve_Effect<string>, string, unknown> {
				yield { kind: "read", run: read, paginated: true };
				return "resolved";
			},
		});
		const input = { operation: "target", fence: "same-view", steps: 10, readLimit: 10 };
		expect(await machine.run(input)).toEqual({ status: "complete", value: "resolved", reads: 1, paginated: true });
		expect(await machine.run(input), "A completed replay did not read a new page").toEqual({
			status: "complete",
			value: "resolved",
			reads: 0,
			paginated: false,
		});
		expect(read).toHaveBeenCalledTimes(1);
	});
});
