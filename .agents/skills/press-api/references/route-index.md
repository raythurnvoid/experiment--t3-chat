# Route index

All client rows below use POST. Caller names are defined in [auth](references/auth.md). “Key” means personal or service key unless the row says personal. “Service secret” means `X-Bonobo-Service-Authorization: Bearer <registered secret>` in addition to the indicated bearer, except member/change reads, which use that header alone with an existing verified connection. A plugin token derives its installation; it cannot choose another installation in its body.

| Path | Method | Class | Callers | Scope | Extra auth | Guide |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/v1/auth/verify` | POST | client | Key | none | none | [Auth](references/auth.md) |
| `/api/v1/ai-chat/threads/transcript` | POST | client | Personal key | `ai_chat:read` | none | [AI](references/ai-conversations.md) |
| `/api/v1/ai-chat/threads/tool-output/read` | POST | client | Personal key | `ai_chat:read` | none | [AI](references/ai-conversations.md) |
| `/api/v1/files/list` | POST | client | Key, Short grant, Frame, Run | `files:list` | none | [Files](references/files.md) |
| `/api/v1/files/read` | POST | client | Key, Short grant, Frame, Run | `files:read` | none | [Files](references/files.md) |
| `/api/v1/files/read-many` | POST | client | Key, Short grant | `files:read` | none | [Files](references/files.md) |
| `/api/v1/files/read-bytes` | POST | client | Key, Short grant | `files:download` | none | [Files](references/files.md) |
| `/api/v1/files/write-policy/get` | POST | client | Key | `files:read` | none | [Files](references/files.md) |
| `/api/v1/files/write-policy/set` | POST | client | Key | `files:permissions` | none | [Files](references/files.md) |
| `/api/v1/files/write` | POST | client | Key, Run, sealed Service grant | `files:write` | Service secret in writer mode | [Files](references/files.md) |
| `/api/v1/files/write-many` | POST | client | Key | `files:write` | none | [Files](references/files.md) |
| `/api/v1/files/touch` | POST | client | Key, Run | `files:write` | none | [Files](references/files.md) |
| `/api/v1/files/download-urls` | POST | client | Key, Run, Frame | `files:download` | none | [Files](references/files.md) |
| `/api/v1/files/upload-urls` | POST | client | Key | `files:write` | none | [Files](references/files.md) |
| `/api/v1/files/plugin-folders/ensure` | POST | client | Invoke Run, sealed Service grant | `files:write` | Service secret in writer mode | [Runtime](references/plugin-runtime.md) |
| `/api/v1/files/plugin-archive` | POST | client | Invoke Run, sealed Service grant | `files:write` | Service secret in writer mode | [Runtime](references/plugin-runtime.md) |
| `/api/v1/files/plugin-access/set` | POST | client | Invoke Run, sealed Service grant | `files:write` | Service secret in writer mode | [Runtime](references/plugin-runtime.md) |
| `/api/v1/files/plugin-writers/inspect` | POST | client | sealed Service grant | `files:write` | Service secret | [Runtime](references/plugin-runtime.md) |
| `/api/v1/files/plugin-writers/advance` | POST | client | sealed Service grant | `files:write` | Service secret | [Runtime](references/plugin-runtime.md) |
| `/api/v1/files/plugin-access/undo` | POST | client | sealed Service grant or recorded undo proof | original reader-change proof | Service secret | [Runtime](references/plugin-runtime.md) |
| `/api/v1/files/service-uploads/create-target` | POST | client | sealed Service grant | `files:write` | none | [Runtime](references/plugin-runtime.md) |
| `/api/v1/files/service-uploads/remint` | POST | client | sealed Service grant | `files:write` | none | [Runtime](references/plugin-runtime.md) |
| `/api/v1/files/service-uploads/finalize` | POST | client | sealed Service grant | `files:write` | none | [Runtime](references/plugin-runtime.md) |
| `/api/v1/files/service-uploads/delete` | POST | client | sealed Service grant | `files:write` | none | [Runtime](references/plugin-runtime.md) |
| `/api/v1/files/service-uploads/archive-destination` | POST | client | sealed Service grant | `files:write` | none | [Runtime](references/plugin-runtime.md) |
| `/api/v1/volumes/list` | POST | client | Run | `volumes:write` | none | [Runtime](references/plugin-runtime.md) |
| `/api/v1/volumes/stage` | POST | client | Run | `volumes:write` | none | [Runtime](references/plugin-runtime.md) |
| `/api/v1/volumes/write-many` | POST | client | Run | `volumes:write` | none | [Runtime](references/plugin-runtime.md) |
| `/api/v1/volumes/publish` | POST | client | Run | `volumes:write` | none | [Runtime](references/plugin-runtime.md) |
| `/api/v1/volumes/delete` | POST | client | Run | `volumes:write` | none | [Runtime](references/plugin-runtime.md) |
| `/api/v1/plugin-runs/follow-up` | POST | client | Scheduled Run | `runs:follow_up` | none | [Runtime](references/plugin-runtime.md) |
| `/api/v1/plugin-data/read` | POST | client | Personal key, Run, Frame, Service grant | `plugin_data:read` | none | [Store](references/plugin-data.md) |
| `/api/v1/plugin-data/list` | POST | client | Personal key, Run, Frame, Service grant | `plugin_data:read` | none | [Store](references/plugin-data.md) |
| `/api/v1/plugin-data/write` | POST | client | Personal key, Run, Service grant | `plugin_data:write` | none | [Store](references/plugin-data.md) |
| `/api/v1/plugin-data/write-batch` | POST | client | Personal key, Run, Service grant | `plugin_data:write` | none | [Store](references/plugin-data.md) |
| `/api/v1/plugin-data/delete` | POST | client | Personal key, Run, Service grant | `plugin_data:write` | none | [Store](references/plugin-data.md) |
| `/api/v1/plugin-data/write-versioned` | POST | client | Service grant | `plugin_data:write` | none | [Store](references/plugin-data.md) |
| `/api/v1/plugin-data/delete-versioned` | POST | client | Service grant | `plugin_data:write` | none | [Store](references/plugin-data.md) |
| `/api/v1/plugin-data/reserve` | POST | client | Service grant | `plugin_data:write` | none | [Store](references/plugin-data.md) |
| `/api/v1/plugin-data/release-reservation` | POST | client | Service grant | `plugin_data:write` | none | [Store](references/plugin-data.md) |
| `/api/v1/plugin-backend/invoke` | POST | client | Frame | `backend:invoke` | none | [Runtime](references/plugin-runtime.md) |
| `/api/v1/activities/start` | POST | client | Run | `activities:write` | none | [Runtime](references/plugin-runtime.md) |
| `/api/v1/plugins/identity/exchange` | POST | client | Frame and Registered service | none | Service secret | [Runtime](references/plugin-runtime.md) |
| `/api/v1/plugins/members/list` | POST | client | Registered service connection | none | Service secret | [Runtime](references/plugin-runtime.md) |
| `/api/v1/plugins/access/changes` | POST | client | Registered service connection | none | Service secret | [Runtime](references/plugin-runtime.md) |
| `/api/v1/plugins/service-grants/exchange` | POST | client | Frame and Registered service | registered scopes | Service secret | [Runtime](references/plugin-runtime.md) |
| `/api/v1/plugins/service-grants/recover` | POST | client | Original Frame or Service grant | registered scopes | Service secret | [Runtime](references/plugin-runtime.md) |
| `/api/v1/plugins/service-grants/renew` | POST | client | Service grant | registered scopes | Service secret | [Runtime](references/plugin-runtime.md) |
| `/api/v1/plugins/service-grants/seal-processing` | POST | client | interactive Service grant | registered scopes | Service secret | [Runtime](references/plugin-runtime.md) |
| `/api/v1/plugins/service-grants/verify-live` | POST | client | Service grant | claimed registered scopes | Service secret | [Runtime](references/plugin-runtime.md) |
| `/api/v1/runs/stream` | POST | app | App session; thread title stream | no public scope | App-user JWT | [Auth](references/auth.md) |

The `/api/v1/runs/stream` row is an app route, not a personal-key API. The prefix alone does not choose auth.

Other browser/system routes are outside this client surface: `/api/chat`, `/api/auth/anonymous`, `/api/auth/resolve-user`, `/api/files/contextual-prompt`, `/api/r2/event`, and `/api/internal/plugins/host/claim-runner-call`, `/api/internal/plugins/host/finish-runner-call`, `/api/internal/plugins/host/secret-get`. They use app, event, or trusted host authority. Do not call them with a public key or turn trusted host contracts into client recipes.

`/plugins-ui/session-jwt` exchanges a live Frame token for its plugin-session JWT. It is outside `/api/v1`. That JWT is for supported plugin Convex doors, not for these public Bearer-key routes.
