import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { viewStore } = vi.hoisted(() => {
	let value: unknown = undefined;
	const listeners = new Set<() => void>();

	return {
		// The live query result. Tests deliver a new result the way Convex would, while the page is open.
		viewStore: {
			get: () => value,
			set: (next: unknown) => {
				value = next;
				for (const listener of listeners) {
					listener();
				}
			},
			subscribe: (listener: () => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
	};
});

vi.mock("convex/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("convex/react")>();
	const { useSyncExternalStore } = await import("react");

	return {
		...actual,
		useQuery: () => {
			const value = useSyncExternalStore(viewStore.subscribe, viewStore.get);
			// Throw a stored error the way Convex throws a failed query.
			if (value instanceof Error) {
				throw value;
			}
			return value;
		},
	};
});

import type { Editor } from "@tiptap/core";

import { app_convex } from "@/lib/app-convex-client.ts";
import { files_share_rich_text_finish, files_share_rich_text_prepare } from "../../../shared/files-share-rich-text.ts";
import { FilesSharePage } from "./files-share-page.tsx";

type SignArgs = {
	token: string;
	revision: string;
	targets: Array<{ kind: "file" } | { kind: "embed"; index: number }>;
};

type SignResult =
	| {
			_yay: {
				status: "ready";
				revision: string;
				urls: Array<{ target: SignArgs["targets"][number]; url: string; expiresAt: number }>;
			};
	  }
	| { _yay: { status: "stale" } }
	| { _nay: { message: string; data?: { retryAfterMs: number } } };

/**
 * Every signing call the page made. Each one waits until the test releases it, so a test can change
 * the live view while a call is still running.
 */
let signCalls: Array<{ args: SignArgs; release: (result: SignResult) => Promise<void> }> = [];

const R1 = "1".repeat(64);
const R2 = "2".repeat(64);

function rich_view(args: { markdown: string; available: number[]; revision: string }) {
	const prepared = files_share_rich_text_prepare({ text: args.markdown, textKind: "rich_text" });
	if (prepared._nay) {
		throw new Error("Failed to prepare test Markdown", { cause: prepared._nay });
	}

	return {
		name: "notes.md",
		textKind: "rich_text" as const,
		contentType: "text/markdown",
		size: args.markdown.length,
		content: files_share_rich_text_finish({
			prepared: prepared._yay,
			isMediaAvailable: (index) => args.available.includes(index),
		}),
		media: prepared._yay.media.map((item, index) =>
			args.available.includes(index)
				? { index, available: true as const, kind: item.kind }
				: { index, available: false as const },
		),
		revision: args.revision,
	};
}

function binary_view(contentType: string) {
	return {
		name: "file.bin",
		textKind: null,
		contentType,
		size: 2048,
		content: { kind: "binary" as const },
		media: [],
		revision: R1,
	};
}

function ready(args: SignArgs, url: string): SignResult {
	return {
		_yay: {
			status: "ready",
			revision: args.revision,
			urls: args.targets.map((target) => ({ target, url, expiresAt: Date.now() + 15 * 60 * 1000 })),
		},
	};
}

function share_state() {
	return document.querySelector("[data-share-page-state]")?.getAttribute("data-share-page-state");
}

async function find_editor() {
	const dom = await waitFor(() => {
		const element = document.querySelector<HTMLElement & { editor?: Editor }>(".ProseMirror");
		expect(element?.editor).toBeDefined();
		return element!;
	});
	return dom.editor!;
}

function render_page() {
	return render(
		<StrictMode>
			<FilesSharePage token="tok_1" />
		</StrictMode>,
	);
}

beforeEach(() => {
	viewStore.set(undefined);
	signCalls = [];
	vi.spyOn(app_convex, "action").mockImplementation(((_reference: unknown, args: SignArgs) => {
		return new Promise((resolve) => {
			signCalls.push({
				args,
				release: async (result) => {
					await act(async () => {
						resolve(result);
					});
				},
			});
		});
	}) as never);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("FilesSharePage", () => {
	test("shows loading, then the shared plain text without a Download button", () => {
		render_page();

		expect(share_state()).toBe("loading");
		expect(screen.getByText("Opening the shared file")).not.toBeNull();

		act(() => {
			viewStore.set({
				name: "notes.txt",
				textKind: "plain_text",
				contentType: "text/plain",
				size: 12,
				content: { kind: "plain_text", text: "Hello\nworld", formattingFallback: false },
				media: [],
				revision: R1,
			});
		});

		expect(share_state()).toBe("ready");
		expect(screen.getByRole("heading", { name: "notes.txt" })).not.toBeNull();
		expect(document.querySelector("pre")?.textContent).toBe("Hello\nworld");
		expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
		expect(screen.queryByText(/a lot of formatting/)).toBeNull();
		expect(signCalls).toHaveLength(0);
	});

	test("says why a rich file shows as plain text", () => {
		render_page();
		act(() => {
			viewStore.set({
				name: "big.md",
				textKind: "rich_text",
				contentType: "text/markdown",
				size: 12,
				content: { kind: "plain_text", text: "Visible text", formattingFallback: true },
				media: [],
				revision: R1,
			});
		});

		expect(screen.getByText("Shown as plain text because this file has a lot of formatting.")).not.toBeNull();
		expect(document.querySelector("pre")?.textContent).toBe("Visible text");
	});

	test("shows one generic message for a missing link and for JSON that fails the public schema", () => {
		render_page();
		act(() => {
			viewStore.set(null);
		});

		expect(share_state()).toBe("unavailable");
		expect(screen.getByText("This link does not work.")).not.toBeNull();

		act(() => {
			viewStore.set({
				...rich_view({ markdown: "Hello\n", available: [], revision: R1 }),
				content: { kind: "rich_text", json: JSON.stringify({ type: "doc", content: [{ type: "script" }] }) },
			});
		});

		expect(share_state()).toBe("unavailable");
		expect(document.querySelector(".ProseMirror")).toBeNull();
	});

	test("shows the generic message without error details when the live query throws", () => {
		// React logs the caught error in tests. Keep the output quiet.
		vi.spyOn(console, "error").mockImplementation(() => {});
		render_page();

		act(() => {
			viewStore.set(new Error("secret tok_1"));
		});

		expect(share_state()).toBe("unavailable");
		expect(document.body.textContent).not.toContain("secret");
		expect(document.body.textContent).not.toContain("tok_1");
	});

	test("starts keyboard focus on the main region and sends no referrer while open", () => {
		const meta = document.createElement("meta");
		meta.name = "referrer";
		meta.content = "strict-origin-when-cross-origin";
		document.head.append(meta);

		const { unmount } = render_page();

		expect(document.activeElement?.tagName).toBe("MAIN");
		expect(meta.content).toBe("no-referrer");

		unmount();
		expect(meta.content).toBe("strict-origin-when-cross-origin");
		meta.remove();
	});

	test("renders the server document exactly, without adding link marks", async () => {
		// Autolink checks only the last word of the first changed paragraph, so end that paragraph with a plain
		// URL. Build the JSON by hand, because the Markdown step would already turn the URL into a link.
		const first = {
			...rich_view({ markdown: "Hello\n", available: [], revision: R1 }),
			content: {
				kind: "rich_text" as const,
				json: JSON.stringify({
					type: "doc",
					content: [
						{
							type: "paragraph",
							attrs: { textAlign: null },
							content: [{ type: "text", text: "Mail a@b.example or ftp://files.example or read https://x.example/" }],
						},
						{
							type: "paragraph",
							attrs: { textAlign: null },
							content: [{ type: "text", text: "Second paragraph." }],
						},
					],
				}),
			},
		};
		render_page();
		act(() => {
			viewStore.set(first);
		});

		const editor = await find_editor();
		expect(editor.getJSON()).toEqual(JSON.parse((first.content as { json: string }).json));
		expect(document.querySelector(".ProseMirror a")).toBeNull();
		expect(editor.isEditable).toBe(false);

		const second = rich_view({
			markdown: "# New title\n\nWrite to ops@c.example or ftp://x.example\n\nThe end.\n",
			available: [],
			revision: R2,
		});
		act(() => {
			viewStore.set(second);
		});

		await waitFor(() => {
			expect(editor.getJSON()).toEqual(JSON.parse((second.content as { json: string }).json));
		});
		expect(document.querySelector(".ProseMirror a")).toBeNull();
	});

	test("keeps task checkboxes read-only", async () => {
		render_page();
		act(() => {
			viewStore.set(rich_view({ markdown: "- [ ] Buy milk\n", available: [], revision: R1 }));
		});

		const editor = await find_editor();
		const checkbox = await waitFor(() => {
			const element = document.querySelector<HTMLInputElement>('.ProseMirror input[type="checkbox"]');
			expect(element).not.toBeNull();
			return element!;
		});

		fireEvent.click(checkbox);
		fireEvent.keyDown(checkbox, { key: " ", code: "Space" });

		expect(checkbox.checked).toBe(false);
		expect(JSON.stringify(editor.getJSON())).toContain('"checked":false');
	});

	test("signs every available media in one call and shows a fixed box for the others", async () => {
		render_page();
		act(() => {
			viewStore.set(
				rich_view({
					markdown: "![Photo](bonobo-file://saved_1) ![Secret name](bonobo-file://saved_2)\n",
					available: [0],
					revision: R1,
				}),
			);
		});
		await find_editor();

		expect(signCalls.map((call) => call.args)).toEqual([
			{ token: "tok_1", revision: R1, targets: [{ kind: "embed", index: 0 }] },
		]);
		expect(await screen.findByText("This image is not shared")).not.toBeNull();
		expect(screen.getByText("Loading image")).not.toBeNull();

		await signCalls[0]!.release(ready(signCalls[0]!.args, "https://r2.test/photo"));

		const image = await screen.findByRole("img", { name: "Photo" });
		expect(image.getAttribute("src")).toBe("https://r2.test/photo");
		expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
		expect(document.body.textContent).not.toContain("Secret name");
	});

	test("drops a late URL after only the media becomes unavailable", async () => {
		render_page();
		const markdown = "Text ![Photo](bonobo-file://saved_1)\n";
		act(() => {
			viewStore.set(rich_view({ markdown, available: [0], revision: R1 }));
		});
		await find_editor();
		expect(signCalls).toHaveLength(1);

		act(() => {
			viewStore.set(rich_view({ markdown, available: [], revision: R2 }));
		});
		await signCalls[0]!.release(ready(signCalls[0]!.args, "https://r2.test/photo"));

		expect(await screen.findByText("This image is not shared")).not.toBeNull();
		expect(document.querySelector('img[src="https://r2.test/photo"]')).toBeNull();
		expect(document.body.innerHTML).not.toContain("Photo");
		expect(signCalls).toHaveLength(1);
	});

	test("drops a late URL after the link is turned off", async () => {
		render_page();
		act(() => {
			viewStore.set(rich_view({ markdown: "![Photo](bonobo-file://saved_1)\n", available: [0], revision: R1 }));
		});
		await find_editor();

		act(() => {
			viewStore.set(null);
		});
		expect(share_state()).toBe("unavailable");

		// The same revision comes back, for example after a file job ends. The old call belongs to the gone
		// view, so the page asks again and drops the old answer.
		act(() => {
			viewStore.set(rich_view({ markdown: "![Photo](bonobo-file://saved_1)\n", available: [0], revision: R1 }));
		});
		await find_editor();
		await signCalls[0]!.release(ready(signCalls[0]!.args, "https://r2.test/photo"));

		expect(signCalls).toHaveLength(2);
		expect(document.querySelector('img[src="https://r2.test/photo"]')).toBeNull();
	});

	test("clears old URLs on a new revision and signs once for it", async () => {
		render_page();
		const markdown = "![Photo](bonobo-file://saved_1)\n";
		act(() => {
			viewStore.set(rich_view({ markdown, available: [0], revision: R1 }));
		});
		await find_editor();
		await signCalls[0]!.release(ready(signCalls[0]!.args, "https://r2.test/old"));
		await screen.findByRole("img", { name: "Photo" });

		act(() => {
			viewStore.set(rich_view({ markdown: `${markdown}\nMore.\n`, available: [0], revision: R2 }));
		});

		expect(document.querySelector('img[src="https://r2.test/old"]')).toBeNull();
		expect(signCalls.map((call) => call.args.revision)).toEqual([R1, R2]);

		await signCalls[1]!.release(ready(signCalls[1]!.args, "https://r2.test/new"));
		expect((await screen.findByRole("img", { name: "Photo" })).getAttribute("src")).toBe("https://r2.test/new");
	});

	test("asks once for a stale revision and again only when the query delivers it again", async () => {
		render_page();
		const markdown = "![Photo](bonobo-file://saved_1)\n";
		act(() => {
			viewStore.set(rich_view({ markdown, available: [0], revision: R1 }));
		});
		await find_editor();
		await signCalls[0]!.release({ _yay: { status: "stale" } });

		// The page waits for the next revision and offers no Retry for R1.
		act(() => {
			viewStore.set(rich_view({ markdown, available: [0], revision: R1 }));
		});
		expect(screen.queryByRole("button", { name: "Retry media" })).toBeNull();
		expect(signCalls).toHaveLength(1);

		// The image was archived, then restored, so R1 is current again and must be signed once more.
		act(() => {
			viewStore.set(rich_view({ markdown, available: [], revision: R2 }));
		});
		act(() => {
			viewStore.set(rich_view({ markdown, available: [0], revision: R1 }));
		});
		expect(signCalls.map((call) => call.args.revision)).toEqual([R1, R1]);
		await signCalls[1]!.release(ready(signCalls[1]!.args, "https://r2.test/r1"));
		expect((await screen.findByRole("img", { name: "Photo" })).getAttribute("src")).toBe("https://r2.test/r1");
	});

	test("shows no URL of another revision while a stale revision waits", async () => {
		render_page();
		const markdown = "![Photo](bonobo-file://saved_1)\n";
		act(() => {
			viewStore.set(rich_view({ markdown, available: [0], revision: R1 }));
		});
		await find_editor();
		act(() => {
			viewStore.set(rich_view({ markdown, available: [0], revision: R2 }));
		});
		await signCalls[1]!.release({ _yay: { status: "stale" } });

		// The query delivers R1 again, then R2 again. R2 is asked for once more, and R1's URL must not
		// show while it loads.
		act(() => {
			viewStore.set(rich_view({ markdown, available: [0], revision: R1 }));
		});
		await signCalls[2]!.release(ready(signCalls[2]!.args, "https://r2.test/r1"));
		await screen.findByRole("img", { name: "Photo" });
		act(() => {
			viewStore.set(rich_view({ markdown, available: [0], revision: R2 }));
		});

		expect(document.querySelector("main img")).toBeNull();
		expect(screen.getByText("Loading image")).not.toBeNull();
		expect(signCalls.map((call) => call.args.revision)).toEqual([R1, R2, R1, R2]);
	});

	test("signs once when the view is already loaded on mount", async () => {
		// Strict Mode runs the mount effects twice. The second run must not start a second request.
		viewStore.set(rich_view({ markdown: "![Photo](bonobo-file://saved_1)\n", available: [0], revision: R1 }));
		render_page();
		await find_editor();

		expect(signCalls).toHaveLength(1);
		await signCalls[0]!.release(ready(signCalls[0]!.args, "https://r2.test/photo"));
		expect((await screen.findByRole("img", { name: "Photo" })).getAttribute("src")).toBe("https://r2.test/photo");
	});

	test("drops a result that was asked for an older view of the same revision", async () => {
		render_page();
		const markdown = "![Photo](bonobo-file://saved_1)\n";
		act(() => {
			viewStore.set(rich_view({ markdown, available: [0], revision: R1 }));
		});
		await find_editor();
		act(() => {
			viewStore.set(rich_view({ markdown, available: [0], revision: R2 }));
		});
		act(() => {
			viewStore.set(rich_view({ markdown, available: [0], revision: R1 }));
		});
		expect(signCalls.map((call) => call.args.revision)).toEqual([R1, R2, R1]);

		await signCalls[0]!.release(ready(signCalls[0]!.args, "https://r2.test/first-view"));
		expect(document.querySelector("main img")).toBeNull();

		await signCalls[2]!.release(ready(signCalls[2]!.args, "https://r2.test/third-view"));
		expect((await screen.findByRole("img", { name: "Photo" })).getAttribute("src")).toBe("https://r2.test/third-view");
	});

	test("waits out a rate limit before it offers Retry, and never retries by itself", async () => {
		render_page();
		act(() => {
			viewStore.set(rich_view({ markdown: "![Photo](bonobo-file://saved_1)\n", available: [0], revision: R1 }));
		});
		await find_editor();

		vi.useFakeTimers();
		await signCalls[0]!.release({ _nay: { message: "Rate limited", data: { retryAfterMs: 5_000 } } });

		expect(screen.getByText(/Many people are opening this link/)).not.toBeNull();
		expect(screen.queryByRole("button", { name: "Retry media" })).toBeNull();

		act(() => {
			vi.advanceTimersByTime(5_000);
		});
		const retry = screen.getByRole("button", { name: "Retry media" });
		expect(signCalls).toHaveLength(1);

		fireEvent.click(retry);
		fireEvent.click(retry);
		expect(signCalls).toHaveLength(2);
		expect(signCalls[1]!.args.targets).toEqual([{ kind: "embed", index: 0 }]);
	});

	test("shows Retry after a generic failure", async () => {
		render_page();
		act(() => {
			viewStore.set(rich_view({ markdown: "![Photo](bonobo-file://saved_1)\n", available: [0], revision: R1 }));
		});
		await find_editor();
		await signCalls[0]!.release({ _nay: { message: "Not found" } });

		const retry = await screen.findByRole("button", { name: "Retry media" });
		const media = retry.closest("[data-share-media-state]");
		fireEvent.click(retry);
		expect(signCalls).toHaveLength(2);

		// The button goes away while the media loads again. Focus stays on the same media node.
		expect(screen.queryByRole("button", { name: "Retry media" })).toBeNull();
		expect(media?.isConnected).toBe(true);
		expect(document.activeElement).toBe(media);
	});

	test("shows Retry after a rejected signing call and logs no error details", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(app_convex, "action").mockImplementationOnce(() => Promise.reject(new Error("tok_1")));

		render_page();
		act(() => {
			viewStore.set(rich_view({ markdown: "![Photo](bonobo-file://saved_1)\n", available: [0], revision: R1 }));
		});
		await find_editor();

		expect(await screen.findByRole("button", { name: "Retry media" })).not.toBeNull();
		// The error message can name the link, so the log keeps only the error name.
		expect(consoleError.mock.calls).toEqual([
			["[useFilesSharePageSignedUrls.request] Failed to sign URLs", { errorName: "Error" }],
		]);
	});

	test("refreshes an expired URL once per issued URL", async () => {
		const now = vi.spyOn(Date, "now");
		let clock = 1_000_000;
		now.mockImplementation(() => clock);

		render_page();
		act(() => {
			viewStore.set(rich_view({ markdown: "![Photo](bonobo-file://saved_1)\n", available: [0], revision: R1 }));
		});
		await find_editor();
		await signCalls[0]!.release(ready(signCalls[0]!.args, "https://r2.test/one"));

		// The first URL runs out: the page asks once for a new one.
		clock += 15 * 60 * 1000;
		fireEvent.error(await screen.findByRole("img", { name: "Photo" }));
		expect(signCalls).toHaveLength(2);
		await signCalls[1]!.release(ready(signCalls[1]!.args, "https://r2.test/two"));

		// The new URL fails before it runs out: that shows Retry, not another request.
		fireEvent.error(await screen.findByRole("img", { name: "Photo" }));
		expect(signCalls).toHaveLength(2);
		fireEvent.click(await screen.findByRole("button", { name: "Retry media" }));
		expect(signCalls).toHaveLength(3);
		await signCalls[2]!.release(ready(signCalls[2]!.args, "https://r2.test/three"));

		// The Retry URL runs out later and gets its own single refresh.
		clock += 15 * 60 * 1000;
		fireEvent.error(await screen.findByRole("img", { name: "Photo" }));
		expect(signCalls).toHaveLength(4);
	});

	test("resumes a playing video where it was after its URL runs out or a new revision loads it", async () => {
		const now = vi.spyOn(Date, "now");
		let clock = 1_000_000;
		now.mockImplementation(() => clock);
		const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
		const playAt = (video: HTMLVideoElement, time: number) => {
			video.currentTime = time;
			Object.defineProperty(video, "readyState", { value: 1 });
			Object.defineProperty(video, "paused", { value: false });
		};

		render_page();
		act(() => {
			viewStore.set(binary_view("video/mp4"));
		});
		await signCalls[0]!.release(ready(signCalls[0]!.args, "https://r2.test/one"));

		const first = document.querySelector("video")!;
		playAt(first, 42);
		clock += 15 * 60 * 1000;
		fireEvent.error(first);
		await signCalls[1]!.release(ready(signCalls[1]!.args, "https://r2.test/two"));

		const second = document.querySelector("video")!;
		expect(second).not.toBe(first);
		fireEvent.loadedMetadata(second);
		expect(second.currentTime).toBe(42);
		expect(play).toHaveBeenCalledTimes(1);

		// A new revision loads the media again with no error. Focus stays on the same media.
		playAt(second, 50);
		second.focus();
		expect(document.activeElement).toBe(second);
		act(() => {
			viewStore.set({ ...binary_view("video/mp4"), revision: R2 });
		});
		const media = document.querySelector("[data-share-media-state]");
		expect(document.activeElement).toBe(media);
		await signCalls[2]!.release(ready(signCalls[2]!.args, "https://r2.test/three"));

		const third = document.querySelector("video")!;
		expect(third).not.toBe(second);
		expect(document.activeElement).toBe(media);
		fireEvent.loadedMetadata(third);
		expect(third.currentTime).toBe(50);
		expect(play).toHaveBeenCalledTimes(2);
	});

	test.each([
		{ markdown: "Only text now.\n", kind: "rich_text" },
		{ markdown: "More text.\n\n".repeat(2100), kind: "plain_text" },
	])("keeps focus on the main region when a saved edit removes a video ($kind)", async ({ markdown, kind }) => {
		render_page();
		act(() => {
			viewStore.set(
				rich_view({ markdown: '<video src="bonobo-file://saved_1"></video>\n', available: [0], revision: R1 }),
			);
		});
		await find_editor();
		await signCalls[0]!.release(ready(signCalls[0]!.args, "https://r2.test/video"));

		const video = document.querySelector("video")!;
		video.focus();
		expect(document.activeElement).toBe(video);
		const next = rich_view({ markdown, available: [], revision: R2 });
		expect(next.content.kind).toBe(kind);
		act(() => {
			viewStore.set(next);
		});

		expect(document.querySelector("video")).toBeNull();
		expect(document.activeElement?.tagName).toBe("MAIN");
	});

	test("shows a supported image file in its viewer and signs it once", async () => {
		render_page();
		act(() => {
			viewStore.set(binary_view("image/png"));
		});

		expect(signCalls.map((call) => call.args.targets)).toEqual([[{ kind: "file" }]]);
		expect(screen.queryByRole("button", { name: "Download" })).toBeNull();

		await signCalls[0]!.release(ready(signCalls[0]!.args, "https://r2.test/file"));
		expect(document.querySelector('img[src="https://r2.test/file"]')).not.toBeNull();
	});

	test.each(["image/svg+xml", "video/x-msvideo", "application/pdf"])(
		"signs a %s file only when the visitor clicks Download",
		async (contentType) => {
			const assign = vi.fn();
			vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign } as Location);

			render_page();
			act(() => {
				viewStore.set(binary_view(contentType));
			});

			expect(document.querySelector("main img, main video")).toBeNull();
			expect(signCalls).toHaveLength(0);

			fireEvent.click(screen.getByRole("button", { name: "Download" }));
			expect(signCalls.map((call) => call.args.targets)).toEqual([[{ kind: "file" }]]);

			await signCalls[0]!.release(ready(signCalls[0]!.args, "https://r2.test/attachment"));
			expect(assign).toHaveBeenCalledWith("https://r2.test/attachment");
			expect(document.querySelector("main img, main video")).toBeNull();
		},
	);

	test("enables Download again when the same revision comes back during a download", async () => {
		render_page();
		act(() => {
			viewStore.set(binary_view("application/pdf"));
		});
		fireEvent.click(screen.getByRole("button", { name: "Download" }));
		expect(screen.getByRole("button", { name: "Download" }).getAttribute("aria-disabled")).toBe("true");

		// The view is gone for a moment, then the same revision comes back. The old call's result is dropped.
		act(() => {
			viewStore.set(null);
		});
		act(() => {
			viewStore.set(binary_view("application/pdf"));
		});
		await signCalls[0]!.release(ready(signCalls[0]!.args, "https://r2.test/attachment"));

		expect(screen.getByRole("button", { name: "Download" }).getAttribute("aria-disabled")).toBeNull();
	});

	test("enables Download again when a stale revision comes back", async () => {
		render_page();
		act(() => {
			viewStore.set(binary_view("application/pdf"));
		});
		fireEvent.click(screen.getByRole("button", { name: "Download" }));
		await signCalls[0]!.release({ _yay: { status: "stale" } });
		expect(screen.getByRole("button", { name: "Download" }).getAttribute("aria-disabled")).toBe("true");

		// The file was renamed and renamed back, so R1 is current again.
		act(() => {
			viewStore.set({ ...binary_view("application/pdf"), revision: R2 });
		});
		act(() => {
			viewStore.set(binary_view("application/pdf"));
		});

		expect(screen.getByRole("button", { name: "Download" }).getAttribute("aria-disabled")).toBeNull();
	});

	test("ignores Download clicks while a rate limit waits", async () => {
		render_page();
		act(() => {
			viewStore.set(binary_view("application/pdf"));
		});
		fireEvent.click(screen.getByRole("button", { name: "Download" }));

		vi.useFakeTimers();
		await signCalls[0]!.release({ _nay: { message: "Rate limited", data: { retryAfterMs: 5_000 } } });
		fireEvent.click(screen.getByRole("button", { name: "Download" }));
		expect(signCalls).toHaveLength(1);

		act(() => {
			vi.advanceTimersByTime(5_000);
		});
		fireEvent.click(screen.getByRole("button", { name: "Download" }));
		expect(signCalls).toHaveLength(2);
	});
});
