// Node stand-in for the runtime-provided `cloudflare:workers` module. Vitest aliases the specifier
// here so importing the Workflow class does not crash under Node; tests drive the class's `run`
// directly with a scripted step object.
export class WorkflowEntrypoint<Env = unknown, _Params = unknown> {
	protected env: Env;

	constructor(env: Env) {
		this.env = env;
	}
}
