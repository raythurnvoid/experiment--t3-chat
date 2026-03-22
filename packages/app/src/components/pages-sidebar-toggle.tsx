import { memo, type Ref } from "react";
import { PanelLeft } from "lucide-react";
import type { ExtractStrict } from "type-fest";

import { MyIconButton, type MyIconButton_Props } from "@/components/my-icon-button.tsx";
import { app_local_storage_set_value } from "@/lib/storage.ts";

export type PagesSidebarToggle_Props = Omit<MyIconButton_Props, ExtractStrict<keyof MyIconButton_Props, "children" | "onClick">> & {
	ref?: Ref<HTMLButtonElement>;
	tooltip?: string;
};

export const PagesSidebarToggle = memo(function PagesSidebarToggle(props: PagesSidebarToggle_Props) {
	const { tooltip = "Toggle pages sidebar", ...rest } = props;

	const handleClick = () => {
		app_local_storage_set_value("app_state::sidebar::pages_open", (value) => !value);
	};

	return (
		<MyIconButton tooltip={tooltip} onClick={handleClick} {...rest}>
			<PanelLeft />
		</MyIconButton>
	);
});
