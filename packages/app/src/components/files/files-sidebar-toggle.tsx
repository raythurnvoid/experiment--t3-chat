import { memo, type Ref } from "react";
import { PanelLeft } from "lucide-react";
import type { ExtractStrict } from "type-fest";

import { MyIconButton, type MyIconButton_Props } from "@/components/my-icon-button.tsx";
import { app_local_storage_set_value } from "@/lib/storage.ts";

export type FilesSidebarToggle_Props = Omit<MyIconButton_Props, ExtractStrict<keyof MyIconButton_Props, "children" | "onClick">> & {
	ref?: Ref<HTMLButtonElement>;
	tooltip?: string;
};

export const FilesSidebarToggle = memo(function FilesSidebarToggle(props: FilesSidebarToggle_Props) {
	const { tooltip = "Toggle files sidebar", ...rest } = props;

	const handleClick = () => {
		app_local_storage_set_value("app_state::sidebar::files_open", (value) => !value);
	};

	return (
		<MyIconButton tooltip={tooltip} onClick={handleClick} {...rest}>
			<PanelLeft />
		</MyIconButton>
	);
});
