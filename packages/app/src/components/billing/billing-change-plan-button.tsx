import { useConvex } from "convex/react";
import { memo, useState, type ComponentProps } from "react";
import { toast } from "sonner";

import { MyButton } from "@/components/my-button.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";

export type BillingChangePlanButton_Props = {
	productId: string;
	variant?: ComponentProps<typeof MyButton>["variant"];
	label: string;
	/**
	 * The plan this button moves to. Two cards can carry the same visible label, for example
	 * "Downgrade at renewal" on a `Pro` account, so the accessible name has to say which plan.
	 */
	planDisplayName: string;
};

export const BillingChangePlanButton = memo(function BillingChangePlanButton(props: BillingChangePlanButton_Props) {
	const { productId, variant = "accent", label, planDisplayName } = props;

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
				// A rejection here is unexpected, so its message is not user-facing text.
				toast.error("Could not change the plan");
			})
			.finally(() => {
				setIsLoading(false);
			});
	};

	return (
		<MyButton
			type="button"
			variant={variant}
			disabled={isLoading}
			aria-busy={isLoading}
			// Keep the visible text at the start of the accessible name, so speech input still
			// activates the button by what the user reads on it.
			aria-label={`${label}: ${planDisplayName}`}
			onClick={handleClick}
		>
			{label}
		</MyButton>
	);
});
