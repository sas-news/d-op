# Share API contract (v1)

The fixed public contract for `https://d-op.sasnews.dev/api/v1/playlists`.
The normative source is the Zod schema set in `packages/shared/src/api.ts`
(bodies, envelopes, error codes) and `packages/shared/src/share-model.ts`
(the `SharedPlaylist` projection); this page is the human-readable mirror.
If this page and the schemas ever disagree, the schemas win — every
example below is checked against them.

Route handlers live under `apps/web/src/pages/api/v1/playlists/`
(`index.ts`, `[shareId].ts`, `[shareId]/import.ts`, `tags.ts`); service
logic is in `apps/web/src/server/services/` and repositories in
`apps/web/src/server/repositories/`.

## Envelope and transport rules

- Success bodies are `{ "data": ... }`; failures are
  `{ "error": { "code", "message", "requestId", "details?" } }`.
  `details` carries validated field paths or the current revision on
  conflict — never raw bodies, secrets, or SQL.
- Mutations (`POST`/`PATCH`/`DELETE`) require an `Idempotency-Key: <uuid>`
  header. PATCH/DELETE additionally require
  `Authorization: Bearer <manageSecret>`. The manage secret never appears
  in a URL or body.
- `shareId` is base64url of 16 random bytes (22 chars, `[A-Za-z0-9_-]`);
  `manageSecret` is 32 random bytes (43 chars). The server stores only
  `SHA-256(domain || shareId || secret)` — never the plaintext.
- Request bodies are capped at 256 KiB enforced while streaming
  (`SHARE_REQUEST_BODY_MAX_BYTES`), before JSON parse.
- Capability responses carry `Cache-Control: no-store`. No CORS
  credential headers are ever sent; CORS is not authentication.
- `contentHash` is the SHA-256 (lowercase hex) of the canonical
  serialization of the stored snapshot — key order, NFC strings, absent
  optionals, item order, sorted tags fixed by
  `packages/shared/src/share-canonical.ts`. On `GET` it names the *stored*
  snapshot; when a public parent is hidden the returned `playlist` is a
  redacted projection, so the hash is NOT recomputable from the response
  body in that case.

## `SharedPlaylist` (publish/update body)

```json
{
  "schemaVersion": 1,
  "title": "お気に入りOP集",
  "description": "自分用メモ",
  "author": "sasnews",
  "tags": ["op", "ed"],
  "visibility": "public",
  "items": [
    {
      "partId": "27008001",
      "workId": "27008",
      "title": "作品タイトル",
      "episodeTitle": "第1話",
      "episodeNumber": "1",
      "range": { "start": 0, "end": 90000, "name": "OP" }
    }
  ]
}
```

Field budgets (all enforced by `SharedPlaylistSchema`, strict — unknown
keys reject): title 1–120 chars; description 0–2000 (line breaks kept);
author 0–80 (self-declared, unverified); up to 10 unique tags of 1–24
chars (NFC, trimmed, whitespace-collapsed, case-insensitively
deduplicated, sorted canonically); `visibility` is `public` or
`unlisted` and is REQUIRED on first publish — there is no default; items
1–200. Items: `partId`/`workId` are opaque ids of 1–128 chars
(`[A-Za-z0-9_-]` — never URLs); `title`/`episodeTitle` 1–300;
`episodeNumber` ≤64; `range.name` ≤80; `range.end` ≤ 86,400,000 ms; all
times are non-negative safe integers in **milliseconds** with
`start < end`. `derivedFrom` may be present only on first publication
(`{shareId, revision}` of an existing older public source) — see
`docs/decisions/003-provisional-publication.md` and Remix rules in
`docs/share.md`.

## Routes

| Method / path | Request | Success / semantics |
| --- | --- | --- |
| `POST /api/v1/playlists` | `SharedPlaylist` + `Idempotency-Key` | `201` `{data:{shareId,manageSecret,revision:1,contentHash,createdAt,activationExpiresAt,state:"pending"}}` + `Cache-Control: no-store`. Creates a **provisional** snapshot invisible to GET/list/import; activate within 1 h (`ACTIVATION_EXPIRES_AFTER_MS`). Replaying the same key after the ack was lost returns `409 CREATE_RECEIPT_UNAVAILABLE` — the secret is never re-issued. |
| `GET /api/v1/playlists/:shareId` | none | `200` `{data:{shareId,revision,publishedAt,updatedAt,contentHash,playlist,itemCount,totalDurationMs,importCount,source}}`. Only `active` records; `404` for absent/pending/deleted/blocked. `source` is the projected public parent or `null`. |
| `PATCH /api/v1/playlists/:shareId` | Bearer + `{operation:"activate",expectedRevision:1}` or `{operation:"replace",expectedRevision,playlist}` + `Idempotency-Key` | `200` `{data:{shareId,revision,contentHash,publishedAt,updatedAt}}`. `activate` moves pending → active at revision 2; replaying activate on the unchanged active publication returns current state. `replace` is full-snapshot replacement; revision increments once. |
| `DELETE /api/v1/playlists/:shareId` | Bearer + `{expectedRevision}` + `Idempotency-Key` | `204` (no-store). Authenticated replay returns `204`; stale revision `409`; unknown record `404`. Local data unaffected. |
| `POST /api/v1/playlists/:shareId/import` | `{eventId: <uuid>}` | `204` always for a well-formed body — including unknown/unlisted/deleted ids — so the endpoint is never an existence oracle. Only public active snapshots increment counts. Counting is deduplicated per event id AND per actor×share: a single actor can move a share's counters at most once per 48 h receipt window, so regenerating event ids cannot inflate `importCount`. |
| `GET /api/v1/playlists` | query `sort=new\|popular`, `q` (1–100), `tag` (1–24), `limit` (1–50, default 20), `cursor` | `200` `{data:{items:[GetPlaylistResponse…],nextCursor?,truncated?,ranking:{mode,effectiveWindow,asOf,fallbackReason?}}}`. Public active only. Invalid cursor `400`; expired `410`. |
| `GET /api/v1/playlists/tags` | none | `200` `{data:{tags:[{tag,count}]}}` — public-only tag dictionary for Explore filters. |

Unsupported methods return `405` with `Allow`.

### Response examples (validated against `packages/shared/src/api.ts`)

`POST` 201 create acknowledgement:

```json
{
  "data": {
    "shareId": "dGVzdCBzaGFyZSBpZCAwMQ",
    "manageSecret": "dGVzdCBtYW5hZ2Ugc2VjcmV0IGtleSAwMDAwMDAwMDA",
    "revision": 1,
    "contentHash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "createdAt": "2026-09-23T00:00:00.000Z",
    "activationExpiresAt": "2026-09-23T01:00:00.000Z",
    "state": "pending"
  }
}
```

`GET /:shareId` 200 (and each element of a collection `items` array):

```json
{
  "data": {
    "shareId": "dGVzdCBzaGFyZSBpZCAwMQ",
    "revision": 2,
    "publishedAt": "2026-09-23T00:01:00.000Z",
    "updatedAt": "2026-09-23T00:01:00.000Z",
    "contentHash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "playlist": { "schemaVersion": 1, "title": "お気に入りOP集", "description": "自分用メモ", "author": "sasnews", "tags": ["ed", "op"], "visibility": "public", "items": [{ "partId": "27008001", "workId": "27008", "title": "作品タイトル", "episodeTitle": "第1話", "episodeNumber": "1", "range": { "start": 0, "end": 90000, "name": "OP" } }] },
    "itemCount": 1,
    "totalDurationMs": 90000,
    "importCount": 0,
    "source": null
  }
}
```

`PATCH` 200 acknowledgement:

```json
{
  "data": {
    "shareId": "dGVzdCBzaGFyZSBpZCAwMQ",
    "revision": 2,
    "contentHash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "publishedAt": "2026-09-23T00:01:00.000Z",
    "updatedAt": "2026-09-23T00:01:00.000Z"
  }
}
```

`GET` collection 200:

```json
{
  "data": {
    "items": ["<GetPlaylistResponse objects as above>"],
    "nextCursor": "<opaque HMAC-signed cursor, present only when a next page exists>",
    "ranking": { "mode": "popular", "effectiveWindow": "30d", "asOf": "2026-09-23T00:05:00.000Z" }
  }
}
```

`GET …/tags` 200: `{ "data": { "tags": [{ "tag": "op", "count": 3 }] } }`.

Error envelope (every non-2xx):

```json
{ "error": { "code": "REVISION_CONFLICT", "message": "remote revision changed", "requestId": "req_01J…", "details": { "revision": 3 } } }
```

## Status codes

| Status | When |
| --- | --- |
| `400 BAD_REQUEST` | malformed JSON/query, bad cursor shape, missing `Idempotency-Key` |
| `401 UNAUTHORIZED` | missing/invalid manage secret — revision is never revealed pre-auth |
| `404 NOT_FOUND` | absent, pending, deleted, or blocked record (non-revealing) |
| `405 METHOD_NOT_ALLOWED` | unsupported method (`Allow` lists valid verbs) |
| `409` | `REVISION_CONFLICT` (details `{revision}`), `IDEMPOTENCY_CONFLICT` (same key, different request), `CREATE_RECEIPT_UNAVAILABLE` (lost create ack — never re-issues a secret) |
| `410 CURSOR_EXPIRED` | ranking snapshot expired (>15 min); restart from page 1 |
| `413 BODY_TOO_LARGE` | body exceeds the 256 KiB streaming cap |
| `415 UNSUPPORTED_MEDIA_TYPE` | missing/wrong `Content-Type` on mutation bodies |
| `422` | `SCHEMA_INVALID` (field paths in `details`) or `UNPUBLISHABLE` (empty playlist / null-range item) |
| `429 RATE_LIMITED` | limiter refused; `Retry-After: 60` |
| `503 TRANSIENT_FAILURE` | storage/limiter/misconfiguration failure — protection fails closed, never silently unlimited |

Rate-limit defaults (Workers binding, per-PoP approximate, period 60 s):
creates 5/min, authenticated mutations 30/min per actor per share, import
notifications 30/min per actor, reads 120/min per actor, plus the
route-wide `dop-api` bucket. Actor keys are a daily-rotating HMAC of the
connecting IP that never leaves the limiter. Mutation keys include the
actor digest AND the shareId: failed-auth floods against a public shareId
drain only the attacker's budget, never the share owner's.

## Consent and callers

The extension is the only mutating client and every one of its Share
fetches is consent-gated (`docs/share.md`). Public reads
(`GET /:shareId`, collection, tags, `/p/:shareId` SSR) are unauthenticated
by design — they expose only the whitelisted projection above.
