import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { app_convex_api } from "@/lib/app-convex-client.ts";

const { actionMock, toastErrorMock } = vi.hoisted(() => {
	return {
		actionMock: vi.fn(),
		toastErrorMock: vi.fn(),
	};
});

type MockButton_Props = ComponentProps<"button">;

vi.mock("convex/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("convex/react")>();

	return {
		...actual,
		useConvex: () => ({
			action: actionMock,
		}),
	};
});

vi.mock("sonner", () => ({
	toast: {
		error: toastErrorMock,
	},
}));

vi.mock("@/components/my-button.tsx", () => ({
	MyButton: function MyButton(props: MockButton_Props) {
		return <button {...props} />;
	},
}));

import { BillingChangePlanButton } from "./billing-change-plan-button.tsx";

describe("BillingChangePlanButton", () => {
	beforeEach(() => {
		actionMock.mockReset();
		toastErrorMock.mockReset();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	test("calls change_current_subscription with the target product id", async () => {
		actionMock.mockResolvedValue({
			_yay: null,
		});

		render(<BillingChangePlanButton productId="prod_change">Upgrade</BillingChangePlanButton>);

		fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));

		await waitFor(() => {
			expect(actionMock).toHaveBeenCalledWith(app_convex_api.billing.change_current_subscription, {
				productId: "prod_change",
			});
		});
	});

	test("shows a toast when the action returns nay", async () => {
		actionMock.mockResolvedValue({
			_nay: {
				message: "Subscription is locked and cannot be changed right now",
			},
		});

		render(<BillingChangePlanButton productId="prod_change">Upgrade</BillingChangePlanButton>);

		fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));

		await waitFor(() => {
			expect(toastErrorMock).toHaveBeenCalledWith("Subscription is locked and cannot be changed right now");
		});
	});
});
