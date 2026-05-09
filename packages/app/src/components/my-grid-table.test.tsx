import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import {
	MyGridTable,
	MyGridTableBody,
	MyGridTableCell,
	MyGridTableColumnHeader,
	MyGridTableHeader,
	MyGridTableRow,
} from "./my-grid-table.tsx";

describe("MyGridTable", () => {
	afterEach(() => {
		cleanup();
	});

	test("renders table roles for grid-backed primitives", () => {
		render(
			<MyGridTable aria-label="Files">
				<MyGridTableHeader>
					<MyGridTableRow>
						<MyGridTableColumnHeader>Name</MyGridTableColumnHeader>
					</MyGridTableRow>
				</MyGridTableHeader>
				<MyGridTableBody>
					<MyGridTableRow>
						<MyGridTableCell>README.md</MyGridTableCell>
					</MyGridTableRow>
				</MyGridTableBody>
			</MyGridTable>,
		);

		const table = screen.getByRole("table", { name: "Files" });

		expect(within(table).getAllByRole("rowgroup")).toHaveLength(2);
		expect(within(table).getAllByRole("row")).toHaveLength(2);
		expect(within(table).getByRole("columnheader", { name: "Name" })).not.toBeNull();
		expect(within(table).getByRole("cell", { name: "README.md" })).not.toBeNull();
	});
});
