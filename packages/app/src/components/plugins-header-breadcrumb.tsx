import "./plugins-header-breadcrumb.css";

import { Fragment, memo, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { MyLink } from "@/components/my-link.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { AppElementId } from "@/lib/dom-utils.ts";

type PluginsHeaderBreadcrumb_ClassNames =
	| "PluginsHeaderBreadcrumb"
	| "PluginsHeaderBreadcrumb-segment"
	| "PluginsHeaderBreadcrumb-segment-current"
	| "PluginsHeaderBreadcrumb-separator";

type PluginsHeaderBreadcrumb_Props = {
	trail?: Array<"plugins" | "publisher">;
	current?: string | null;
};

/*
Every plugins route renders this into the main app header (like FileNodeViewHeaderPortal does
for /files) so the breadcrumb is always present and navigating between plugins pages causes
no in-page layout shift.
*/
const PluginsHeaderBreadcrumb = memo(function PluginsHeaderBreadcrumb(props: PluginsHeaderBreadcrumb_Props) {
	const { trail = [], current = null } = props;
	const { organizationName, workspaceName } = AppTenantProvider.useContext();

	/*
	On a full page load this component renders in the same commit as MainAppHeader, so the portal
	target is not in the DOM yet, and memo() would keep the null result forever. Resolve after mount.
	*/
	const [headerPortalElement, setHeaderPortalElement] = useState<HTMLElement | null>(null);
	useEffect(() => {
		setHeaderPortalElement(document.getElementById("app_main_header_content" satisfies AppElementId));
	}, []);

	if (!headerPortalElement) {
		return null;
	}

	return createPortal(
		<ol className={"PluginsHeaderBreadcrumb" satisfies PluginsHeaderBreadcrumb_ClassNames}>
			{trail.map((segment, index) => (
				<Fragment key={segment}>
					<li>
						{segment === "plugins" ? (
							<MyLink
								className={"PluginsHeaderBreadcrumb-segment" satisfies PluginsHeaderBreadcrumb_ClassNames}
								to="/w/$organizationName/$workspaceName/plugins"
								params={{ organizationName, workspaceName }}
								variant="button-tertiary"
							>
								Plugins
							</MyLink>
						) : (
							<MyLink
								className={"PluginsHeaderBreadcrumb-segment" satisfies PluginsHeaderBreadcrumb_ClassNames}
								to="/w/$organizationName/$workspaceName/plugins/publisher"
								params={{ organizationName, workspaceName }}
								variant="button-tertiary"
							>
								Publisher
							</MyLink>
						)}
					</li>
					{index < trail.length - 1 || current ? (
						<span className={"PluginsHeaderBreadcrumb-separator" satisfies PluginsHeaderBreadcrumb_ClassNames}>/</span>
					) : null}
				</Fragment>
			))}
			{current ? (
				<li className={"PluginsHeaderBreadcrumb-segment-current" satisfies PluginsHeaderBreadcrumb_ClassNames}>
					{current}
				</li>
			) : null}
		</ol>,
		headerPortalElement,
	);
});

export { PluginsHeaderBreadcrumb };
