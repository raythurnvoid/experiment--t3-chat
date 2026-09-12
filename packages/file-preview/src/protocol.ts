import { z } from "zod";

export const file_preview_ProtocolName = "bonobo-file-preview";
export const file_preview_ProtocolVersion = 1;
export const file_preview_MaxHtmlBytes = 900_000;
export const file_preview_MaxErrorLength = 500;

const messageFields = {
	protocol: z.literal(file_preview_ProtocolName),
	version: z.literal(file_preview_ProtocolVersion),
	sessionId: z.uuid(),
};

export const file_preview_HostMessageSchema = z.discriminatedUnion("type", [
	z.strictObject({ ...messageFields, type: z.literal("hello") }),
	z.strictObject({
		...messageFields,
		type: z.literal("load_html"),
		loadId: z.uuid(),
		html: z
			.string()
			// .max counts UTF-16 units; the refine enforces the real UTF-8 byte cap.
			.max(file_preview_MaxHtmlBytes)
			.refine((html) => new TextEncoder().encode(html).byteLength <= file_preview_MaxHtmlBytes),
	}),
]);

export const file_preview_RuntimeMessageSchema = z.discriminatedUnion("type", [
	z.strictObject({ ...messageFields, type: z.literal("ready") }),
	z.strictObject({ ...messageFields, type: z.literal("loaded"), loadId: z.uuid() }),
	z.strictObject({
		...messageFields,
		type: z.literal("error"),
		loadId: z.uuid(),
		message: z.string().min(1).max(file_preview_MaxErrorLength),
	}),
]);

export type file_preview_HostMessage = z.infer<typeof file_preview_HostMessageSchema>;
export type file_preview_RuntimeMessage = z.infer<typeof file_preview_RuntimeMessageSchema>;
