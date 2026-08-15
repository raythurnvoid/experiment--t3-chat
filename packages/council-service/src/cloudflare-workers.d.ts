/**
 * Ambient declarations for the runtime-provided Cloudflare modules, so the Workflow class can
 * extend `WorkflowEntrypoint` without adding `@cloudflare/workers-types` to a package that is
 * dependency-free on purpose. Vitest aliases both specifiers to local stubs, because Node has
 * neither module.
 *
 * `NonRetryableError` lives on `cloudflare:workflows`. Importing it from `cloudflare:workers`
 * type-checks against a local declaration, but the live Worker runtime does not export that name
 * from `cloudflare:workers`, so wrangler deploy fails with SyntaxError 10021.
 */
declare module "cloudflare:workers" {
	export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
		protected env: Env;
		abstract run(
			event: import("./cf.ts").WorkflowEvent<Params>,
			step: import("./cf.ts").WorkflowStep,
		): Promise<unknown>;
	}
}

declare module "cloudflare:workflows" {
	/**
	 * Thrown from a Workflow step to stop retries. A terminal Convex refusal (conflict,
	 * unauthorized) must not sit in `deleting` while the platform retries for a minute.
	 */
	export class NonRetryableError extends Error {
		constructor(message: string, name?: string);
	}
}
