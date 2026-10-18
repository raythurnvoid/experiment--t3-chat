// The plugin capability ids, in their own file with no imports.
//
// `convex/schema.ts` needs this list for its validators, and almost every Convex module imports the
// schema. `shared/plugins.ts` imports zod and yaml, so reading the list from there made every module,
// including the file open path, load zod. Keep this file free of imports.

export const plugins_CAPABILITIES = [
	"plugin.secrets.read",
	"outbound.fetch",
	"workspace.files.read",
	"workspace.files.write",
	// Consent line: the files this installation creates through the sealed upload door may be locked
	// read-only, and it may release that one lock again to archive its own file. That release is the
	// only way this installation can remove a lock, and it matches a lock this exact service target
	// created, so this grants no write over content a member owns and no lock access anywhere else.
	//
	// It narrows `workspace.files.write` instead of replacing it, because a read-only file is still
	// a file this installation writes.
	"workspace.files.create-read-only",
	// Consent line: the plugin may create, update, and archive files and folders marked for it.
	// The exact plugin-name metadata value selects each existing node. Members may edit the label;
	// actor permissions and current locks still apply.
	"workspace.files.own-write",
	// Consent line: the plugin may set locks and readers on matching files and folders. Members
	// with manage permission may change them. A real manual sharing change stops reader syncing.
	"workspace.files.own-access",
	// Consent line: backend runs may add read-only external data through this installation's mounts.
	// Members with workspace read access may read it through the chat agent. The owner pays for stored files.
	"workspace.volumes.write",
	"plugin.data.read",
	"plugin.data.write",
	// Consent line: the plugin's UI pages and file views may store and change this plugin's data as
	// the acting member, through the app. Kept apart from `plugin.data.write`, which is the plugin's
	// own backend or service writing as the installation: the two are different consents, and a
	// user-write door under the backend capability would widen consent nobody gave.
	"plugin.data.user-write",
	// Consent line: the plugin's pages and file views may run the plugin's backend on demand; the
	// backend then acts with the plugin's own API access. Kept apart from the event-driven runs the
	// backend already gets, because "a member's click runs publisher code that can write" is a
	// different consent from "an upload runs it".
	"plugin.backend.invoke",
	// Consent line: the backend may run on a schedule as a member who granted it that access.
	// Each run uses only that member's live permissions and the permissions granted to the plugin.
	"plugin.schedule.run",
	"plugin.service.connect",
	// The plugin's UI pages and file views, running in the browser, may call the origins in
	// `uiOutboundOrigins`. Kept apart from `outbound.fetch`, which is the plugin's backend calling out
	// from the runner. The two are different risks and get different consent text: a frame holds a
	// member's session token, and whatever it may reach can be reached by anything that manages to run
	// inside that frame.
	"ui.outbound.fetch",
	// Consent line: the plugin's UI pages and file views may read the whole member list of this
	// workspace. Without it a frame can only turn ids it already stored into names, 50 at a time,
	// which enumerates nobody. This is its own capability because enumeration is a different consent
	// from name resolution, and because every member reads the roster under one rule — including a
	// member who signed in anonymously.
	"workspace.members.read",
	// Consent line: the chat agent may call the tools of the remote MCP servers in `mcpServers`, with
	// member data from the thread as input. Each server is an outside service. It never gets a Press
	// credential, only the headers and sign-in the manifest declares.
	"agent.mcp.connect",
	// Consent line: the chat agent may read and follow the instructions in the skills in `skills`.
	// Nothing is written into the workspace. The agent reads the reviewed text from the plugin mount.
	"agent.skills.contribute",
] as const;
