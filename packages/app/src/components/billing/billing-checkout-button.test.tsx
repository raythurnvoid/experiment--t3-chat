import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { actionMock, toastErrorMock } = vi.hoisted(() => {
	return {
		actionMock: vi.fn(),
		toastErrorMock: vi.fn(),
	};
});

type MockButton_Props = ComponentProps<"button">;

vi.mock("convex/react", () => ({
	useConvex: () => ({
		action: actionMock,
	}),
}));

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

import { BillingCheckoutButton } from "./billing-checkout-button.tsx";

describe("BillingCheckoutButton", () => {
	beforeEach(() => {
		actionMock.mockReset();
		toastErrorMock.mockReset();
		vi.spyOn(window, "open").mockImplementation(() => null);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("opens the checkout URL when the action returns yay", async () => {
		actionMock.mockResolvedValue({
			_yay: {
				url: "https://checkout.test/session",
			},
		});

		render(<BillingCheckoutButton productId="prod_checkout" />);

		fireEvent.click(screen.getByRole("button", { name: "Select plan" }));

		await waitFor(() => {
			expect(window.open).toHaveBeenCalledWith("https://checkout.test/session", "_blank", "noopener,noreferrer");
		});
	});

	test("shows a toast when the action returns nay", async () => {
		actionMock.mockResolvedValue({
			_nay: {
				message: "Origin is not allowed for checkout",
			},
		});

		render(<BillingCheckoutButton productId="prod_checkout" />);

		fireEvent.click(screen.getByRole("button", { name: "Select plan" }));

		await waitFor(() => {
			expect(toastErrorMock).toHaveBeenCalledWith("Origin is not allowed for checkout");
		});
		expect(window.open).not.toHaveBeenCalled();
	});
});
