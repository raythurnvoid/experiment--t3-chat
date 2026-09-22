import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { files_headless_tiptap_editor_create } from "../shared/files-tiptap.ts";
import { files_COMMENT_MARK_TYPE } from "../shared/files-tiptap-comments.ts";
import { files_transfer_rewrite_media_refs } from "./files-transfer-media.ts";

function create_editor(json: JSONContent) {
	const result = files_headless_tiptap_editor_create({ initialContent: { json } });
	if (result._nay) {
		throw new Error("Expected headless editor creation to succeed", { cause: result._nay });
	}
	const editor = result._yay;
	onTestFinished(() => editor.destroy());
	editor.state.doc.check();
	return editor;
}

afterEach(() => vi.restoreAllMocks());

describe("files_transfer_rewrite_media_refs", () => {
	test.each(["bonobo-file://source", "bonobo-file://private/source"])(
		"rewrites %s image and video src in one transaction and preserves attrs, marks and text",
		(source) => {
			const destination = "bonobo-file://private/destination";
			const editor = create_editor({
				type: "doc",
				content: [
					{
						type: "paragraph",
						content: [
							{ type: "text", text: "Before ", marks: [{ type: "italic" }] },
							{
								type: "image",
								attrs: {
									src: source,
									alt: "A diagram",
									title: "Image caption",
									width: 320,
									align: "right",
									uploadId: "image-upload",
								},
								marks: [
									{ type: "bold" },
									{ type: files_COMMENT_MARK_TYPE, attrs: { threadId: "thread-1", orphan: false } },
								],
							},
							{ type: "text", text: " after." },
						],
					},
					{
						type: "video",
						attrs: {
							src: source,
							title: "Video caption",
							width: 640,
							align: "center",
							uploadId: "video-upload",
						},
					},
				],
			});
			// Clone the attrs too: getJSON shares them with the editor's nodes.
			const expected: JSONContent = structuredClone(editor.getJSON());
			expected.content![0].content![1].attrs!.src = destination;
			expected.content![1].attrs!.src = destination;
			const selection = TextSelection.create(editor.state.doc, 2, 4);
			editor.view.updateState(EditorState.create({ doc: editor.state.doc, plugins: editor.state.plugins, selection }));
			const plugins = editor.state.plugins;
			const apply = vi.spyOn(EditorState.prototype, "apply");

			const result = files_transfer_rewrite_media_refs({
				mut_editor: editor,
				referenceMap: new Map([[source, destination]]),
			});

			expect(editor.state.doc.firstChild!.child(1).attrs.src).toBe(destination);
			expect(editor.getJSON()).toEqual(expected);
			expect(result).toEqual({ _yay: null });
			expect(apply).toHaveBeenCalledTimes(1);
			expect(editor.state.selection.eq(selection)).toBe(true);
			expect(editor.state.plugins).toEqual(plugins);
		},
	);

	test("rewrites duplicate refs in nested nodes with exact keys and no chained remapping", () => {
		const saved = "bonobo-file://same-id";
		const privateRef = "bonobo-file://private/same-id";
		const destination = "bonobo-file://private/destination";
		const editor = create_editor({
			type: "doc",
			content: [
				{
					type: "blockquote",
					content: [
						{
							type: "paragraph",
							content: [
								{ type: "image", attrs: { src: saved } },
								{ type: "image", attrs: { src: privateRef } },
								{ type: "image", attrs: { src: saved } },
							],
						},
						{ type: "video", attrs: { src: privateRef } },
					],
				},
			],
		});
		const expected: JSONContent = structuredClone(editor.getJSON());
		const blocks = expected.content![0].content!;
		blocks[0].content![0].attrs!.src = privateRef;
		blocks[0].content![1].attrs!.src = destination;
		blocks[0].content![2].attrs!.src = privateRef;
		blocks[1].attrs!.src = destination;

		expect(
			files_transfer_rewrite_media_refs({
				mut_editor: editor,
				referenceMap: new Map([
					[saved, privateRef],
					[privateRef, destination],
				]),
			}),
		).toEqual({ _yay: null });
		expect(editor.getJSON()).toEqual(expected);
	});

	test.each([false, true])(
		"refuses all writes and reports unique original missing refs, missing first: %s",
		(missingFirst) => {
			const mapped = { type: "image", attrs: { src: "bonobo-file://mapped" } };
			const missing = { type: "image", attrs: { src: "bonobo-file://missing" } };
			const editor = create_editor({
				type: "doc",
				content: [
					{ type: "paragraph", content: missingFirst ? [missing, mapped] : [mapped, missing] },
					{ type: "video", attrs: { src: "bonobo-file://private/missing" } },
					{ type: "video", attrs: { src: "bonobo-file://missing" } },
				],
			});
			const before = structuredClone(editor.getJSON());
			const state = editor.state;
			const apply = vi.spyOn(EditorState.prototype, "apply");

			const result = files_transfer_rewrite_media_refs({
				mut_editor: editor,
				referenceMap: new Map([["bonobo-file://mapped", "bonobo-file://private/copied"]]),
			});

			expect(result).toMatchObject({
				_nay: {
					message: "Missing media mappings",
					data: { unresolvedRefs: ["bonobo-file://missing", "bonobo-file://private/missing"] },
				},
			});
			expect(editor.getJSON()).toEqual(before);
			expect(editor.state).toBe(state);
			expect(apply).not.toHaveBeenCalled();
		},
	);

	test("does not resolve a private ref from a saved ref with the same ID", () => {
		const editor = create_editor({
			type: "doc",
			content: [{ type: "video", attrs: { src: "bonobo-file://private/same-id" } }],
		});
		const state = editor.state;
		const result = files_transfer_rewrite_media_refs({
			mut_editor: editor,
			referenceMap: new Map([["bonobo-file://same-id", "bonobo-file://private/copied"]]),
		});

		expect(result._nay?.data.unresolvedRefs).toEqual(["bonobo-file://private/same-id"]);
		expect(editor.state).toBe(state);
	});

	test("changes only real app-media nodes, leaving text, code, links, attrs and external media intact", () => {
		const source = "bonobo-file://source";
		const missing = "bonobo-file://private/not-media";
		const externalImage = "https://example.test/image.png";
		const externalVideo = "https://example.test/video.mp4";
		const destination = "bonobo-file://private/copied";
		const editor = create_editor({
			type: "doc",
			content: [
				{ type: "frontmatter", content: [{ type: "text", text: `image: ${missing}` }] },
				{
					type: "paragraph",
					content: [
						{ type: "text", text: `![Fake](${source}) ${missing}` },
						{ type: "text", text: source, marks: [{ type: "code" }] },
						{ type: "text", text: "Link", marks: [{ type: "link", attrs: { href: source } }] },
						{ type: "text", text: "Other link", marks: [{ type: "link", attrs: { href: missing } }] },
						{ type: "text", text: " https://example.test/plain-text " },
						{ type: "image", attrs: { src: source, alt: missing, title: source } },
						{ type: "image", attrs: { src: externalImage, alt: source } },
					],
				},
				{
					type: "codeBlock",
					attrs: { language: "html" },
					content: [{ type: "text", text: `<img src="${source}"><video src="${missing}"></video>` }],
				},
				{ type: "video", attrs: { src: externalVideo, title: missing } },
			],
		});
		const expected: JSONContent = structuredClone(editor.getJSON());
		expected.content![1].content![5].attrs!.src = destination;

		expect(
			files_transfer_rewrite_media_refs({
				mut_editor: editor,
				referenceMap: new Map([
					[source, destination],
					[externalImage, destination],
					[externalVideo, destination],
				]),
			}),
		).toEqual({ _yay: null });
		expect(editor.getJSON()).toEqual(expected);
	});

	test("leaves external, unsupported and upload placeholder sources unchanged without a transaction", () => {
		const sources = [
			null,
			"",
			"https://example.test/image.png",
			"HTTP://example.test/video.mp4",
			"data:image/png;base64,AA",
			"bonobo-file://private/bad/path",
		];
		const editor = create_editor({
			type: "doc",
			content: [
				{ type: "paragraph", content: sources.map((src) => ({ type: "image", attrs: { src, uploadId: "upload" } })) },
				...sources.map((src) => ({ type: "video", attrs: { src, uploadId: "upload" } })),
			],
		});
		const before = structuredClone(editor.getJSON());
		const state = editor.state;

		expect(files_transfer_rewrite_media_refs({ mut_editor: editor, referenceMap: new Map() })).toEqual({ _yay: null });
		expect(editor.getJSON()).toEqual(before);
		expect(editor.state).toBe(state);
	});
});
