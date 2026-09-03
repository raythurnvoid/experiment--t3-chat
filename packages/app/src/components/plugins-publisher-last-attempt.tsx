import { memo } from "react";

import { MyBadge } from "@/components/my-badge.tsx";
import { format_datetime } from "@/lib/date.ts";
import { cn } from "@/lib/utils.ts";
import "./plugins-publisher-last-attempt.css";

type PublisherLastAttempt = {
	at: number;
	pluginName: string | null;
	status: "succeeded" | "rejected" | "flagged" | "failed";
	message: string;
};

/**
 * Show a publish attempt only when it still needs the publisher's attention.
 *
 * A succeeded attempt is hidden because the card already shows the version it produced. Everything
 * else stays on the card, including on a repository that has published before, because the toast
 * that reported the failure is long gone by the time the publisher looks again.
 */
function plugins_publisher_get_visible_last_attempt(lastPublishAttempt: PublisherLastAttempt | undefined) {
	if (!lastPublishAttempt || lastPublishAttempt.status === "succeeded") {
		return undefined;
	}

	return lastPublishAttempt;
}

type PluginsPublisherLastAttempt_ClassNames = "PluginsPublisherLastAttempt" | "PluginsPublisherLastAttempt-message";

type PluginsPublisherLastAttempt_Props = {
	attempt: PublisherLastAttempt | undefined;
};

export const PluginsPublisherLastAttempt = memo(function PluginsPublisherLastAttempt(
	props: PluginsPublisherLastAttempt_Props,
) {
	const attempt = plugins_publisher_get_visible_last_attempt(props.attempt);
	if (!attempt) {
		return null;
	}

	// A publish that failed before the manifest was read has no plugin name. Say "this repository" so
	// the line does not read as a failure of whichever plugin the card above happens to show.
	const pluginOrRepository = attempt.pluginName ?? "this repository";

	return (
		<span className={cn("PluginsPublisherLastAttempt" satisfies PluginsPublisherLastAttempt_ClassNames)}>
			<MyBadge variant={attempt.status === "flagged" ? "outline" : "destructive"}>{attempt.status}</MyBadge>
			<span className={cn("PluginsPublisherLastAttempt-message" satisfies PluginsPublisherLastAttempt_ClassNames)}>
				Last publish for {pluginOrRepository} {format_datetime(attempt.at)} · {attempt.message}
			</span>
		</span>
	);
});

if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, expect, test } = import.meta.vitest;

	const attempt_of = (overrides: Partial<PublisherLastAttempt> = {}): PublisherLastAttempt => ({
		at: 1234,
		pluginName: "gallery",
		status: "failed",
		message: "Artifact file hash mismatch",
		...overrides,
	});

	describe("plugins_publisher_get_visible_last_attempt", () => {
		test.each([
			["failed", attempt_of({ status: "failed" }), true],
			["rejected", attempt_of({ status: "rejected" }), true],
			["flagged", attempt_of({ status: "flagged" }), true],
			["succeeded", attempt_of({ status: "succeeded" }), false],
			["missing", undefined, false],
		] as const)("filters a %s attempt", (_label, attempt, visible) => {
			expect(plugins_publisher_get_visible_last_attempt(attempt)).toBe(visible ? attempt : undefined);
		});
	});

	describe("PluginsPublisherLastAttempt", () => {
		const render_attempt = async (attempt: PublisherLastAttempt | undefined) => {
			const { renderToStaticMarkup } = await import("react-dom/server");
			return renderToStaticMarkup(<PluginsPublisherLastAttempt attempt={attempt} />);
		};

		test("names the plugin when a shared repository's publish fails", async () => {
			const html = await render_attempt(attempt_of());

			expect(html).toContain("Last publish for gallery");
			// The status word and the reason are the two things the publisher acts on, so pin both.
			expect(html).toContain("MyBadge-variant-destructive");
			expect(html).toContain("failed");
			expect(html).toContain("Artifact file hash mismatch");
		});

		test("blames the repository when the publish failed before the manifest was read", async () => {
			const html = await render_attempt(attempt_of({ pluginName: null }));

			expect(html).toContain("Last publish for this repository");
			expect(html).not.toContain("for null");
		});

		test("marks a flagged attempt without the failure colour", async () => {
			const html = await render_attempt(attempt_of({ status: "flagged" }));

			expect(html).toContain("MyBadge-variant-outline");
			expect(html).not.toContain("MyBadge-variant-destructive");
		});

		test("renders nothing when there is no attempt", async () => {
			expect(await render_attempt(undefined)).toBe("");
		});
	});
}
