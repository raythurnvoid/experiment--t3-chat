import "./file-draft-recovery.css";

import { memo, useEffect, useState } from "react";
import { CopyIconButton } from "@/components/copy-icon-button.tsx";
import { app_convex, app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { files_fetch_file_pending_update_yjs_state, type files_VisibleEntry } from "@/lib/files.ts";
import { files_yjs_doc_create_from_array_buffer_update } from "../../../../shared/files-yjs.ts";
import { files_yjs_doc_get_text } from "../../../../shared/files-tiptap.ts";

type FileDraftRecovery_ClassNames = "FileDraftRecovery" | "FileDraftRecovery-heading";

type FileDraftRecovery_Props = {
	entry: Extract<files_VisibleEntry, { kind: "private" }>;
};

/**
 * Read captured branches without mounting an editor or creating an edit batch.
 */
export const FileDraftRecovery = memo(function FileDraftRecovery(props: FileDraftRecovery_Props) {
	const { entry } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const [result, setResult] = useState<{
		entry: typeof entry;
		membershipId: typeof membershipId;
		texts: string[];
	} | null>();
	useEffect(() => {
		let cancelled = false;
		(async () => {
			const pending = entry.pendingUpdate;
			if (!pending.content || pending.createIntent?.kind !== "text") throw new Error("Draft unavailable");
			const texts = [];
			for (const stateId of [pending.content.stagedStateId, pending.content.unstagedStateId]) {
				const state = await files_fetch_file_pending_update_yjs_state({
					membershipId,
					target: pending.target,
					stateId,
				});
				if (cancelled) return;
				if (state._nay) throw new Error("Draft unavailable");
				const doc = files_yjs_doc_create_from_array_buffer_update(state._yay);
				const text = files_yjs_doc_get_text({ yjsDoc: doc, rootKind: pending.createIntent.textKind });
				doc.destroy();
				if (text._nay) throw new Error("Draft unavailable");
				texts.push(text._yay);
			}
			// Access or the proposal may change between page reads.
			const current = await app_convex.query(app_convex_api.files_pending_updates.get_file_pending_update, {
				membershipId,
				target: pending.target,
				pendingUpdateId: pending._id,
			});
			if (current?._id !== pending._id || current.revision !== pending.revision) throw new Error("Draft unavailable");
			if (!cancelled) setResult({ entry, membershipId, texts });
		})().catch((error: unknown) => {
			console.error("[FileDraftRecovery.load] Failed to load draft text", {
				error,
				pendingUpdateId: entry.pendingUpdate._id,
			});
			if (!cancelled) setResult(null);
		});
		return () => {
			cancelled = true;
		};
	}, [entry, membershipId]);

	if (result === null) return <p role="alert">This draft changed or access ended. Reopen it to try again.</p>;
	if (!result || result.entry !== entry || result.membershipId !== membershipId)
		return <p role="status">Loading draft…</p>;
	return (
		<div className={"FileDraftRecovery" satisfies FileDraftRecovery_ClassNames}>
			{result.texts.map((text, index) => {
				const label = index === 0 ? "Accepted text" : "Proposed text";
				return (
					<section key={label}>
						<div className={"FileDraftRecovery-heading" satisfies FileDraftRecovery_ClassNames}>
							<h3>{label}</h3>
							<CopyIconButton text={text} tooltipCopy={`Copy ${label.toLowerCase()}`} />
						</div>
						<textarea aria-label={label} readOnly value={text} />
					</section>
				);
			})}
		</div>
	);
});
