# First-party plugins

First-party workspace plugins live here as Git submodules. Each submodule is the source repository used by the app plugin publisher flow.

- `bonobo-plugin-image` -> https://github.com/raythurnvoid/bonobo-plugin-image
- `bonobo-plugin-gallery` -> https://github.com/raythurnvoid/bonobo-plugin-gallery
- `bonobo-plugin-pdf` -> https://github.com/raythurnvoid/bonobo-plugin-pdf
- `bonobo-plugin-video` -> https://github.com/raythurnvoid/bonobo-plugin-video

The app imports plugin versions from GitHub, reading each version's single `dist/bonobo.plugin.json` manifest, stores the verified dist files in R2, and executes the stored backend worker through the plugin runner.
