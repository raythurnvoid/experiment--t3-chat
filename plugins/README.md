# First-party plugins

First-party workspace plugins live here as Git submodules. Each submodule is the source repository used by the app plugin publisher flow.

- `bonobo-plugin-image` -> https://github.com/raythurnvoid/bonobo-plugin-image
- `bonobo-plugin-pdf` -> https://github.com/raythurnvoid/bonobo-plugin-pdf
- `bonobo-plugin-video` -> https://github.com/raythurnvoid/bonobo-plugin-video

The app imports plugin versions from GitHub, stores verified artifacts in R2, and executes the stored backend artifact through the plugin runner.
