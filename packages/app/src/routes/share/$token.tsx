import { createFileRoute } from "@tanstack/react-router";
import { memo } from "react";

import { FilesSharePage } from "@/components/files/files-share-page.tsx";

// The public page of a file link. `main.tsx` and the root route load it without sign-in, so it must
// never use app auth, tenant hooks, or router links into the app.
const RouteShareToken = memo(function RouteShareToken() {
	const { token } = Route.useParams();

	return <FilesSharePage key={token} token={token} />;
});

const Route = createFileRoute("/share/$token")({
	component: RouteShareToken,
});

export { Route };
