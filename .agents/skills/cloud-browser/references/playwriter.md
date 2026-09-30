# Playwriter browser

Playwriter lets the cloud agent use one tab on the user's computer. The official
extension makes an outgoing connection to its relay. The user does not need to
open a router port. The app does not connect to a local browser IP.

## Source

- `packages/app/convex/playwriter_browser.ts`: owner checks, encrypted link,
  connection limits, command claims, recovery, and cleanup.
- `packages/app/server/ai-chat-browser-tools.ts`: fixed tools and private results.
- `packages/app/server/playwriter-browser.ts`: checked HTTP client.
- `packages/common/src/playwriter-browser.ts`: strict request and response shapes.
- `packages/browser-runner/src/playwriter-session.ts`: remote session and receipts.
- `packages/browser-runner/src/playwriter-transport.ts`: one-target protocol bridge.
- `packages/browser-runner/src/playwriter-executor.ts`: trusted fixed actions.
- `packages/app/src/components/browser/playwriter-browser-connection.tsx`: connection UI.
- `references-submodules/playwriter`: pinned upstream reference only. Never import
  it into the app or add it to the workspace.

Paths above start at the repository root.

## User flow

Choose **My browser (Playwriter)** on the Browser page or in **Browser settings**.
Paste a share ID or an official `https://playwriter.dev/remote-control#<id>` link.
The ID has exactly 32 lower-case hex characters. Other URLs and commands fail.

Connect lists the shared tabs. **Use this tab** confirms one exact native target.
The model receives an opaque browser reference, never the native target ID or
link. A changed or closed target needs confirmation again. No fallback tab is
picked. Cloud tab creation is separate from this one-tab connection.
An exact `about:blank` tab can be confirmed. Other browser pages still refuse.
Web tab addresses keep only the origin in the app's stored list.

The user sees actions in their native browser. There is no app video stream.
The computer and browser must stay open. Pause lasts until the user resumes.
Resume requires the observed connectionGeneration and controlRevision. An old
Resume cannot clear a newer Pause or resume a replaced connection.
Resume is offered only while Paused. A closed socket needs Reconnect. If a
paused mirror has lost its socket, a refused Resume restores the recovery state;
it cannot leave the connection stuck in Recovering.
Restoring Pause advances control again. A lost successful Resume reply cannot
make its old unpaused runtime replace that saved intent.
Off is the saved agent-access setting for both web providers. Connect and Open
never undo Pause or Off.

**Disconnect** forgets the saved link at once and queues socket cleanup. The
native tab stays open. Agent **Close** ends automation but retains the encrypted
link only until the old idle deadline. Human Reconnect may start a new session
after old work drains. Status reads never extend idle time. The runner's idle
expiry stops at the session's total deadline, while the saved link keeps its own
idle expiry.

## Authority and privacy

The link uses AES-GCM with `BROWSER_REMOTE_SECRETS_ENCRYPTION_KEY`. Encryption is
bound to the connection, owner, organization, and workspace. A separate HMAC
fingerprint reserves a link for one owner/workspace across the deployment.
Key changes make old links unreadable; the app forgets them and asks for Connect.

Every action checks the original persisted user message, live chat, owner,
membership lifetime, `workspace.browser.use`, saved choice, settings revisions,
and exact target/control/navigation revisions. Another tab or newer human lease
cannot silently replace that authority. Membership loss and deletion revoke
authority and queue cleanup without needing the source chat to survive.

Only fixed Read, Click, Fill, Press, Scroll, Navigate, and Capture operations are
exposed. The model cannot send JavaScript, CSS selectors, CDP, cookies, storage
calls, network calls, or a raw relay URL. Credential fields refuse input.
Page text is untrusted. Sending, buying, publishing, and deleting still need the
user's request or approval.

The tab uses the user's real browser profile and network. In production the
shared host policy does not block Press. The agent can open Press as the already
signed-in user and act in every organization that user can access, beyond the
chat's workspace. It can also reach localhost, private-network, and intranet
pages that the user's computer can reach. The cloud provider's private-network
boundary does not apply. This behavior is accepted; user site blocks remain
best effort and are not a network firewall.

Raw inputs, text, accessibility output, URLs, and image bytes stay in the current
turn's private observation map. Shared tool cards, history, title generation,
and command receipts keep only fixed status and reason text. Capture is one
bounded PNG/JPEG for the model; it creates no Files output or video stream.

## Recovery and limits

One durable identity combines the original message, tool call ID, and operation
hash. An exact retry returns a safe receipt and never repeats the action.
A lost reply remains busy until the runner proves dispatch and cleanup stopped.
Deleting the source cannot release that lock early. Cleanup jobs keep their own
owner/workspace/generation scope and can run while feature flags are off.

Recovery makes at most three dials within 30 seconds. It keeps the exact target,
Pause, Off, session budgets, and saved choice. It does not run an offline retry
loop. After a successful reconnect, old page data and lease checks are removed.
Text calls keep only their fixed status and reason. Captures are removed.
Recovery drops old-generation acknowledgements. A late old completion cannot
restore one. Same-generation status keeps its pending acknowledgement.

Human Reconnect reads runner status. It can start a new session after agent Close
or a session limit. It waits for old cleanup, then uses a separate trusted route
with the old session ID. The runner refuses a stale old ID and advances its
generation before dialing.
The new session keeps the confirmed tab, Pause, Off, and saved policy. Automatic
recovery cannot reset the operation count or total deadline.
Pause and Resume require an active session. A stale Pause after retirement asks
for Reconnect and leaves the saved control state unchanged. An earlier human
Pause survives session retirement and Reconnect.
If cleanup ends the old session before a prepared Pause reaches the runner,
Reconnect carries that saved Pause into the new session. A changed Pause value
requires a strictly newer trusted control revision. Equal or older revisions
cannot change it. The new session stays paused until the user resumes.

After a lost dial, the next human Reconnect reads runner status. It keeps the
already saved new session ID, operation count, and deadlines. A matching runner
ID uses same-session recovery. An ended old ID uses the explicit new-session
route. Missing proof asks for Connect again and retires only that exact attempt.
A late failure cannot forget a newer Reconnect or Pause, or mark a later Resume
offline.
A temporary status error keeps the saved link and choice for a later Reconnect.

Credential Forget saves a permanent connection ID fence before draining old
work. Only the runner's fixed `connection_forgotten` reply proves that cleanup.
An exact-generation cleanup can also finish with a strictly newer returned
generation. Plain `not_connected` is not proof. If old work cannot be settled,
the runner closes its old socket and advances the generation before Forget can
finish. That fence stops further dispatch. Prior page effects remain unknown.
A later disconnect, such as member removal, human Disconnect, idle expiry, or
deletion, can turn a queued exact-generation cleanup into Forget while the old
reply is still on its way. That old reply cannot finish or delay the job. The
next cleanup run sends generationless Forget.

Click or Enter can navigate by loading a new document or changing an SPA route.
A completed trusted input event, settled native input, unchanged authority, and
a checked allowed address let that exact command return success with its new
navigation lease. Old page observations are dropped. A fresh Read can run in
the same turn without Reconnect. The action is never repeated.
Without that proof the page effect stays `outcome_unknown`. After the runner
settles the child or closes its socket, it advances the generation to prevent
any more dispatch. Convex releases the command slot, and Reconnect can use the
same saved link. Explicit Navigate keeps its own checked navigation path.
A changed lease keeps proven cleanup, while the action result stays unknown.
It returns no page data or completed lease.
The tool keeps that unknown warning even after navigation changes.

Limits are 20 browser operations per turn, 120 remote operations per session,
30 seconds per operation, 15 seconds per dial, 10 idle minutes, and 60 total
minutes. Only admitted operations extend idle time. Connection attempts allow
five per minute and 50 per UTC day per user. Active caps are one per owner and
workspace, two per user, two per workspace, four per organization, and ten per
deployment. Playwriter creates no browser profile or `browser_usage` charge.

Failed settings sync keeps `syncPending` until a retry succeeds. The indexed
minute cron retries pending settings in batches of 50. A failed retry does not
schedule another retry chain.
Sync checks runner status before sending policy, so a restart cannot keep an old
connection generation in use. The sweep uses indexes for links due to expire
and unfinished invocations, and removes old daily-use counts.

Pending socket cleanup keeps its capacity slot until the runner proves closure.
Count each connection ID once, even after its doc is removed. A dormant saved
link with no pending cleanup uses no active slot.
Proven Forget deletes the runner's saved session and dial history. Only the
permanent connection fence stays; it holds no blocked hosts or native target.

## Accepted frame limit

The official extension may not replay child sessions for iframes loaded before
the remote connection. The app cannot invent these sessions. It returns
`iframe_unsupported` when the frame tree cannot be checked. A missing child
session can refuse the whole Read or Capture, including a main-page read.
This accepted upstream limit does not require an extension patch.

The app's current guarded input path also refuses frame actions outside the
main frame. That is a separate app limit: safe input needs checked ancestor
frames and hit tests. Keep it separate from the extension's replay gap.

## Setup and checks

Convex needs `AI_CHAT_BROWSER_ENABLED=true`, `AI_CHAT_PLAYWRITER_ENABLED=true`,
`BROWSER_RUNNER_URL`, `BROWSER_RUNNER_SECRET`,
`BROWSER_REMOTE_SECRETS_ENCRYPTION_KEY`, and
`BROWSER_PLAYWRITER_ALLOWED_VERSIONS`. The last value is a comma list of tested
extension hello versions. An empty list disables Connect. Never accept every
version or print keys or share IDs in logs.

Each new trusted Run carries the current capped version list. The runner checks
the live extension version before child dispatch. Removing a version blocks new
work on an existing connection. Exact receipts and cleanup still work without
repeating page actions.

The Worker uses the same runner secret and its `PLAYWRITER_SESSIONS` Durable
Object. Ship the fixed child bundle with the Worker. Use official extension
builds. No local extension patch is required.

QA lives in `app-playwriter-harness/references/web-browser.md`. Check Connect,
exact confirmation, background Read and actions, one-shot Capture, Pause, Off,
Reconnect, Disconnect, stale target refusal, lost replies, and stored history.
Keep native viewport and window settings unchanged. Do not claim support for
minimized-window input from a background-tab check.
