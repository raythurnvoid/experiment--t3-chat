import "./plugins-gallery-card.css";

import { Check, Puzzle } from "lucide-react";
import { memo } from "react";

import { MyBadge } from "@/components/my-badge.tsx";
import { MyLink } from "@/components/my-link.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";

type PluginsGalleryCard_ClassNames =
	| "PluginsGalleryCard"
	| "PluginsGalleryCard-header"
	| "PluginsGalleryCard-icon"
	| "PluginsGalleryCard-identity"
	| "PluginsGalleryCard-name"
	| "PluginsGalleryCard-subtitle"
	| "PluginsGalleryCard-description"
	| "PluginsGalleryCard-footer"
	| "PluginsGalleryCard-version"
	| "PluginsGalleryCard-installed";

type PluginsGalleryCard_Props = {
	pluginName: string;
	displayName: string;
	/** Publisher display name on the main gallery, `owner/repo` on the publisher gallery. */
	subtitle: string;
	description: string;
	version: string;
	reviewStatus: "passed" | "rejected" | "flagged" | "pending";
	installed?: boolean;
};

/** Plugin card linking to the plugin detail page; used by the main and publisher galleries. */
const PluginsGalleryCard = memo(function PluginsGalleryCard(props: PluginsGalleryCard_Props) {
	const { pluginName, displayName, subtitle, description, version, reviewStatus, installed = false } = props;
	const { organizationName, workspaceName } = AppTenantProvider.useContext();

	return (
		<MyLink
			to="/w/$organizationName/$workspaceName/plugins/$pluginName"
			params={{ organizationName, workspaceName, pluginName }}
			aria-label={`Open plugin page for ${displayName}`}
			className={"PluginsGalleryCard" satisfies PluginsGalleryCard_ClassNames}
		>
			<span className={"PluginsGalleryCard-header" satisfies PluginsGalleryCard_ClassNames}>
				<Puzzle className={"PluginsGalleryCard-icon" satisfies PluginsGalleryCard_ClassNames} aria-hidden />
				<span className={"PluginsGalleryCard-identity" satisfies PluginsGalleryCard_ClassNames}>
					<span className={"PluginsGalleryCard-name" satisfies PluginsGalleryCard_ClassNames}>{displayName}</span>
					<span className={"PluginsGalleryCard-subtitle" satisfies PluginsGalleryCard_ClassNames}>{subtitle}</span>
				</span>
				{reviewStatus !== "passed" ? (
					<MyBadge variant={reviewStatus === "rejected" ? "destructive" : "outline"}>{reviewStatus}</MyBadge>
				) : null}
			</span>
			<span className={"PluginsGalleryCard-description" satisfies PluginsGalleryCard_ClassNames}>
				{description.trim().length > 0 ? description : "No description provided."}
			</span>
			<span className={"PluginsGalleryCard-footer" satisfies PluginsGalleryCard_ClassNames}>
				<span className={"PluginsGalleryCard-version" satisfies PluginsGalleryCard_ClassNames}>v{version}</span>
				{installed ? (
					<span className={"PluginsGalleryCard-installed" satisfies PluginsGalleryCard_ClassNames}>
						<Check aria-hidden />
						Installed
					</span>
				) : null}
			</span>
		</MyLink>
	);
});

export { PluginsGalleryCard };
