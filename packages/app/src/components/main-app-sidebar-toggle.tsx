import { memo, type Ref } from "react";
import { Menu } from "lucide-react";
import type { ExtractStrict } from "type-fest";

import { MyIconButton, type MyIconButton_Props } from "@/components/my-icon-button.tsx";
import { useAppLocalStorageState } from "@/lib/storage.ts";

export type MainAppSidebarToggle_Props = Omit<MyIconButton_Props, ExtractStrict<keyof MyIconButton_Props, "children" | "onClick">> & {
	ref?: Ref<HTMLButtonElement>;
	tooltip?: string;
};

export const MainAppSidebarToggle = memo(function MainAppSidebarToggle(props: MainAppSidebarToggle_Props) {
	const { tooltip = "Toggle sidebar", ...rest } = props;

	const handleClick = () => {
		useAppLocalStorageState.setState((state) => ({
			main_app_sidebar_open: !state.main_app_sidebar_open,
		}));
	};

	return (
		<MyIconButton tooltip={tooltip} onClick={handleClick} {...rest}>
			<Menu />
		</MyIconButton>
	);
});
