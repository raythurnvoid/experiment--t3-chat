# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default tseslint.config({
	extends: [
		// Remove ...tseslint.configs.recommended and replace with this
		...tseslint.configs.recommendedTypeChecked,
		// Alternatively, use this for stricter rules
		...tseslint.configs.strictTypeChecked,
		// Optionally, add this for stylistic rules
		...tseslint.configs.stylisticTypeChecked,
	],
	languageOptions: {
		// other options...
		parserOptions: {
			project: ["./tsconfig.node.json", "./tsconfig.app.json"],
			tsconfigRootDir: import.meta.dirname,
		},
	},
});
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from "eslint-plugin-react-x";
import reactDom from "eslint-plugin-react-dom";

export default tseslint.config({
	plugins: {
		// Add the react-x and react-dom plugins
		"react-x": reactX,
		"react-dom": reactDom,
	},
	rules: {
		// other rules...
		// Enable its recommended typescript rules
		...reactX.configs["recommended-typescript"].rules,
		...reactDom.configs.recommended.rules,
	},
});
```

## Development and operator guides

Read [AGENTS.md](AGENTS.md) for runtime, commands, app structure, and checks. Node commands use `vp env exec`; package commands use pnpm.

- [Large file imports and recovery](.agents/skills/convex-admin-ops/references/large-file-imports.md): partial writes, upload targets, byte checks, billing queues, and safe cleanup.
- [Convex operations](.agents/skills/convex-admin-ops/SKILL.md): deployment checks, Windows JSON arguments, and server/local clock differences.
- [Files tree](.agents/skills/files-explorer-tree/SKILL.md): shared paginated loading, virtual rows, focus, and drag/drop.
- [Browser QA](.agents/skills/app-playwriter-harness/SKILL.md) and [known hazards](.agents/skills/app-playwriter-harness/references/known-hazards.md): browser ownership, closed tabs, selectors, and recovery.
- [Performance checks](.agents/skills/perf-profiling/SKILL.md): separate network loading from rendering and verify the production bundle being measured.
- [Editable text](.agents/skills/files-editable-text/SKILL.md): exact Markdown storage, parser ownership, and content refusal markers.

Run-specific exports, scripts, proofs, and handoffs belong in the personal task folder described in AGENTS.md. Keep their credentials and business data out of these guides.

## HTML file preview

The file Preview tab uses the separate static runtime in [packages/file-preview](packages/file-preview/README.md). For local use, build it with `vp env exec pnpm --dir packages/file-preview run build:local`, then run `vp env exec pnpm --dir packages/file-preview run preview:local`. Reuse an existing server on port 5175.

The app's `VITE_FILE_PREVIEW_URL` points to the runtime's `/v0` URL. Development defaults to the local runtime. Production needs an explicit HTTPS URL on a separate host outside the app's cookie scope, plus the runtime's exact `FILE_PREVIEW_PARENT_ORIGINS` allowlist. See the runtime README for headers, checks, and deployment. No public host is created by the local setup.

## License / Attribution

This project is licensed under **Apache-2.0**.

Apache-2.0 requires that redistributions retain the `LICENSE` file and, if present, the `NOTICE` file (attribution notices). See `LICENSE` and `NOTICE` in the repository root.
