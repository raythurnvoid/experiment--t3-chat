// Helpers for Cloudflare Worker HTTP route tables.

export type cloudflare_workers_RouteHandlerArgs<Env, Ctx> = {
	request: Request;
	env: Env;
	ctx?: Ctx;
};

export type cloudflare_workers_RouteHandler<Env, Ctx> = (
	args: cloudflare_workers_RouteHandlerArgs<Env, Ctx>,
) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
