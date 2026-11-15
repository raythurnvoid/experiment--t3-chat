/**
 * Text that looks like a token or a key: provider keys, JWTs, `Bearer` values, and the app's own
 * plugin tokens (`plu_`, `plr_`, `psg_`). Use it to scrub untrusted text before the model reads it,
 * such as an MCP tool result or the text a plugin page shares.
 */
export const secret_shaped_text_REGEX =
	/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(?:plu|plr|psg)_[0-9a-f]{64})\b|Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/gu;
