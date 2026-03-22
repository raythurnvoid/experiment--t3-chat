import { createContext, memo, use, type ReactNode } from "react";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

export type AppTenantContextValue = {
	/** Convex `workspaces_projects_users` document id for the current user and tenant. */
	membershipId: app_convex_Id<"workspaces_projects_users">;
	projectId: string;
	workspaceId: string;
};

const AppTenantContext = createContext<AppTenantContextValue | null>(null);

type AppTenantProvider_Props = AppTenantContextValue & {
	children: ReactNode;
};

const AppTenantProvider = Object.assign(
	memo(function AppTenantProvider(props: AppTenantProvider_Props) {
		const { membershipId, workspaceId, projectId, children } = props;

		return (
			<AppTenantContext.Provider value={{ membershipId, workspaceId, projectId }}>{children}</AppTenantContext.Provider>
		);
	}),
	{
		useContext: function useContext() {
			const value = use(AppTenantContext);
			if (!value) {
				throw new Error("AppTenantProvider.useContext must be used within AppTenantProvider");
			}
			return value;
		},
	},
);

export { AppTenantProvider };
