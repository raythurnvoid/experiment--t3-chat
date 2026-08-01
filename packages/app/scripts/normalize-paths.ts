/// <reference types="node" />

// Normalize file and folder names with the app's real normalizers, for tools that live outside
// this repo (the import CLI cannot import shared/files.ts through its own toolchain).
//
// stdin:  JSON array of { kind: "folder" | "markdown" | "upload", name: string }
//         - "folder":   folder segment names (files_normalize_name "folder")
//         - "markdown": Markdown file names, forces the .md extension (files_normalize_name "file")
//         - "upload":   binary upload names, keeps the real extension (files_normalize_upload_file_name)
// stdout: JSON array with a { _yay } or { _nay } Result for each input, in the same order.
//
// Run from packages/app: `vp env exec pnpm exec tsx scripts/normalize-paths.ts`

import { files_normalize_name, files_normalize_upload_file_name } from "../shared/files.ts";

const input = await new Promise<string>((resolve, reject) => {
	let data = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => (data += chunk));
	process.stdin.on("end", () => resolve(data));
	process.stdin.on("error", reject);
});

const requests: unknown = JSON.parse(input);
if (
	!Array.isArray(requests) ||
	!requests.every(
		(request: unknown): request is { kind: "folder" | "markdown" | "upload"; name: string } =>
			typeof request === "object" &&
			request !== null &&
			("kind" in request
				? request.kind === "folder" || request.kind === "markdown" || request.kind === "upload"
				: false) &&
			("name" in request ? typeof request.name === "string" : false),
	)
) {
	console.error('Expected a JSON array of { kind: "folder" | "markdown" | "upload", name: string } on stdin');
	process.exit(1);
}

const results = requests.map((request) => {
	if (request.kind === "upload") {
		return { _yay: files_normalize_upload_file_name(request.name) };
	}
	return files_normalize_name(request.kind === "markdown" ? "file" : "folder", request.name);
});
process.stdout.write(JSON.stringify(results));
