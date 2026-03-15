import { memo, type Ref } from "react";
import { PanelLeft } from "lucide-react";

import { MyIconButton, type MyIconButton_Props } from "@/components/my-icon-button.tsx";
import { useAppLocalStorageState } from "@/lib/storage.ts";

export type PagesSidebarToggle_Props = Omit<MyIconButton_Props, "children" | "onClick"> & {
	ref?: Ref<HTMLButtonElement>;
	tooltip?: string;
};

export const PagesSidebarToggle = memo(function PagesSidebarToggle(props: PagesSidebarToggle_Props) {
	const { tooltip = "Toggle pages sidebar", ...rest } = props;

	const handleClick = () => {
		useAppLocalStorageState.setState((state) => ({
			pages_sidebar_open: !state.pages_sidebar_open,
		}));
	};

	return (
		<MyIconButton tooltip={tooltip} onClick={handleClick} {...rest}>
			<PanelLeft />
		</MyIconButton>
	);
});
