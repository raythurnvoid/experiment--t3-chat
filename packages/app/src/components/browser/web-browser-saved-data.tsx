import "./web-browser-saved-data.css";

import { MyButton } from "@/components/my-button.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalDescription,
	MyModalFooter,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
	MyModalScrollableArea,
} from "@/components/my-modal.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { useConvex } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { memo, useId, useRef, useState } from "react";

type WebBrowserSavedData_Summary = NonNullable<
	FunctionReturnType<typeof app_convex_api.files_browser.list_browser_profile_sites>["_yay"]
>;

/**
 * Plain text for a refusal of the saved data doors. Their messages are user-facing, but a few are
 * short codes that need a sentence.
 */
function web_browser_saved_data_error(nay: { name?: string; message: string }) {
	// The runner says `busy` while a browser is still closing, or when the saved data changed
	// during a clear.
	if (nay.name === "busy") {
		return "The saved data is in use. Try again in a moment.";
	}
	switch (nay.message) {
		case "Permission denied":
			return "You do not have permission to use the browser in this workspace.";
		case "Browser unavailable":
			return "The web browser is not available right now.";
		default:
			return nay.message;
	}
}

type WebBrowserSavedData_ClassNames =
	| "WebBrowserSavedData"
	| "WebBrowserSavedData-section"
	| "WebBrowserSavedData-section-title"
	| "WebBrowserSavedData-text"
	| "WebBrowserSavedData-list"
	| "WebBrowserSavedData-row"
	| "WebBrowserSavedData-confirm"
	| "WebBrowserSavedData-actions"
	| "WebBrowserSavedData-error";

type WebBrowserSavedData_CustomAttributes = {
	"data-sites-state": "hidden" | "confirm" | "loading" | "loaded";
};

type WebBrowserSavedData_Props = {
	/**
	 * A browser of this user is live in this workspace. Reading or clearing saved sites ends it
	 * first, so the dialog warns before it lists them.
	 */
	browserLive: boolean;
	onClose: () => void;
};

/**
 * Cloud logins are loaded only while this dialog is open.
 */
export const WebBrowserSavedData = memo(function WebBrowserSavedData(props: WebBrowserSavedData_Props) {
	const { browserLive, onClose } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const convex = useConvex();
	const idPrefix = useId();
	// A pressed button that goes away, or turns disabled, drops keyboard focus to the page body.
	// These get the focus instead, so keyboard and screen reader users stay in place.
	const sitesHeadingRef = useRef<HTMLHeadingElement>(null);
	const clearAllHeadingRef = useRef<HTMLHeadingElement>(null);

	const [sitesState, setSitesState] = useState<WebBrowserSavedData_CustomAttributes["data-sites-state"]>("hidden");
	const [summary, setSummary] = useState<WebBrowserSavedData_Summary | null>(null);
	const [sitesError, setSitesError] = useState<string | null>(null);
	const [sitesNotice, setSitesNotice] = useState<string | null>(null);
	const [clearingDomain, setClearingDomain] = useState<string | null>(null);
	const [clearAllState, setClearAllState] = useState<"hidden" | "confirm" | "clearing">("hidden");
	const [clearAllError, setClearAllError] = useState<string | null>(null);
	const [clearAllNotice, setClearAllNotice] = useState<string | null>(null);

	const handleOpenChange = useFn((open: boolean) => {
		if (!open) {
			onClose();
		}
	});

	const loadSites = () => {
		// The pressed button is replaced by the loading text, then by the list.
		sitesHeadingRef.current?.focus();
		setSitesState("loading");
		setSitesError(null);
		setSitesNotice(null);
		convex
			.action(app_convex_api.files_browser.list_browser_profile_sites, { membershipId })
			.then((result) => {
				if (result._nay) {
					setSitesError(web_browser_saved_data_error(result._nay));
					setSitesState("hidden");
					return;
				}
				setSummary(result._yay);
				setSitesState("loaded");
			})
			.catch((error: unknown) => {
				setSitesError("Could not load the saved sites. Try again.");
				setSitesState("hidden");
				console.error("[WebBrowserSavedData.loadSites] Unexpected list error", { error });
			});
	};

	const handleShowSites = useFn(() => {
		// The runner reads saved sites only while no browser is live, so the door ends the browser.
		// Ask first, because the user may still be using it.
		if (browserLive) {
			setSitesState("confirm");
			return;
		}
		loadSites();
	});

	const handleClearSite = (domain: string) => {
		// Every Clear button turns disabled now, and the pressed one goes away after the clear.
		sitesHeadingRef.current?.focus();
		setClearingDomain(domain);
		setSitesError(null);
		setSitesNotice(null);
		convex
			.action(app_convex_api.files_browser.clear_browser_profile_site, { membershipId, domain })
			.then((result) => {
				if (result._nay) {
					setSitesError(web_browser_saved_data_error(result._nay));
					return;
				}
				// The runner also removes cookies of hosts under this domain, so drop those rows too.
				setSummary((current) =>
					current
						? {
								...current,
								sites: current.sites.filter((site) => site.domain !== domain && !site.domain.endsWith(`.${domain}`)),
							}
						: current,
				);
				setSitesNotice(`Cleared ${domain}.`);
			})
			.catch((error: unknown) => {
				setSitesError("Could not clear the site. Try again.");
				console.error("[WebBrowserSavedData.clearSite] Unexpected clear error", { error });
			})
			.finally(() => {
				setClearingDomain(null);
			});
	};

	const handleClearAll = useFn(() => {
		// The pressed button turns disabled now and goes away after the clear.
		clearAllHeadingRef.current?.focus();
		setClearAllState("clearing");
		setClearAllError(null);
		convex
			.action(app_convex_api.files_browser.clear_browser_profile, { membershipId })
			.then((result) => {
				if (result._nay) {
					setClearAllError(web_browser_saved_data_error(result._nay));
					setClearAllState("confirm");
					return;
				}
				// The saved sites are gone, so hide the old list.
				setSummary(null);
				setSitesState("hidden");
				setSitesNotice(null);
				setClearAllState("hidden");
				setClearAllNotice("All saved data is cleared.");
			})
			.catch((error: unknown) => {
				setClearAllError("Could not clear the saved data. Try again.");
				setClearAllState("confirm");
				console.error("[WebBrowserSavedData.clearAll] Unexpected clear error", { error });
			});
	});

	return (
		<MyModal open setOpen={handleOpenChange}>
			<MyModalPopover
				className={"WebBrowserSavedData" satisfies WebBrowserSavedData_ClassNames}
				{...({ "data-sites-state": sitesState } satisfies WebBrowserSavedData_CustomAttributes)}
			>
				<MyModalHeader>
					<MyModalHeading>Manage saved data</MyModalHeading>
					<MyModalDescription>Your saved logins for the cloud browser in this workspace.</MyModalDescription>
				</MyModalHeader>
				<MyModalScrollableArea>
					<section
						className={"WebBrowserSavedData-section" satisfies WebBrowserSavedData_ClassNames}
						aria-labelledby={`${idPrefix}-sites`}
					>
						<h3
							ref={sitesHeadingRef}
							id={`${idPrefix}-sites`}
							className={"WebBrowserSavedData-section-title" satisfies WebBrowserSavedData_ClassNames}
							tabIndex={-1}
						>
							Saved sites
						</h3>
						{sitesState === "hidden" && (
							<MyButton variant="outline" onClick={handleShowSites}>
								Show saved sites
							</MyButton>
						)}
						{sitesState === "confirm" && (
							<div className={"WebBrowserSavedData-confirm" satisfies WebBrowserSavedData_ClassNames}>
								<p className={"WebBrowserSavedData-text" satisfies WebBrowserSavedData_ClassNames}>
									Your browser is open. Showing saved sites ends it first. Logins from this browser session are not
									saved.
								</p>
								<div className={"WebBrowserSavedData-actions" satisfies WebBrowserSavedData_ClassNames}>
									<MyButton variant="destructive" onClick={loadSites}>
										End browser and show sites
									</MyButton>
									<MyButton
										variant="ghost"
										autoFocus
										onClick={() => {
											sitesHeadingRef.current?.focus();
											setSitesState("hidden");
										}}
									>
										Cancel
									</MyButton>
								</div>
							</div>
						)}
						{sitesState === "loading" && (
							<p className={"WebBrowserSavedData-text" satisfies WebBrowserSavedData_ClassNames} role="status">
								Loading saved sites…
							</p>
						)}
						{sitesState === "loaded" && summary && (
							<>
								<p className={"WebBrowserSavedData-text" satisfies WebBrowserSavedData_ClassNames}>
									{summary.savedAt === null
										? "Nothing was saved yet."
										: `Last saved ${new Date(summary.savedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.`}
									{summary.truncated ? " Some cookies were not saved because the browser had too many." : null}
								</p>
								{summary.sites.length === 0 ? (
									<p className={"WebBrowserSavedData-text" satisfies WebBrowserSavedData_ClassNames}>No saved sites.</p>
								) : (
									// Only site names and cookie counts. The door never returns cookie values.
									<ul
										className={"WebBrowserSavedData-list" satisfies WebBrowserSavedData_ClassNames}
										aria-label="Saved sites"
									>
										{summary.sites.map((site) => (
											<li
												key={site.domain}
												className={"WebBrowserSavedData-row" satisfies WebBrowserSavedData_ClassNames}
											>
												<span>
													{site.domain} — {site.cookies} {site.cookies === 1 ? "cookie" : "cookies"}
												</span>
												<MyButton
													variant="ghost_destructive"
													aria-label={`Clear ${site.domain}`}
													disabled={clearingDomain !== null}
													aria-busy={clearingDomain === site.domain}
													onClick={() => handleClearSite(site.domain)}
												>
													{clearingDomain === site.domain ? "Clearing…" : "Clear"}
												</MyButton>
											</li>
										))}
									</ul>
								)}
							</>
						)}
						{sitesNotice && (
							<p className={"WebBrowserSavedData-text" satisfies WebBrowserSavedData_ClassNames} role="status">
								{sitesNotice}
							</p>
						)}
						{sitesError && (
							<p className={"WebBrowserSavedData-error" satisfies WebBrowserSavedData_ClassNames} role="alert">
								{sitesError}
							</p>
						)}
					</section>

					<section
						className={"WebBrowserSavedData-section" satisfies WebBrowserSavedData_ClassNames}
						aria-labelledby={`${idPrefix}-clear-all`}
					>
						<h3
							ref={clearAllHeadingRef}
							id={`${idPrefix}-clear-all`}
							className={"WebBrowserSavedData-section-title" satisfies WebBrowserSavedData_ClassNames}
							tabIndex={-1}
						>
							Clear all saved data
						</h3>
						{clearAllState === "hidden" ? (
							<MyButton variant="outline_destructive" onClick={() => setClearAllState("confirm")}>
								Clear all saved data
							</MyButton>
						) : (
							<div className={"WebBrowserSavedData-confirm" satisfies WebBrowserSavedData_ClassNames}>
								<p className={"WebBrowserSavedData-text" satisfies WebBrowserSavedData_ClassNames}>
									This signs you out of every site in this workspace's cloud browser, for you and your agent chats.
									{browserLive ? " Your open browser ends first." : null}
								</p>
								<div className={"WebBrowserSavedData-actions" satisfies WebBrowserSavedData_ClassNames}>
									<MyButton
										variant="destructive"
										disabled={clearAllState === "clearing"}
										aria-busy={clearAllState === "clearing"}
										onClick={handleClearAll}
									>
										{clearAllState === "clearing" ? "Clearing…" : "Clear all"}
									</MyButton>
									<MyButton
										variant="ghost"
										autoFocus
										disabled={clearAllState === "clearing"}
										onClick={() => {
											setClearAllState("hidden");
											setClearAllError(null);
										}}
									>
										Cancel
									</MyButton>
								</div>
							</div>
						)}
						{clearAllNotice && (
							<p className={"WebBrowserSavedData-text" satisfies WebBrowserSavedData_ClassNames} role="status">
								{clearAllNotice}
							</p>
						)}
						{clearAllError && (
							<p className={"WebBrowserSavedData-error" satisfies WebBrowserSavedData_ClassNames} role="alert">
								{clearAllError}
							</p>
						)}
					</section>
				</MyModalScrollableArea>
				<MyModalFooter>
					<MyButton variant="ghost" onClick={onClose}>
						Close
					</MyButton>
				</MyModalFooter>
				<MyModalCloseTrigger />
			</MyModalPopover>
		</MyModal>
	);
});
