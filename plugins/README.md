# First-party plugins

First-party workspace plugins live here as Git submodules. Each submodule is the source repository used by the app plugin publisher flow.

- `bonobo-plugin-media` -> https://github.com/raythurnvoid/bonobo-plugin-media
- `bonobo-plugin-pdf` -> https://github.com/raythurnvoid/bonobo-plugin-pdf

The app imports plugin versions from GitHub, stores verified artifacts in R2, and executes the stored backend artifact through the plugin runner.
