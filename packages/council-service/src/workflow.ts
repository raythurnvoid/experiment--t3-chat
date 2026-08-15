/**
 * The one Council Workflow class. A Queue consumer has a 15-minute wall limit, so it never owns
 * the long transfer; this does. One class covers both long jobs — processing a finished meeting
 * and deleting one — distinguished by params, so the config carries one binding.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "./cf.ts";
import type { Env } from "./env.ts";
import type { council_WorkflowParams } from "./consumer.ts";
import { council_run_deletion, council_run_processing } from "./pipeline.ts";

export class CouncilWorkflow extends WorkflowEntrypoint<Env, council_WorkflowParams> {
	async run(event: WorkflowEvent<council_WorkflowParams>, step: WorkflowStep) {
		const params = event.payload;
		if (params.kind === "delete_meeting") {
			return await council_run_deletion(this.env, step, params);
		}
		return await council_run_processing(this.env, step, params);
	}
}
