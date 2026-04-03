import "./my-vertical-tabs.css";

import { memo, type ComponentPropsWithRef, type ReactNode, type Ref } from "react";
import * as Ariakit from "@ariakit/react";

import { cn } from "@/lib/utils.ts";

// #region tab
export type MyVerticalTabsTab_ClassNames = "MyVerticalTabsTab";

export type MyVerticalTabsTab_Props = Ariakit.TabProps;

export const MyVerticalTabsTab = memo(function MyVerticalTabsTab(props: MyVerticalTabsTab_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<Ariakit.Tab
			ref={ref}
			id={id}
			className={cn("MyVerticalTabsTab" satisfies MyVerticalTabsTab_ClassNames, className)}
			{...rest}
		>
			{children}
		</Ariakit.Tab>
	);
});
// #endregion tab

// #region panel
export type MyVerticalTabsPanel_ClassNames = "MyVerticalTabsPanel";

export type MyVerticalTabsPanel_Props = Ariakit.TabPanelProps;

export const MyVerticalTabsPanel = memo(function MyVerticalTabsPanel(props: MyVerticalTabsPanel_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<Ariakit.TabPanel
			ref={ref}
			id={id}
			className={cn("MyVerticalTabsPanel" satisfies MyVerticalTabsPanel_ClassNames, className)}
			{...rest}
		>
			{children}
		</Ariakit.TabPanel>
	);
});
// #endregion panel

// #region list
export type MyVerticalTabsList_ClassNames = "MyVerticalTabsList";

export type MyVerticalTabsList_Props = Ariakit.TabListProps;

export const MyVerticalTabsList = memo(function MyVerticalTabsList(props: MyVerticalTabsList_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<Ariakit.TabList
			ref={ref}
			id={id}
			className={cn("MyVerticalTabsList" satisfies MyVerticalTabsList_ClassNames, className)}
			{...rest}
		>
			{children}
		</Ariakit.TabList>
	);
});
// #endregion list

// #region panels
export type MyVerticalTabsPanels_ClassNames = "MyVerticalTabsPanels";

export type MyVerticalTabsPanels_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
	children?: ReactNode;
};

export const MyVerticalTabsPanels = memo(function MyVerticalTabsPanels(props: MyVerticalTabsPanels_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div
			ref={ref}
			id={id}
			className={cn("MyVerticalTabsPanels" satisfies MyVerticalTabsPanels_ClassNames, className)}
			{...rest}
		>
			{children}
		</div>
	);
});
// #endregion panels

// #region root
export type MyVerticalTabs_Props = Ariakit.TabProviderProps;

export const MyVerticalTabs = memo(function MyVerticalTabs(props: MyVerticalTabs_Props) {
	const { children, orientation = "vertical", ...rest } = props;

	return (
		<Ariakit.TabProvider orientation={orientation} {...rest}>
			{children}
		</Ariakit.TabProvider>
	);
});
// #endregion root
