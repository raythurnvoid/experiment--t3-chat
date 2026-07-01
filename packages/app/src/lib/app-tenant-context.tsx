import { createContext, memo, use, type ReactNode } from "react";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

export type AppTenantContextValue = {
	/** Convex `organizations_workspaces_users` document id for the current user and tenant. */
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	workspaceId: app_convex_Id<"organizations_workspaces">;
	workspaceName: string;
	organizationId: app_convex_Id<"organizations">;
	organizationName: string;
};

const AppTenantContext = createContext<AppTenantContextValue | null>(null);

type AppTenantProvider_Props = AppTenantContextValue & {
	children: ReactNode;
};

const AppTenantProvider = Object.assign(
	memo(function AppTenantProvider(props: AppTenantProvider_Props) {
		const { membershipId, organizationId, organizationName, workspaceId, workspaceName, children } = props;

		return (
			<AppTenantContext.Provider
				value={{ membershipId, organizationId, organizationName, workspaceId, workspaceName }}
			>
				{children}
			</AppTenantContext.Provider>
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
