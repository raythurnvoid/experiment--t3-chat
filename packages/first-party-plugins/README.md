# First-party plugins

Committed manifests and built dists for the first-party workspace plugins (`media`, `pdf`). Each folder is the source of truth mirrored to its GitHub repo, from which versions are published through the publisher pipeline.

## Runtime notes for plugin authors

Plugin backends run as dynamically loaded Cloudflare workers. The runner keys the loaded worker by plugin name, version, artifact hash, and wrapper version — not by workspace or installation (`packages/plugin-runner/src/index.ts`, `build_plugin_stable_id`). Two consequences:

- Module-level state may persist across runs of the same artifact. This is measured behavior, not a possibility: two live runs seven seconds apart shared one isolate and a module-scope counter reached 2.
- Because the key has no tenant component, a reused isolate can serve runs from different workspaces.

Therefore:

- Do not keep secret values or per-run data at module scope; fetch secrets inside the handler via `env.BONOBO.secrets.get(...)` and let them go out of scope when the run ends.
- Do not cache anything derived from one workspace's data at module scope. A deliberate module-level cache is fine only for tenant-independent values (parsed constants, compiled regexes, lazily-initialized libraries).
- Isolate reuse is best-effort, never guaranteed — a cache must be a pure optimization, not a correctness dependency.

The pre-registration AI review flags suspicious module-level mutable state; versions flagged for it are registered but cannot be installed until the verdict is cleared.
