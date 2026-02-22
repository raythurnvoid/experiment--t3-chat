import "./my-tabs.css";
import { memo, type ComponentPropsWithRef, type ReactNode, type Ref } from "react";
import * as Ariakit from "@ariakit/react";
import { cn } from "@/lib/utils.ts";

// #region tab
export type MyTabsTab_ClassNames = "MyTabsTab";

export type MyTabsTab_Props = Ariakit.TabProps;

export const MyTabsTab = memo(function MyTabsTab(props: MyTabsTab_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<Ariakit.Tab ref={ref} id={id} className={cn("MyTabsTab" satisfies MyTabsTab_ClassNames, className)} {...rest}>
			{children}
		</Ariakit.Tab>
	);
});
// #endregion tab

// #region panel
export type MyTabsPanel_ClassNames = "MyTabsPanel";

export type MyTabsPanel_Props = Ariakit.TabPanelProps;

export const MyTabsPanel = memo(function MyTabsPanel(props: MyTabsPanel_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<Ariakit.TabPanel
			ref={ref}
			id={id}
			className={cn("MyTabsPanel" satisfies MyTabsPanel_ClassNames, className)}
			{...rest}
		>
			{children}
		</Ariakit.TabPanel>
	);
});
// #endregion panel

// #region list
export type MyTabsList_ClassNames = "MyTabsList";

export type MyTabsList_Props = Ariakit.TabListProps;

export const MyTabsList = memo(function MyTabsList(props: MyTabsList_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<Ariakit.TabList
			ref={ref}
			id={id}
			className={cn("MyTabsList" satisfies MyTabsList_ClassNames, className)}
			{...rest}
		>
			{children}
		</Ariakit.TabList>
	);
});
// #endregion list

// #region panels
export type MyTabsPanels_ClassNames = "MyTabsPanels";

export type MyTabsPanels_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
	children?: ReactNode;
};

export const MyTabsPanels = memo(function MyTabsPanels(props: MyTabsPanels_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div ref={ref} id={id} className={cn("MyTabsPanels" satisfies MyTabsPanels_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
});
// #endregion panels

// #region root
export type MyTabs_ClassNames = "MyTabs";

export type MyTabs_Props = Ariakit.TabProviderProps;

export const MyTabs = memo(function MyTabs(props: MyTabs_Props) {
	const { children, ...rest } = props;

	return <Ariakit.TabProvider {...rest}>{children}</Ariakit.TabProvider>;
});
// #endregion root
