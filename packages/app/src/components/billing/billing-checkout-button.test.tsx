import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MockInstance } from "vitest";

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

import { BillingCheckoutButton } from "./billing-checkout-button.tsx";

describe("BillingCheckoutButton", () => {
	let windowOpenSpy: MockInstance<typeof window.open>;

	beforeEach(() => {
		actionMock.mockReset();
		toastErrorMock.mockReset();
		windowOpenSpy = vi.spyOn(window, "open").mockImplementation(() => null);
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	test("opens the checkout URL when the action returns yay", async () => {
		actionMock.mockResolvedValue({
			_yay: {
				url: "https://checkout.test/session",
			},
		});

		render(<BillingCheckoutButton productId="prod_checkout" planDisplayName="Pro" />);

		fireEvent.click(screen.getByRole("button", { name: "Select plan: Pro" }));

		await waitFor(() => {
			expect(windowOpenSpy).toHaveBeenCalledWith("https://checkout.test/session", "_blank", "noopener,noreferrer");
		});
	});

	test("names each plan, so two cards never read as the same button", () => {
		render(
			<>
				<BillingCheckoutButton productId="prod_payg" planDisplayName="Pay As You Go" />
				<BillingCheckoutButton productId="prod_pro" planDisplayName="Pro" />
			</>,
		);

		// The visible text is the same on both cards, so the plan name is what a screen reader tells
		// them apart by. `getByRole` also fails when two buttons share a name.
		expect(screen.getByRole("button", { name: "Select plan: Pay As You Go" })).not.toBeNull();
		expect(screen.getByRole("button", { name: "Select plan: Pro" })).not.toBeNull();
		expect(screen.getAllByText("Select plan")).toHaveLength(2);
	});

	test("passes subscriptionId when provided", async () => {
		actionMock.mockResolvedValue({
			_yay: {
				url: "https://checkout.test/session",
			},
		});

		render(<BillingCheckoutButton productId="prod_checkout" subscriptionId="sub_free" planDisplayName="Pro" />);

		fireEvent.click(screen.getByRole("button", { name: "Select plan: Pro" }));

		await waitFor(() => {
			expect(actionMock).toHaveBeenCalledWith(app_convex_api.billing.generate_checkout_link, {
				productId: "prod_checkout",
				origin: window.location.origin,
				successUrl: window.location.href,
				subscriptionId: "sub_free",
			});
		});
	});

	test("shows a toast when the action returns nay", async () => {
		actionMock.mockResolvedValue({
			_nay: {
				message: "Origin is not allowed for checkout",
			},
		});

		render(<BillingCheckoutButton productId="prod_checkout" planDisplayName="Pro" />);

		fireEvent.click(screen.getByRole("button", { name: "Select plan: Pro" }));

		await waitFor(() => {
			expect(toastErrorMock).toHaveBeenCalledWith("Origin is not allowed for checkout");
		});
		expect(windowOpenSpy).not.toHaveBeenCalled();
	});

	test("shows a stable toast when the action rejects unexpectedly", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		actionMock.mockRejectedValue(new Error("[Request ID: abc] Server Error"));

		render(<BillingCheckoutButton productId="prod_checkout" planDisplayName="Pro" />);

		fireEvent.click(screen.getByRole("button", { name: "Select plan: Pro" }));

		// A rejection is unexpected, so the raw error text must never reach the toast.
		await waitFor(() => {
			expect(toastErrorMock).toHaveBeenCalledWith("Could not start checkout");
		});
		expect(windowOpenSpy).not.toHaveBeenCalled();
		expect(consoleErrorSpy).toHaveBeenCalled();
	});
});
