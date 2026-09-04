// Client-side image compression for uploads.
//
// Lifted from the files sidebar so the rich text editor's paste/drop upload flow can prepare
// files the same way. Compress before creating the upload node, so Convex and R2 store the
// same byte size and content type the browser actually uploads.

const IMAGE_UPLOAD_COMPRESSION_MAX_DIMENSION_PX = 2048;
const IMAGE_UPLOAD_COMPRESSION_QUALITY = 0.82;

function image_upload_compression_mime_type(file: File) {
	switch (file.type) {
		case "image/jpeg":
		case "image/png":
		case "image/webp":
			return file.type;
		default:
			// Keep animated GIFs and unsupported formats untouched; the image
			// description pipeline can still process them without losing animation.
			return null;
	}
}

async function canvas_to_blob(canvas: HTMLCanvasElement, type: string) {
	return await new Promise<Blob | null>((resolve) => {
		canvas.toBlob(resolve, type, IMAGE_UPLOAD_COMPRESSION_QUALITY);
	});
}

/**
 * Shrink an image file before upload. Returns the original file whenever compression is not
 * possible or not a strict win, including on any decode error.
 */
export async function files_prepare_image_upload_file(file: File) {
	const outputType = image_upload_compression_mime_type(file);
	if (!outputType) {
		return file;
	}

	let imageBitmap: ImageBitmap | null = null;
	try {
		// Use browser-native decoding/resampling so uploads get smaller before the
		// signed R2 PUT without adding a client-side encoder dependency.
		imageBitmap = await createImageBitmap(file);
		const scale = Math.min(
			1,
			IMAGE_UPLOAD_COMPRESSION_MAX_DIMENSION_PX / Math.max(imageBitmap.width, imageBitmap.height),
		);
		if (scale === 1 && outputType === "image/png") {
			// Keep small PNGs original; re-encoding them usually increases size or
			// degrades sharp UI screenshots without reducing transfer cost.
			return file;
		}

		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(imageBitmap.width * scale));
		canvas.height = Math.max(1, Math.round(imageBitmap.height * scale));
		const context = canvas.getContext("2d");
		if (!context) {
			return file;
		}

		context.drawImage(imageBitmap, 0, 0, canvas.width, canvas.height);
		const compressedBlob = await canvas_to_blob(canvas, outputType);
		if (!compressedBlob || compressedBlob.size >= file.size) {
			// Keep the original whenever compression is not a strict win.
			return file;
		}

		return new File([compressedBlob], file.name, {
			type: compressedBlob.type || file.type,
			lastModified: file.lastModified,
		});
	} catch (error) {
		console.warn("[files_prepare_image_upload_file] Failed to compress image upload", { error });
		return file;
	} finally {
		imageBitmap?.close();
	}
}

// #region tests
if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, expect, test } = import.meta.vitest;

	describe("image_upload_compression_mime_type", () => {
		test("compresses only static browser image types", () => {
			expect(image_upload_compression_mime_type(new File(["content"], "photo.jpg", { type: "image/jpeg" }))).toBe(
				"image/jpeg",
			);
			expect(image_upload_compression_mime_type(new File(["content"], "photo.png", { type: "image/png" }))).toBe(
				"image/png",
			);
			expect(image_upload_compression_mime_type(new File(["content"], "photo.webp", { type: "image/webp" }))).toBe(
				"image/webp",
			);
			expect(image_upload_compression_mime_type(new File(["content"], "animated.gif", { type: "image/gif" }))).toBe(
				null,
			);
		});
	});
}
// #endregion tests
