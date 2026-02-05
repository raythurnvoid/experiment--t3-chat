import "./my-interactive-list.css";

import type { ComponentPropsWithRef } from "react";

import { cn } from "@/lib/utils.ts";

// #region list
type MyInteractiveList_ClassNames = "MyInteractiveList";

export type MyInteractiveList_Props = ComponentPropsWithRef<"ul">;

export function MyInteractiveList(props: MyInteractiveList_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<ul
			ref={ref}
			id={id}
			className={cn("MyInteractiveList" satisfies MyInteractiveList_ClassNames, className)}
			{...rest}
		>
			{children}
		</ul>
	);
}
// #endregion list

// #region item
type MyInteractiveListItem_ClassNames = "MyInteractiveListItem";

export type MyInteractiveListItem_Props = ComponentPropsWithRef<"li">;

export function MyInteractiveListItem(props: MyInteractiveListItem_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<li
			ref={ref}
			id={id}
			className={cn("MyInteractiveListItem" satisfies MyInteractiveListItem_ClassNames, className)}
			{...rest}
		>
			{children}
		</li>
	);
}
// #endregion item
