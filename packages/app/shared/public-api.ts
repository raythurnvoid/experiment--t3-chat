export type public_api_Scope =
	| "files:list"
	| "files:read"
	| "files:write"
	| "files:download"
	| "secrets:read"
	| "outbound:fetch"
	| "activities:write";

export const public_api_PLUGIN_RUN_TOKEN_REGEX = /^plr_[0-9a-f]{64}$/u;
export const public_api_PLUGIN_UI_TOKEN_REGEX = /^plu_[0-9a-f]{64}$/u;
