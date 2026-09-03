import { UploadCloud } from "lucide-react";
import { memo, useRef } from "react";

import { MyButton, type MyButton_Props } from "@/components/my-button.tsx";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { PluginsPublishSessionProvider } from "./plugins-publish-session.tsx";

type PluginsPublishButton_Props = {
	repositoryId: app_convex_Id<"plugins_publisher_repositories">;
	repositoryLabel: string;
	disabled?: boolean;
	buttonVariant?: MyButton_Props["variant"];
	onBusyChange?: (busy: boolean) => void;
	onSessionChange?: (active: boolean) => void;
	onPublished?: () => void;
};

const PluginsPublishButton = memo(function PluginsPublishButton(props: PluginsPublishButton_Props) {
	const {
		repositoryId,
		repositoryLabel,
		disabled = false,
		buttonVariant,
		onBusyChange,
		onSessionChange,
		onPublished,
	} = props;
	const triggerRef = useRef<HTMLButtonElement>(null);
	const publishSession = PluginsPublishSessionProvider.useContext();
	const active = publishSession.session?.repositoryId === repositoryId;
	const checking = active && publishSession.session?.phase === "checking";
	const publishing = active && publishSession.session?.phase === "publishing";

	return (
		<MyButton
			ref={triggerRef}
			variant={buttonVariant}
			disabled={disabled || Boolean(publishSession.managementAction) || Boolean(publishSession.session && !active)}
			aria-label={`Publish ${repositoryLabel}`}
			aria-busy={checking || publishing}
			onClick={() => {
				if (disabled || publishSession.managementAction) {
					return;
				}

				publishSession.start({
					repositoryId,
					repositoryLabel,
					triggerRef,
					onBusyChange,
					onSessionChange,
					onPublished,
				});
			}}
		>
			<UploadCloud aria-hidden />
			{checking ? "Checking commit..." : publishing ? "Publishing..." : "Publish"}
		</MyButton>
	);
});

export { PluginsPublishButton };
