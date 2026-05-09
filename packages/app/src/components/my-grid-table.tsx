import "./my-grid-table.css";
import { memo, type ComponentPropsWithRef, type ReactNode, type Ref } from "react";

import { cn } from "@/lib/utils.ts";

type MyGridTable_DivProps = Omit<ComponentPropsWithRef<"div">, "role"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
	children?: ReactNode;
};

// #region root
export type MyGridTable_ClassNames = "MyGridTable";

export type MyGridTable_Props = MyGridTable_DivProps;

/**
 * Build a table-shaped accessibility tree on top of CSS grid.
 *
 * Keep column sizing in consumer CSS via `grid-template-columns`; this primitive
 * intentionally does not expose layout props so each table can own its template.
 */
export const MyGridTable = memo(function MyGridTable(props: MyGridTable_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div
			ref={ref}
			id={id}
			className={cn("MyGridTable" satisfies MyGridTable_ClassNames, className)}
			{...rest}
			role="table"
		>
			{children}
		</div>
	);
});
// #endregion root

// #region header
export type MyGridTableHeader_ClassNames = "MyGridTableHeader";

export type MyGridTableHeader_Props = MyGridTable_DivProps;

export const MyGridTableHeader = memo(function MyGridTableHeader(props: MyGridTableHeader_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div
			ref={ref}
			id={id}
			className={cn("MyGridTableHeader" satisfies MyGridTableHeader_ClassNames, className)}
			{...rest}
			role="rowgroup"
		>
			{children}
		</div>
	);
});
// #endregion header

// #region body
export type MyGridTableBody_ClassNames = "MyGridTableBody";

export type MyGridTableBody_Props = MyGridTable_DivProps;

export const MyGridTableBody = memo(function MyGridTableBody(props: MyGridTableBody_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div
			ref={ref}
			id={id}
			className={cn("MyGridTableBody" satisfies MyGridTableBody_ClassNames, className)}
			{...rest}
			role="rowgroup"
		>
			{children}
		</div>
	);
});
// #endregion body

// #region row
export type MyGridTableRow_ClassNames = "MyGridTableRow";

export type MyGridTableRow_Props = MyGridTable_DivProps;

export const MyGridTableRow = memo(function MyGridTableRow(props: MyGridTableRow_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div
			ref={ref}
			id={id}
			className={cn("MyGridTableRow" satisfies MyGridTableRow_ClassNames, className)}
			{...rest}
			role="row"
		>
			{children}
		</div>
	);
});
// #endregion row

// #region column header
export type MyGridTableColumnHeader_ClassNames = "MyGridTableColumnHeader";

export type MyGridTableColumnHeader_Props = MyGridTable_DivProps;

export const MyGridTableColumnHeader = memo(function MyGridTableColumnHeader(
	props: MyGridTableColumnHeader_Props,
) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div
			ref={ref}
			id={id}
			className={cn("MyGridTableColumnHeader" satisfies MyGridTableColumnHeader_ClassNames, className)}
			{...rest}
			role="columnheader"
		>
			{children}
		</div>
	);
});
// #endregion column header

// #region cell
export type MyGridTableCell_ClassNames = "MyGridTableCell";

export type MyGridTableCell_Props = MyGridTable_DivProps;

export const MyGridTableCell = memo(function MyGridTableCell(props: MyGridTableCell_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div
			ref={ref}
			id={id}
			className={cn("MyGridTableCell" satisfies MyGridTableCell_ClassNames, className)}
			{...rest}
			role="cell"
		>
			{children}
		</div>
	);
});
// #endregion cell
