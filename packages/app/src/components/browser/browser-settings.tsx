import "./browser-settings.css";

import { PlaywriterBrowserConnection } from "@/components/browser/playwriter-browser-connection.tsx";
import { MyButton } from "@/components/my-button.tsx";
import {
	MyInput,
	MyInputArea,
	MyInputBackground,
	MyInputBox,
	MyInputControl,
	MyInputLabel,
} from "@/components/my-input.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalFooter,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
	MyModalScrollableArea,
} from "@/components/my-modal.tsx";
import { MySwitch } from "@/components/my-switch.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { useConvex, useQuery } from "convex/react";
import { memo, useRef, useState, type FormEvent } from "react";

type BrowserSettings_ClassNames =
	| "BrowserSettings"
	| "BrowserSettings-section"
	| "BrowserSettings-section-title"
	| "BrowserSettings-text"
	| "BrowserSettings-access"
	| "BrowserSettings-list"
	| "BrowserSettings-row"
	| "BrowserSettings-add";

type BrowserSettings_Props = {
	onClose: () => void;
};

export const BrowserSettings = memo(function BrowserSettings(props: BrowserSettings_Props) {
	const { onClose } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const convex = useConvex();
	const preferences = useQuery(app_convex_api.files_browser.current_browser_preferences, { membershipId });
	const inputRef = useRef<HTMLInputElement>(null);
	const [blockedDraft, setBlockedDraft] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const hosts = preferences?.agentBlockedHosts ?? [];

	const handleAccessChange = useFn((enabled: boolean) => {
		setPending(true);
		setError(null);
		convex
			.action(app_convex_api.files_browser.set_browser_agent_access, { membershipId, enabled })
			.then((result) => {
				if (result._nay) setError(result._nay.message);
			})
			.catch(() => {
				// Browser errors may contain share IDs. Show only this fixed message.
				setError("Could not change agent access. Try again.");
			})
			.finally(() => setPending(false));
	});

	const saveHosts = (nextHosts: string[], clearDraft = false) => {
		inputRef.current?.focus();
		setPending(true);
		setError(null);
		convex
			.action(app_convex_api.files_browser.set_agent_blocked_hosts, { membershipId, hosts: nextHosts })
			.then((result) => {
				if (result._nay) setError(result._nay.message);
				else if (clearDraft) setBlockedDraft("");
			})
			.catch(() => {
				// Browser errors may contain share IDs. Show only this fixed message.
				setError("Could not save the sites. Try again.");
			})
			.finally(() => setPending(false));
	};
	const handleAdd = useFn((event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!pending && blockedDraft.trim()) saveHosts([...hosts, blockedDraft.trim()], true);
	});

	return (
		<MyModal
			open
			setOpen={(open) => {
				if (!open) onClose();
			}}
		>
			<MyModalPopover className={"BrowserSettings" satisfies BrowserSettings_ClassNames}>
				<MyModalHeader>
					<MyModalHeading>Browser settings</MyModalHeading>
				</MyModalHeader>
				<MyModalScrollableArea>
					{preferences?.syncPending && (
						<p className={"BrowserSettings-text" satisfies BrowserSettings_ClassNames} role="status">
							Browser settings are saved. Waiting for the browser to update…
						</p>
					)}
					<section className={"BrowserSettings-section" satisfies BrowserSettings_ClassNames}>
						<p className={"BrowserSettings-text" satisfies BrowserSettings_ClassNames}>
							Your agent can use two kinds of web tabs and picks the one it needs. It can start the cloud
							browser from any chat. Cloud browser time is billed per minute. It can also use one tab that
							you share from your own browser.
						</p>
						<PlaywriterBrowserConnection />
					</section>
					<section className={"BrowserSettings-section" satisfies BrowserSettings_ClassNames}>
						<label className={"BrowserSettings-access" satisfies BrowserSettings_ClassNames}>
							<MySwitch
								checked={preferences?.webAgentAccess ?? false}
								disabled={pending || !preferences}
								onCheckedChange={handleAccessChange}
							/>
							Agent can use web browser
						</label>
						<p className={"BrowserSettings-text" satisfies BrowserSettings_ClassNames}>
							This setting stays the same when you close a panel or end a browser.
						</p>
						<h3 className={"BrowserSettings-section-title" satisfies BrowserSettings_ClassNames}>
							Sites the agent may not use
						</h3>
						<p className={"BrowserSettings-text" satisfies BrowserSettings_ClassNames}>
							Best effort. Applies to both browsers.
						</p>
						<ul
							className={"BrowserSettings-list" satisfies BrowserSettings_ClassNames}
							aria-label="Sites the agent may not use"
						>
							{hosts.map((host) => (
								<li key={host} className={"BrowserSettings-row" satisfies BrowserSettings_ClassNames}>
									<span>{host}</span>
									<MyButton
										variant="ghost"
										aria-label={`Remove ${host}`}
										disabled={pending}
										onClick={() => saveHosts(hosts.filter((item) => item !== host))}
									>
										Remove
									</MyButton>
								</li>
							))}
						</ul>
						<form className={"BrowserSettings-add" satisfies BrowserSettings_ClassNames} onSubmit={handleAdd}>
							<MyInput layout="stacked">
								<MyInputLabel>Add a site</MyInputLabel>
								<MyInputBackground />
								<MyInputArea>
									<MyInputControl
										ref={inputRef}
										autoComplete="off"
										spellCheck={false}
										placeholder="bank.example"
										value={blockedDraft}
										readOnly={pending}
										onChange={(event) => setBlockedDraft(event.currentTarget.value)}
									/>
								</MyInputArea>
								<MyInputBox />
							</MyInput>
							<MyButton type="submit" variant="outline" disabled={pending || !preferences || !blockedDraft.trim()}>
								Add
							</MyButton>
						</form>
						{error && <p role="alert">{error}</p>}
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
