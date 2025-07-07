import type { Context } from "hono";
import { auth_ANONYMOUS_USER_ID } from "../lib/auth.ts";

export function server_auth_set_user_in_context(
	c: Context,
	values: {
		userId: string;
		sessionId: string;
	}
) {
	c.set("userId", values.userId);
	c.set("sessionId", values.sessionId);
	c.set("isAuthenticated", true);
}

export function server_auth_set_anonymous_user_in_context(c: Context) {
	c.set("userId", auth_ANONYMOUS_USER_ID);
	c.set("sessionId", auth_ANONYMOUS_USER_ID);
	c.set("isAuthenticated", false);
}

export function server_auth_get_user_is_authenticated(c: Context) {
	return c.get("isAuthenticated") as boolean;
}

export function server_auth_get_user_id(c: Context) {
	return c.get("userId") as string;
}
