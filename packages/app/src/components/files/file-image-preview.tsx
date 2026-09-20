import "./file-image-preview.css";

import { memo, useEffect, useRef, useState } from "react";
import { MyButton } from "@/components/my-button.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_convex, app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";

type FileImagePreview_ClassNames = "FileImagePreview" | "FileImagePreview-image";

type FileImagePreview_Props = {
	target:
		| { kind: "saved"; id: app_convex_Id<"files_nodes">; assetId: app_convex_Id<"files_r2_assets"> }
		| {
				kind: "private";
				id: app_convex_Id<"files_pending_nodes">;
				pendingUpdateId: app_convex_Id<"files_pending_updates">;
				reviewedRevision: number;
				creationGeneration: number;
		  };
	alt: string;
};

export const FileImagePreview = memo(function FileImagePreview(props: FileImagePreview_Props) {
	const { target, alt } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const [url, setUrl] = useState<string | null>(null);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Raising this counter re-runs the effect below, which asks for a new URL. Nothing renders it.
	const [retry, setRetry] = useState(0);
	const previewRef = useRef<HTMLDivElement>(null);

	// Copy the target fields into plain values so the effect below can depend on each one. A field
	// the other kind does not have stays null. `assetId` is a dependency only: the effect never
	// sends it, but a replaced saved file must ask for a new URL.
	const assetId = target.kind === "saved" ? target.assetId : null;
	const pendingUpdateId = target.kind === "private" ? target.pendingUpdateId : null;
	// The server refuses a private URL when the draft changed after this view read it. So send the
	// exact versions this view shows instead of asking for the latest ones.
	const reviewedRevision = target.kind === "private" ? target.reviewedRevision : null;
	const creationGeneration = target.kind === "private" ? target.creationGeneration : null;

	// Fetch a signed URL here instead of storing one. A signed URL expires in 15 minutes while a
	// chat message is kept forever, so the message holds only the Files target and this view asks
	// for a fresh URL whenever the target or its content changes.
	useEffect(() => {
		let cancelled = false;
		setUrl(null);
		setLoaded(false);
		setError(null);

		const request =
			target.kind === "saved"
				? app_convex.action(app_convex_api.r2.create_signed_download_url, { membershipId, fileNodeId: target.id })
				: app_convex.action(app_convex_api.files_pending_updates.create_private_pending_download_url, {
						membershipId,
						target: { kind: "private", id: target.id },
						pendingUpdateId: pendingUpdateId!,
						reviewedRevision: reviewedRevision!,
						creationGeneration: creationGeneration!,
					});

		void request
			.then((result) => {
				if (cancelled) return;
				if (result._nay) setError(result._nay.message);
				else setUrl(result._yay.url);
			})
			.catch(() => {
				if (!cancelled) setError("The image could not be loaded. Try again.");
			});

		return () => {
			cancelled = true;
		};
	}, [membershipId, target.kind, target.id, assetId, pendingUpdateId, reviewedRevision, creationGeneration, retry]);

	return (
		<div
			ref={previewRef}
			tabIndex={-1}
			aria-label={alt}
			className={"FileImagePreview" satisfies FileImagePreview_ClassNames}
		>
			{error ? (
				<>
					<p role="alert">{error}</p>
					<MyButton
						variant="outline"
						onClick={() => {
							// Retry removes this button. Move focus to a container that stays mounted.
							previewRef.current?.focus();
							setRetry((value) => value + 1);
						}}
					>
						Retry image
					</MyButton>
				</>
			) : (
				<>
					{!loaded && <p role="status">Loading image…</p>}
					{url && (
						<img
							key={url}
							className={"FileImagePreview-image" satisfies FileImagePreview_ClassNames}
							src={url}
							alt={alt}
							onLoad={() => setLoaded(true)}
							onError={() => setError("The image could not be loaded. Try again.")}
						/>
					)}
				</>
			)}
		</div>
	);
});
