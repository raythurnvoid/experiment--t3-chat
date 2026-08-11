import "./file-editor-sidebar-details.css";
import { memo } from "react";
import { useQuery } from "convex/react";
import { MySkeleton } from "@/components/my-skeleton.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_convex_api, type app_convex_Doc } from "@/lib/app-convex-client.ts";
import { format_relative_time } from "@/lib/date.ts";
import { files_format_size } from "@/lib/files.ts";
import { users_SYSTEM_AUTHOR } from "../../../../../shared/users.ts";

// #region details
type FileEditorSidebarDetails_ClassNames =
	| "FileEditorSidebarDetails"
	| "FileEditorSidebarDetails-metadata"
	| "FileEditorSidebarDetails-row"
	| "FileEditorSidebarDetails-label"
	| "FileEditorSidebarDetails-value"
	| "FileEditorSidebarDetails-skeleton";

// The seven stable facts from the stored-file card that the details panel preserves for
// converted files: Content type, Size, Location, Created, Created by, Last edited, Last edited by.
const FILE_EDITOR_SIDEBAR_DETAILS_SKELETON_ROW_COUNT = 7;

export type FileEditorSidebarDetails_Props = {
	node: app_convex_Doc<"files_nodes">;
};

export const FileEditorSidebarDetails = memo(function FileEditorSidebarDetails(props: FileEditorSidebarDetails_Props) {
	const { node } = props;
	const { membershipId } = AppTenantProvider.useContext();

	// A converted upload keeps its stored blob asset, so its size is still the asset size. A file
	// created in-app has no asset; the size then reads "Unknown" instead of hiding the row.
	const asset = useQuery(app_convex_api.r2.get_asset, {
		membershipId,
		fileNodeId: node._id,
	});

	const createdByAnagraphic = useQuery(
		app_convex_api.users.get_anagraphic,
		node.createdBy === users_SYSTEM_AUTHOR ? "skip" : { userId: node.createdBy },
	);

	const updatedByAnagraphic = useQuery(
		app_convex_api.users.get_anagraphic,
		node.updatedBy === users_SYSTEM_AUTHOR ? "skip" : { userId: node.updatedBy },
	);

	// undefined = still loading, shows the skeleton rows
	const createdByDisplayName = ((/* iife */) => {
		if (node.createdBy === users_SYSTEM_AUTHOR) {
			return "System";
		}
		if (createdByAnagraphic === undefined) {
			return undefined;
		}
		return createdByAnagraphic?.displayName ?? "Unknown";
	})();

	const updatedByDisplayName = ((/* iife */) => {
		if (node.updatedBy === users_SYSTEM_AUTHOR) {
			return "System";
		}
		if (updatedByAnagraphic === undefined) {
			return undefined;
		}
		return updatedByAnagraphic?.displayName ?? "Unknown";
	})();

	const location = node.path.slice(0, node.path.lastIndexOf("/")) || "/";

	return (
		<section
			aria-label="File details"
			className={"FileEditorSidebarDetails" satisfies FileEditorSidebarDetails_ClassNames}
		>
			{asset === undefined || createdByDisplayName === undefined || updatedByDisplayName === undefined ? (
				<dl className={"FileEditorSidebarDetails-metadata" satisfies FileEditorSidebarDetails_ClassNames}>
					{Array.from({ length: FILE_EDITOR_SIDEBAR_DETAILS_SKELETON_ROW_COUNT }, (_, index) => (
						<div key={index} className={"FileEditorSidebarDetails-row" satisfies FileEditorSidebarDetails_ClassNames}>
							<dt className={"FileEditorSidebarDetails-label" satisfies FileEditorSidebarDetails_ClassNames}>
								<MySkeleton
									className={"FileEditorSidebarDetails-skeleton" satisfies FileEditorSidebarDetails_ClassNames}
								/>
							</dt>
							<dd className={"FileEditorSidebarDetails-value" satisfies FileEditorSidebarDetails_ClassNames}>
								<MySkeleton
									className={"FileEditorSidebarDetails-skeleton" satisfies FileEditorSidebarDetails_ClassNames}
								/>
							</dd>
						</div>
					))}
				</dl>
			) : (
				<dl className={"FileEditorSidebarDetails-metadata" satisfies FileEditorSidebarDetails_ClassNames}>
					<div className={"FileEditorSidebarDetails-row" satisfies FileEditorSidebarDetails_ClassNames}>
						<dt className={"FileEditorSidebarDetails-label" satisfies FileEditorSidebarDetails_ClassNames}>
							Content type
						</dt>
						<dd className={"FileEditorSidebarDetails-value" satisfies FileEditorSidebarDetails_ClassNames}>
							{node.contentType ?? "Unknown"}
						</dd>
					</div>
					<div className={"FileEditorSidebarDetails-row" satisfies FileEditorSidebarDetails_ClassNames}>
						<dt className={"FileEditorSidebarDetails-label" satisfies FileEditorSidebarDetails_ClassNames}>Size</dt>
						<dd className={"FileEditorSidebarDetails-value" satisfies FileEditorSidebarDetails_ClassNames}>
							{files_format_size(asset?.size)}
						</dd>
					</div>
					<div className={"FileEditorSidebarDetails-row" satisfies FileEditorSidebarDetails_ClassNames}>
						<dt className={"FileEditorSidebarDetails-label" satisfies FileEditorSidebarDetails_ClassNames}>Location</dt>
						<dd className={"FileEditorSidebarDetails-value" satisfies FileEditorSidebarDetails_ClassNames}>
							{location}
						</dd>
					</div>
					<div className={"FileEditorSidebarDetails-row" satisfies FileEditorSidebarDetails_ClassNames}>
						<dt className={"FileEditorSidebarDetails-label" satisfies FileEditorSidebarDetails_ClassNames}>Created</dt>
						<dd className={"FileEditorSidebarDetails-value" satisfies FileEditorSidebarDetails_ClassNames}>
							{format_relative_time(node._creationTime)}
						</dd>
					</div>
					<div className={"FileEditorSidebarDetails-row" satisfies FileEditorSidebarDetails_ClassNames}>
						<dt className={"FileEditorSidebarDetails-label" satisfies FileEditorSidebarDetails_ClassNames}>
							Created by
						</dt>
						<dd className={"FileEditorSidebarDetails-value" satisfies FileEditorSidebarDetails_ClassNames}>
							{createdByDisplayName}
						</dd>
					</div>
					<div className={"FileEditorSidebarDetails-row" satisfies FileEditorSidebarDetails_ClassNames}>
						<dt className={"FileEditorSidebarDetails-label" satisfies FileEditorSidebarDetails_ClassNames}>
							Last edited
						</dt>
						<dd className={"FileEditorSidebarDetails-value" satisfies FileEditorSidebarDetails_ClassNames}>
							{format_relative_time(node.updatedAt)}
						</dd>
					</div>
					<div className={"FileEditorSidebarDetails-row" satisfies FileEditorSidebarDetails_ClassNames}>
						<dt className={"FileEditorSidebarDetails-label" satisfies FileEditorSidebarDetails_ClassNames}>
							Last edited by
						</dt>
						<dd className={"FileEditorSidebarDetails-value" satisfies FileEditorSidebarDetails_ClassNames}>
							{updatedByDisplayName}
						</dd>
					</div>
				</dl>
			)}
		</section>
	);
});
// #endregion details
