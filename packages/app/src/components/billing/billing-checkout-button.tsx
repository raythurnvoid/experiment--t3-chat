import { useConvex } from "convex/react";
import { memo, useState } from "react";
import { toast } from "sonner";

import { MyButton } from "@/components/my-button.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";

export type BillingCheckoutButton_Props = {
	productId: string;
};

export const BillingCheckoutButton = memo(function BillingCheckoutButton(props: BillingCheckoutButton_Props) {
	const { productId } = props;

	const convex = useConvex();
	const [isLoading, setIsLoading] = useState(false);

	const handleClick = () => {
		if (isLoading) {
			return;
		}

		setIsLoading(true);

		void convex
			.action(app_convex_api.billing.generate_checkout_link, {
				productIds: [productId],
				origin: window.location.origin,
				successUrl: window.location.href,
			})
			.then((result) => {
				window.open(result.url, "_blank", "noopener,noreferrer");
			})
			.catch((error: unknown) => {
				console.error("[BillingCheckoutButton] Failed to generate checkout link", { error, productId });
				const message = error instanceof Error ? error.message : "Could not start checkout";
				toast.error(message);
			})
			.finally(() => {
				setIsLoading(false);
			});
	};

	return (
		<MyButton type="button" variant="accent" disabled={isLoading} aria-busy={isLoading} onClick={handleClick}>
			Select plan
		</MyButton>
	);
});
