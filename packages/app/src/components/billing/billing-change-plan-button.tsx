import { useConvex } from "convex/react";
import { memo, useState, type ComponentProps, type ReactNode } from "react";
import { toast } from "sonner";

import { MyButton } from "@/components/my-button.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";

export type BillingChangePlanButton_Props = {
	productId: string;
	variant?: ComponentProps<typeof MyButton>["variant"];
	children: ReactNode;
};

export const BillingChangePlanButton = memo(function BillingChangePlanButton(props: BillingChangePlanButton_Props) {
	const { productId, variant = "accent", children } = props;

	const convex = useConvex();
	const [isLoading, setIsLoading] = useState(false);

	const handleClick = () => {
		if (isLoading) {
			return;
		}

		setIsLoading(true);

		void convex
			.action(app_convex_api.billing.change_current_subscription, {
				productId,
			})
			.then((result) => {
				if (result._nay) {
					console.error("[BillingChangePlanButton] Failed to change subscription", {
						result,
						productId,
					});
					toast.error(result._nay.message ?? "Could not change the plan");
					return;
				}
			})
			.catch((error: unknown) => {
				console.error("[BillingChangePlanButton] Failed to change subscription", { error, productId });
				const message = error instanceof Error ? error.message : "Could not change the plan";
				toast.error(message);
			})
			.finally(() => {
				setIsLoading(false);
			});
	};

	return (
		<MyButton type="button" variant={variant} disabled={isLoading} aria-busy={isLoading} onClick={handleClick}>
			{children}
		</MyButton>
	);
});
