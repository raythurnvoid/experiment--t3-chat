/**
 * One random id for this browser tab, made on first use and kept until the page reloads. Every chat
 * message sends it, and only this tab answers the calls the server sends back for that message
 * (`view_snapshot`, `view_screenshot`, and plugin page tools).
 *
 * It is not kept in `sessionStorage`: "Duplicate tab" copies session storage, and then two tabs
 * would share one id.
 */
export const ai_chat_ui_instance_get_id = ((/* iife */) => {
	let cache: string | undefined;

	return function ai_chat_ui_instance_get_id() {
		return (cache ??= crypto.randomUUID());
	};
})();
