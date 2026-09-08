import { usePaginatedQuery, useQuery } from "convex/react";
import { memo } from "react";

import { MyButton } from "@/components/my-button.tsx";
import {
	MySelect,
	MySelectItem,
	MySelectLabel,
	MySelectOpenIndicator,
	MySelectPopover,
	MySelectPopoverContent,
	MySelectPopoverScrollableArea,
	MySelectTrigger,
} from "@/components/my-select.tsx";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";

export const ServiceAccountSelect = memo(function ServiceAccountSelect(props: {
	value: app_convex_Id<"access_control_service_accounts"> | null;
	onChange: (value: app_convex_Id<"access_control_service_accounts"> | null) => void;
	label?: string;
	emptyLabel?: string;
	disabled?: boolean;
}) {
	const { value, onChange, label = "Service account", emptyLabel = "Choose a service account", disabled } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const accounts = usePaginatedQuery(
		app_convex_api.access_control.list_service_accounts,
		{ membershipId, includeRevoked: false },
		{ initialNumItems: 50 },
	);
	const selected = useQuery(
		app_convex_api.access_control.get_service_account,
		value ? { membershipId, serviceAccountId: value } : "skip",
	);

	return (
		<div>
			<MySelect
				value={value ?? ""}
				setValue={(next) =>
					onChange(next ? (accounts.results.find((account) => account._id === next)?._id ?? value) : null)
				}
			>
				<MySelectLabel>{label}</MySelectLabel>
				<MySelectTrigger disabled={disabled || accounts.status === "LoadingFirstPage"}>
					<MyButton variant="outline">
						{value ? (selected?.revokedAt === null ? selected.name : "Service account unavailable") : emptyLabel}
						<MySelectOpenIndicator />
					</MyButton>
				</MySelectTrigger>
				<MySelectPopover>
					<MySelectPopoverScrollableArea>
						<MySelectPopoverContent>
							<MySelectItem value="">{emptyLabel}</MySelectItem>
							{accounts.results.map((account) => (
								<MySelectItem key={account._id} value={account._id}>
									{account.name}
								</MySelectItem>
							))}
						</MySelectPopoverContent>
					</MySelectPopoverScrollableArea>
				</MySelectPopover>
			</MySelect>
			{accounts.status === "CanLoadMore" || accounts.status === "LoadingMore" ? (
				<MyButton variant="ghost" disabled={accounts.status === "LoadingMore"} onClick={() => accounts.loadMore(50)}>
					{accounts.status === "LoadingMore" ? "Loading accounts…" : "Load more accounts"}
				</MyButton>
			) : null}
		</div>
	);
});
