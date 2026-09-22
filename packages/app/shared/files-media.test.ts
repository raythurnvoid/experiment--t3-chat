import { describe, expect, test } from "vitest";
import { files_media_build_file_src, files_media_build_private_src, files_media_parse_src } from "./files-media.ts";

describe("files_media_build_file_src", () => {
	test("builds a stable saved reference", () => {
		expect(files_media_build_file_src("saved_1")).toBe("bonobo-file://saved_1");
	});
});

describe("files_media_build_private_src", () => {
	test("builds a stable private reference", () => {
		expect(files_media_build_private_src("draft_1")).toBe("bonobo-file://private/draft_1");
	});
});

describe("files_media_parse_src", () => {
	test("keeps saved IDs as untrusted strings", () => {
		expect(files_media_parse_src("bonobo-file://saved_1")).toEqual({ kind: "file", fileNodeId: "saved_1" });
	});

	test("reads private IDs as untrusted strings", () => {
		expect(files_media_parse_src("bonobo-file://private/draft_1")).toEqual({
			kind: "private",
			privateNodeId: "draft_1",
		});
	});

	test.each([
		"private",
		"private/",
		"private//draft_1",
		"private/draft_1/",
		"private/draft_1/child",
		"private/.",
		"private/..",
		"private/draft_1?download=1",
		"private/draft_1#image",
		"private/draft_1\\child",
		"private/draft%2F1",
		"private/draft%201",
		"private/ draft_1",
		"private/draft_1\n",
	])("rejects a malformed private path: %j", (path) => {
		expect(files_media_parse_src(`bonobo-file://${path}`)).toEqual({ kind: "unsupported" });
	});

	test.each(["https://images.test/image.png", "HTTP://images.test/video.mp4"])("keeps external URLs: %s", (url) => {
		expect(files_media_parse_src(url)).toEqual({ kind: "external", url });
	});

	test.each(["", "javascript:alert(1)", "data:image/png;base64,AA", "blob:local", "/image.png"])(
		"rejects unsupported sources: %j",
		(src) => expect(files_media_parse_src(src)).toEqual({ kind: "unsupported" }),
	);
});
