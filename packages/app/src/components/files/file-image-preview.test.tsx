import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ComponentProps } from "react";
import { FileImagePreview } from "./file-image-preview.tsx";

const { action } = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock("@/lib/app-convex-client.ts", async () => {
	const { api } = await import("../../../convex/_generated/api.js");
	return { app_convex_api: api, app_convex: { action } };
});
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: { useContext: () => ({ membershipId: "membership_1" }) },
}));

const target = {
	kind: "private",
	id: "private_1",
	pendingUpdateId: "proposal_1",
	reviewedRevision: 2,
	creationGeneration: 3,
} as ComponentProps<typeof FileImagePreview>["target"];

beforeEach(() => {
	action.mockReset();
	action.mockResolvedValue({ _yay: { url: "https://images.test/first.png" } });
});
afterEach(cleanup);

describe("FileImagePreview", () => {
	test("loads the exact private proposal and announces image loading", async () => {
		render(<FileImagePreview target={target} alt="Capture one" />);

		expect(screen.getByRole("status").textContent).toBe("Loading image…");

		const image = await screen.findByRole("img", { name: "Capture one" });

		// Send the exact draft versions this view shows. The server refuses the URL when the draft
		// changed after that, so the user never sees a picture from a newer version by mistake.
		expect(getFunctionName(action.mock.calls[0]![0])).toBe("files_pending_updates:create_private_pending_download_url");
		expect(action.mock.calls[0]![1]).toEqual({
			membershipId: "membership_1",
			target: { kind: "private", id: "private_1" },
			pendingUpdateId: "proposal_1",
			reviewedRevision: 2,
			creationGeneration: 3,
		});

		fireEvent.load(image);

		expect(screen.queryByRole("status")).toBeNull();
	});

	test("retries a broken image with a fresh signed URL", async () => {
		render(<FileImagePreview target={target} alt="Capture one" />);
		fireEvent.error(await screen.findByRole("img"));

		expect(screen.getByRole("alert").textContent).toContain("could not be loaded");

		action.mockResolvedValue({ _yay: { url: "https://images.test/retry.png" } });
		const retry = screen.getByRole("button", { name: "Retry image" });
		retry.focus();
		fireEvent.click(retry);

		expect(await screen.findByRole("img")).toHaveProperty("src", "https://images.test/retry.png");

		// Retry unmounts its own button, so keyboard focus would be lost. It moves to the preview
		// container, which stays mounted and carries the same label.
		expect(document.activeElement?.getAttribute("aria-label")).toBe("Capture one");
		expect(action).toHaveBeenCalledTimes(2);
	});

	test("keeps an access refusal visible without rendering an image", async () => {
		action.mockResolvedValue({ _nay: { message: "This draft changed. Open it again." } });

		render(<FileImagePreview target={target} alt="Capture one" />);

		expect(await screen.findByRole("alert")).toHaveProperty("textContent", "This draft changed. Open it again.");
		expect(screen.queryByRole("img")).toBeNull();
	});

	// The first request is still waiting when the view switches to another file. Its answer must be
	// thrown away, or the old picture would replace the one the user is looking at now.
	test("ignores a late private response after opening the saved file", async () => {
		let resolvePrivate!: (value: { _yay: { url: string } }) => void;
		action.mockReturnValueOnce(
			new Promise((resolve) => {
				resolvePrivate = resolve;
			}),
		);
		const { rerender } = render(<FileImagePreview target={target} alt="Capture one" />);
		const savedTarget = { kind: "saved", id: "saved_1", assetId: "asset_1" } as ComponentProps<
			typeof FileImagePreview
		>["target"];
		rerender(<FileImagePreview target={savedTarget} alt="Saved capture" />);

		await waitFor(() => expect(screen.getByRole("img")).toHaveProperty("src", "https://images.test/first.png"));
		expect(getFunctionName(action.mock.calls[1]![0])).toBe("r2:create_signed_download_url");

		await act(async () => resolvePrivate({ _yay: { url: "https://images.test/stale.png" } }));

		expect(screen.getByRole("img")).toHaveProperty("src", "https://images.test/first.png");
	});
});
