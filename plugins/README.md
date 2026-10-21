# First-party plugins

First-party workspace plugins live here as Git submodules. Each submodule is the source repository used by the app plugin publisher flow.

- `bonobo-plugin-image` -> https://github.com/<owner>/bonobo-plugin-image
- `bonobo-plugin-gallery` -> https://github.com/<owner>/bonobo-plugin-gallery
- `bonobo-plugin-pdf` -> https://github.com/<owner>/bonobo-plugin-pdf
- `bonobo-plugin-video` -> https://github.com/<owner>/bonobo-plugin-video
- `bonobo-plugin-video-player` -> https://github.com/<owner>/bonobo-plugin-video-player
- `bonobo-plugin-council` -> https://github.com/<owner>/bonobo-plugin-council
- `bonobo-plugin-chitchat` -> https://github.com/<owner>/bonobo-plugin-chitchat
- `bonobo-plugin-data-probe` -> https://github.com/<owner>/bonobo-plugin-data-probe (QA fixture: backend replies, plugin documents, and since 0.3.0 an MCP server and a skill)
- `bonobo-plugin-github-sources` -> https://github.com/<owner>/bonobo-plugin-github-sources

The app imports plugin versions from GitHub, reading each version's single `dist/bonobo.plugin.json` manifest, stores the verified dist files in R2, and executes the stored backend worker through the plugin runner.
