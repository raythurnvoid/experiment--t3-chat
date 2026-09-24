import "./file-pending-notice.css";

import { memo } from "react";
import { MyLink } from "@/components/my-link.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { format_datetime } from "@/lib/date.ts";
import type { FunctionReturnType } from "convex/server";

type FilePendingNotice_PendingView = NonNullable<
	FunctionReturnType<typeof app_convex_api.files_pending_updates.get_file_pending_target>
>;

type FilePendingNotice_ClassNames = "FilePendingNotice";

type FilePendingNotice_CustomAttributes = {
	"data-recovery": "archived-parent";
	"data-copy-destination": true;
};

type FilePendingNotice_Props = {
	recovery?: FilePendingNotice_PendingView["recovery"];
	copyDestination?: FilePendingNotice_PendingView["copyDestination"];
};

export const FilePendingNotice = memo(function FilePendingNotice(props: FilePendingNotice_Props) {
	const { recovery, copyDestination } = props;
	const { organizationName, workspaceName } = AppTenantProvider.useContext();
	if (!recovery && !copyDestination) return null;
	return (
		<div
			className={"FilePendingNotice" satisfies FilePendingNotice_ClassNames}
			{...({
				"data-recovery": recovery ? "archived-parent" : undefined,
				"data-copy-destination": copyDestination ? true : undefined,
			} satisfies Partial<FilePendingNotice_CustomAttributes>)}
		>
			{copyDestination && (
				<>
					<p>
						Destination: {organizationName}/{workspaceName} · {copyDestination.folderPath}
					</p>
					<p>
						{copyDestination.replacement
							? "This replaces content and keeps the destination file's sharing rules."
							: "New copies use this folder's sharing rules. Source sharing is not copied."}
					</p>
					<p>
						{copyDestination.personal
							? "Saved copies here are private to you."
							: "The destination organization owner can read saved copies."}
					</p>
				</>
			)}
			{recovery && (
				<>
					<p>
						This draft's folder was archived. You can copy or download your draft. Restore the folder before saving
						here.
					</p>
					<p>Unsaved draft expires {format_datetime(recovery.expiresAt)}.</p>
					<MyLink
						to="/w/$organizationName/$workspaceName/files"
						params={{ organizationName, workspaceName }}
						search={{ nodeId: recovery.savedParentId }}
					>
						Open archived folder
					</MyLink>
				</>
			)}
		</div>
	);
});
