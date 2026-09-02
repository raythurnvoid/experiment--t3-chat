import { api } from "../convex/_generated/api.js";

/**
 * The plugin doors as one value, so `tsc` prints their full types.
 *
 * `generate-plugin-sdk-types.ts` emits this module's declaration and writes it to
 * `packages/bonobo-plugin-sdk/convex-api.d.ts`, the file a plugin type-checks its direct Convex
 * calls against. A type alias would not work here: `tsc` keeps an alias as written, so the emitted
 * file would still point at `api` and the whole app behind it. The type of a value is printed in
 * full instead, with every argument and result written out.
 *
 * Keep this file outside `convex/`. Convex codegen lists every module under `convex/` in
 * `_generated/api.d.ts`, so a module there that reads `api` makes `api` depend on itself, and
 * TypeScript then types this value as `any`. Nothing imports this file at runtime.
 */
export const bonobo_convex_api = { plugins_data: api.plugins_data };
