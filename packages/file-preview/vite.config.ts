import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";
import { file_preview_security_config } from "./security";

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), "FILE_PREVIEW_");
	const security = file_preview_security_config(env.FILE_PREVIEW_PARENT_ORIGINS, mode === "development");
	return {
		define: { __FILE_PREVIEW_PARENT_ORIGINS__: JSON.stringify(security.origins) },
		preview: { port: 5175, strictPort: true, host: "127.0.0.1" },
		plugins: [
			{
				name: "file-preview-security-headers",
				generateBundle() {
					this.emitFile({ type: "asset", fileName: "_headers", source: security.staticHeaders });
				},
				configurePreviewServer(server) {
					// Serve the built policy. A later environment change must not replace it.
					const lines = readFileSync(resolve(server.config.root, server.config.build.outDir, "_headers"), "utf8").split(
						"\n",
					);
					const headers = lines
						.filter((line) => line.startsWith("  "))
						.map((line) => {
							const separator = line.indexOf(": ");
							return [line.slice(2, separator), line.slice(separator + 2)] as const;
						});
					server.middlewares.use((_request, response, next) => {
						for (const [name, value] of headers) response.setHeader(name, value);
						next();
					});
				},
			},
		],
	};
});
