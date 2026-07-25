import "./$.css";

import { MyLink } from "@/components/my-link.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { files_ROOT_ID, files_editor_view_values } from "@/lib/files.ts";
import { path_extract_segments_from } from "@/lib/paths.ts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { zodValidator } from "@tanstack/zod-adapter";
import { useQuery } from "convex/react";
import { memo, useEffect } from "react";
import { z } from "zod";

// #region not found
type RouteFilesPathNotFound_ClassNames =
	| "RouteFilesPathNotFound"
	| "RouteFilesPathNotFound-title"
	| "RouteFilesPathNotFound-description"
	| "RouteFilesPathNotFound-path"
	| "RouteFilesPathNotFound-actions";

type RouteFilesPathNotFound_Props = {
	path: string;
};

const RouteFilesPathNotFound = memo(function RouteFilesPathNotFound(props: RouteFilesPathNotFound_Props) {
	const { path } = props;

	const { organizationName, workspaceName } = AppTenantProvider.useContext();

	return (
		<div className={"RouteFilesPathNotFound" satisfies RouteFilesPathNotFound_ClassNames}>
			<h1 className={"RouteFilesPathNotFound-title" satisfies RouteFilesPathNotFound_ClassNames}>File not found</h1>
			<p className={"RouteFilesPathNotFound-description" satisfies RouteFilesPathNotFound_ClassNames}>
				Nothing is stored at this path. It may have been renamed, moved, or archived. Path links match the stored name
				exactly, so a different upper or lower case will also miss.
			</p>
			<code className={"RouteFilesPathNotFound-path" satisfies RouteFilesPathNotFound_ClassNames}>{path}</code>
			<div className={"RouteFilesPathNotFound-actions" satisfies RouteFilesPathNotFound_ClassNames}>
				<MyLink
					variant="button-outline"
					to="/w/$organizationName/$workspaceName/files"
					params={{ organizationName, workspaceName }}
					search={{ nodeId: files_ROOT_ID, q: path }}
				>
					Search for this path
				</MyLink>
				<MyLink
					variant="button-tertiary"
					to="/w/$organizationName/$workspaceName/files"
					params={{ organizationName, workspaceName }}
					search={{ nodeId: files_ROOT_ID }}
				>
					Go to files home
				</MyLink>
			</div>
		</div>
	);
});
// #endregion not found

// #region root
type RouteFilesPath_ClassNames = "RouteFilesPath" | "RouteFilesPath-loading-text";

const RouteFilesPath = memo(function RouteFilesPath() {
	const navigate = useNavigate();
	const params = Route.useParams();
	const { view } = Route.useSearch();
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();

	// Canonicalize the splat into the stored absolute path shape so `/docs/api.md` and
	// `docs/api.md` both resolve. Do not run the create/rename name normalizer here: it
	// rewrites characters and would silently point at a different file.
	const path = `/${path_extract_segments_from(params._splat ?? "").join("/")}`;

	const resolvedNode = useQuery(app_convex_api.files_nodes.get_authorized_by_path, { membershipId, path });

	// Path is only an entry format. Once resolved, hand over to the node-id route so the open
	// tab survives a later rename or move, and so the lookup does not repeat on every load.
	// `replace` keeps the path URL out of history, so Back leaves the files route.
	useEffect(() => {
		if (!resolvedNode) {
			return;
		}

		navigate({
			to: "/w/$organizationName/$workspaceName/files",
			params: { organizationName, workspaceName },
			search: { nodeId: resolvedNode.nodeId, view },
			replace: true,
		}).catch((error: unknown) => {
			console.error("[RouteFilesPath.redirect] Error navigating to the resolved file node", {
				error,
				path,
				nodeId: resolvedNode.nodeId,
			});
		});
	}, [navigate, organizationName, path, resolvedNode, view, workspaceName]);

	return (
		<div className={"RouteFilesPath" satisfies RouteFilesPath_ClassNames}>
			{/* Only `null` means "looked up and missing". `undefined` is still loading, so keep the
			    not-found panel out of a cold pasted-link load. */}
			{resolvedNode === null ? (
				<RouteFilesPathNotFound path={path} />
			) : (
				<div className={"RouteFilesPath-loading-text" satisfies RouteFilesPath_ClassNames}>Loading...</div>
			)}
		</div>
	);
});

const Route = createFileRoute("/w/$organizationName/$workspaceName/files/$")({
	component: RouteFilesPath,
	validateSearch: zodValidator(
		z.object({
			view: z.enum(files_editor_view_values).optional().catch(undefined),
		}),
	),
});

export { Route };
// #endregion root
