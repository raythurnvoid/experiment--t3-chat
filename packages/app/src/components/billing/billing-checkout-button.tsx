import { useConvex } from "convex/react";
import { memo, useState } from "react";
import { toast } from "sonner";

import { MyButton } from "@/components/my-button.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";

export type BillingCheckoutButton_Props = {
	productId: string;
	subscriptionId?: string;
	/**
	 * The plan this button buys. Every plan card renders the same visible "Select plan" text, so the
	 * accessible name has to say which plan, or a screen reader reads the same button twice.
	 */
	planDisplayName: string;
};

export const BillingCheckoutButton = memo(function BillingCheckoutButton(props: BillingCheckoutButton_Props) {
	const { productId, subscriptionId, planDisplayName } = props;

	const convex = useConvex();
	const [isLoading, setIsLoading] = useState(false);

	const handleClick = () => {
		if (isLoading) {
			return;
		}

		setIsLoading(true);

		void convex
			.action(app_convex_api.billing.generate_checkout_link, {
				productId,
				origin: window.location.origin,
				successUrl: window.location.href,
				subscriptionId,
			})
			.then((result) => {
				if (result._nay) {
					console.error("[BillingCheckoutButton] Failed to generate checkout link", {
						result,
						productId,
					});
					toast.error(result._nay.message ?? "Could not start checkout");
					return;
				}

				window.open(result._yay.url, "_blank", "noopener,noreferrer");
			})
			.catch((error: unknown) => {
				console.error("[BillingCheckoutButton] Failed to generate checkout link", { error, productId });
				// A rejection here is unexpected, so its message is not user-facing text.
				toast.error("Could not start checkout");
			})
			.finally(() => {
				setIsLoading(false);
			});
	};

	return (
		<MyButton
			type="button"
			variant="accent"
			disabled={isLoading}
			aria-busy={isLoading}
			// Keep the visible text at the start of the accessible name, so speech input still
			// activates the button by what the user reads on it.
			aria-label={`Select plan: ${planDisplayName}`}
			onClick={handleClick}
		>
			Select plan
		</MyButton>
	);
});
