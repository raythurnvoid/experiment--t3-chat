# Plugin document store

Use the [route index](references/route-index.md) for scopes and callers. These routes store plugin documents, not Files. A file grant does not grant store access. Reads need current workspace content-read permission; writes need content-write permission and accepted plugin consent.

A personal key must include `installationId` from its own workspace. Plugin tokens must omit it: their installation comes from the token. Missing it for a key gives 400 `installationId is required for an API key`; sending it with a plugin token gives 400 `installationId is not allowed for this token`. Service-bound keys and short grants cannot use these store routes.

All bodies are strict. Unknown fields return 400. JSON bodies are limited to 64 KiB, except `write-batch`, which allows 4 MiB and up to 50 documents. A canonical document value is an object of at most 16 KiB. Unsupported field names, invalid Unicode, excessive nesting, or arrays/objects too large for storage are refused at the request boundary. A generic validation error may not name the bad field.

## Ordinary documents

The common body has `collection` and, for a single document, `key`. Add `installationId` only for a personal key.

| Suffix under `/api/v1/plugin-data/` | Additional body fields | Success |
| --- | --- | --- |
| `read` | none | `{ document }`, with saved ownership/revision facts, or `document: null` |
| `list` | `keyPrefix?`, `keyStartExclusive?`, `keyEndInclusive?`, `cursor?`, `limit?` | `documents`, `cursor`, `isDone` |
| `write` | `value` | `revision`, `byteSize` |
| `write-batch` | Replace single collection/key with `documents: [{ collection, key, value }]` | `{ documents }` with each write result |
| `delete` | none | `{ deleted }` |

For example, a personal-key read body is `{ installationId: "<installation ID>", collection: "notes", key: "note-1" }`. A plugin uses the same body without `installationId`. Frame tokens may read/list, but cannot use HTTP writes. Member writes from a frame use its supported plugin-session Convex doors instead.

Private store scopes remain private: unreadable documents look absent and scoped lists can be empty. A list without `keyPrefix` reads the public part of that collection only. Do not apply Files' visible locked-row rule to private plugin-store documents.

## Pages and key ranges

`list` has a maximum `limit` of 100. Keys and bounds use the same printable-key rules. `keyStartExclusive` excludes that key; `keyEndInclusive` includes its bound. `keyPrefix` narrows the indexed key range.

Follow `cursor` until `isDone`. Keep collection, installation, and all range fields unchanged. A cursor from another range returns 400. It is opaque client state, not an access grant. A short page does not prove completion. For a durable continuation, a client may instead send the last returned key as `keyStartExclusive` with `cursor: null`, while keeping the other bounds.

`isDone` means the selected range ended. Files `read-many` and URL-batch `truncated` fields mean something different: send fewer inputs to avoid lost results. Store list paging has no HTTP count shortcut. Do not read a whole installation merely to count its documents.

## Service-owned versions and reservations

Only Service grants may call these four routes. They use `plugin_data:write`, and must also omit `installationId`.

| Suffix under `/api/v1/plugin-data/` | Body |
| --- | --- |
| `write-versioned` | `{ collection, key, revision, value }` |
| `delete-versioned` | `{ collection, key, revision }` |
| `reserve` | `{ collection, key, maximumBytes, idempotencyKey, expiresAt }` |
| `release-reservation` | `{ collection, key, idempotencyKey }` |

Revision is a positive integer. Versioned operations enforce the service's writer identity and revision order. An exact replay can succeed; changed content at the same revision or an older revision conflicts. A deletion retains its ordering proof, so an old retry cannot recreate it.

A reservation holds room before a service accepts work. Expiry is a future Unix-millisecond timestamp no more than eight days away. `reserve` returns `{ reservationId, remainingBytes, expiresAt }`. Save the idempotency key before calling. Reuse the same fields on retry. A changed replay, another writer, a released reservation, or out-of-order revision returns 409. Capacity refusals return 403. Do not invent a new key to bypass a refused retry.

The final store read/write rechecks the original credential, installation, actor, account binding, and current consent. Initial HTTP auth does not guarantee the later operation will succeed. Keep 401, 403, 404, and 409 distinct when handling retries.
