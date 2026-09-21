# Production cutover runbook (task 29)

Moving the canonical site `https://d-op.sasnews.dev` from **GitHub Pages**
(branch `gh-pages`) to the **d-OP v2 Worker** (`d-op-share`, Cloudflare
Workers + D1), then retiring the legacy hosting safely.

> **Order is the safety property.** Nothing is deleted until: the archive
> refs exist and are pushed, the Worker serves the canonical domain with a
> green `verify:cutover`, a health window has passed, and rollback has been
> rehearsed. If any step is blocked, legacy hosting and branches stay
> exactly as they are.
>
> **Never merge histories.** `gh-pages` is an *orphan* history — it has no
> merge-base with `main` (verified: `git merge-base origin/gh-pages main`
> returns empty). Preservation is by archive tag, never by merging or
> cherry-picking the site history into main. `dev` is fully contained in
> main (`git merge-base origin/dev main` = dev's tip), but it gets the same
> archive treatment before retirement.

## 0. Prerequisites — all must be confirmed before step 1

| Prerequisite | How to confirm | Status at authoring |
|---|---|---|
| Production authorization (owner sign-off to cut over) | Recorded owner approval in evidence | **PENDING — human decision** |
| Cloudflare account with Workers + D1 enabled on its actual plan | `bunx wrangler whoami` shows the target account; dashboard → Workers & Pages → D1 | **BLOCKED — `wrangler whoami` → Not logged in** |
| `sasnews.dev` DNS zone active on the same Cloudflare account | dashboard → Websites shows the zone Active; Workers custom domains require the zone on the account | **UNVERIFIED — needs the account** |
| GitHub admin (Pages read + settings + branch delete) | `gh api repos/sas-news/d-op/pages` returns current state | **READY — `gh` authenticated as `sas-news` (`repo` scope)** |
| Store accounts for the eventual release (CWS + AMO) | dashboards reachable | not needed for cutover; needed for the release gate in §9 |
| Authorized logged-in d-Anime session for the real-player smoke | operator confirms a real account is available (2FA means no static test accounts — see STORE_LISTING.md) | **PENDING — release-blocking if absent** |

No secret values are ever typed into chat, docs, or the repo. Secrets go
through `wrangler secret put` hidden prompts only. Real D1 ids come only
from `wrangler d1 create` output — never guessed, same convention as
staging (`docs/staging.md`).

## 1. Record the before-state (read-only)

```sh
# GitHub Pages settings BEFORE the cutover (authorized CLI read)
gh api repos/sas-news/d-op/pages > .omo/evidence/task-29-d-op-v2-share/pages-before.json

# Remote refs and DNS answers BEFORE the cutover
git ls-remote origin > .omo/evidence/task-29-d-op-v2-share/ls-remote-before.txt
nslookup d-op.sasnews.dev >> .omo/evidence/task-29-d-op-v2-share/dns-before.txt 2>&1
```

Expected before-state (recorded 2026-09-22 in this repo's evidence):
`Pages status "built", source gh-pages /, cname d-op.sasnews.dev,
https_enforced true, build_type "legacy"`, `origin/gh-pages = 59399be…`,
`origin/dev = 71597cb…`, and DNS `d-op` is a **CNAME → sas-news.github.io**
answering with the GitHub Pages blocks `185.199.108-111.*` and
`2606:50c0:8000-8003::153`. The obsolete DNS target to remove at cutover
is that CNAME.

## 2. Archive the legacy refs — before ANY deletion

```sh
node scripts/archive-legacy-site.mjs            # create + verify local archive tags
node scripts/archive-legacy-site.mjs --verify-only
git push origin archive/gh-pages-pre-cutover archive/dev-pre-cutover
git ls-remote origin "refs/tags/archive/*"      # both tags MUST be visible remotely
```

The script pins `archive/gh-pages-pre-cutover -> 59399be…` (the
plan-preserved site revision; a moved remote tip needs `--allow-moved`
plus human confirmation) and `archive/dev-pre-cutover -> origin/dev`, and
writes `git ls-tree -r` manifests of the owned site assets into the
evidence dir. Archive tags are immutable — the script refuses to move one
rather than silently re-pointing it. **Do not continue until both tags are
pushed.** A local-only tag is not a durable archive.

## 3. Provision production

`sasnews.dev` must be an active zone on the same Cloudflare account —
Workers custom domains cannot attach to an externally hosted zone. If the
zone is not on Cloudflare, the cutover is **blocked** (onboard the zone
first; do not improvise a CNAME workaround that serves the worker without
a managed cert).

```sh
cd apps/web
bunx wrangler d1 create dop_share               # -> paste the REAL database_id…
# …into d1_databases[0].database_id in wrangler.jsonc (replaces the all-zero
# placeholder; the build then carries it into dist/server/wrangler.json)

# Attach the canonical domain at deploy time (keeps intent in the repo —
# the dashboard alternative is noted in step 4):
#   "routes": [{ "pattern": "d-op.sasnews.dev", "custom_domain": true }]
# added to wrangler.jsonc BEFORE the build below.

bunx wrangler d1 migrations apply dop_share --remote --config wrangler.jsonc
bunx astro build                                # regenerates dist/server/entry.mjs + dist/client
bunx wrangler deploy --config dist/server/wrangler.json
bunx wrangler secret put RATE_LIMIT_HMAC_KEY --config wrangler.jsonc   # NEW value ≠ staging
```

The deployed worker is `d-op-share`; its workers.dev origin is
`https://d-op-share.<subdomain>.workers.dev`. Rate-limit namespaces
(`dop-*`) create themselves on deploy. There is intentionally no
`triggers.crons` — the task-28 finding (no `scheduled` export exists;
`docs/staging.md` §9) still holds; TTL pruning relies on the lazy
per-request sweep until a `scheduled` handler ships.

## 4. Attach the canonical domain

Order inside this step (a short dark window on `d-op.sasnews.dev` between
4a and 4c is inherent to the cutover — nothing else is affected):

1. **Remove the obsolete DNS target** — the `d-op` CNAME to
   `sas-news.github.io` recorded in `dns-before.txt` (or the equivalent
   GitHub A `185.199.108-111.153` / AAAA `2606:50c0:8000-8003::153`
   records). A conflicting record blocks the custom-domain attach.
2. **Attach the domain.** With the `routes` block from step 3 the deploy
   already requested it; alternatively dashboard → `d-op-share` →
   Settings → Domains & Routes → Add custom domain `d-op.sasnews.dev`.
   `custom_domain` makes Cloudflare create the managed DNS record and
   issue the certificate automatically — wait for domain status "Active"
   (cert issuance can take minutes).
3. Confirm `nslookup d-op.sasnews.dev` answers with Cloudflare-managed
   records and no `*.github.io` / `185.199.*` / `2606:50c0:*` answers —
   that is exactly what `verify:cutover`'s `dns-resolution` check then
   asserts in step 5.

## 5. Verify the cutover — the gate

```sh
bun run verify:cutover -- --base-url=https://d-op.sasnews.dev \
  --evidence .omo/evidence/task-29-d-op-v2-share/cutover-evidence.json
```

Exit 0 is required. The script proves (read-only, creates nothing on
production):

- DNS resolves and is **not** in GitHub Pages ranges (`185.199.108-111.*`)
- TLS certificate valid, hostname-matched, ≥7 days to expiry
- `http://` → `https://` redirect; `www` apex redirect if the alias exists
- `/`, `/explore`, `/privacy`, `/terms` return the v2 SSR shell
  (`data-testid="site-header"` — the legacy site has no test ids)
- `/p/<synthetic-id>` returns the d-OP not-found view (404 + shell), not a
  platform error page
- `/PRIVACY.md` → 301 `/privacy` (legacy link preservation, task 21);
  `/favicon.svg` + `/assets/d-OP-icon.png` served
- `GET /api/v1/playlists/tags`, `GET /api/v1/playlists?sort=new` → 200
  contract envelopes; `GET /api/v1/playlists/<absent>` → 404 `NOT_FOUND`
  envelope; `POST` without content-type → 4xx edge rejection, `POST` with
  malformed JSON → 4xx `{error:{code,requestId}}` envelope (never a 201 —
  this gate never mutates production)
- Security headers on SSR + API; `Server` header is not GitHub; no
  secret/debug leakage in headers or bodies

A failure names the check and leaves legacy hosting untouched by
definition — nothing destructive has run yet.

### Disposable share on production (operator QA happy-path)

`verify:cutover` is deliberately non-mutating. To prove real
publish/read/delete on production after the domain is live, the operator
runs the same disposable flow `verify:staging` exercises — either through
the real extension (consent → publish → URL works → delete) or the API
contract sequence in `docs/share.md`:

```
POST /api/v1/playlists (SharedPlaylist, Idempotency-Key)  -> 201 pending
PATCH /api/v1/playlists/<id> {operation:"activate",expectedRevision:1}  -> rev 2
GET  /api/v1/playlists/<id>            -> 200 active snapshot
GET  /explore (public only)            -> listed under its tag
DELETE /api/v1/playlists/<id> {expectedRevision:2} -> 204
GET  /api/v1/playlists/<id>            -> 404
```

Repeat once for `visibility:"unlisted"` (listed nowhere, readable by
link). Both runs must end with the rows deleted; record the redacted
request log in evidence. This is the QA "canonical links and newly
created disposable public/unlisted share function" check — and the ONLY
writes production should ever see from verification.

## 6. Health window

Before any destructive step, let the deployment bake (recommended ≥24 h):

```sh
bunx wrangler tail --config dist/server/wrangler.json
```

Legitimate output is ONLY the redacted
`{"event":"api_request","requestId","route":"<METHOD> /api/v1/…","status","durationMs"}`
records — any raw URL, shareId, IP, Authorization header, body or SQL is a
privacy incident: capture it and stop. Dashboard metrics for `d-op-share`
(requests/errors/duration + D1 volume) and the budget notifications set up
per `docs/staging.md` §7 are the standing health signal.

## 7. Rollback rehearsal — BEFORE destructive retirement

Both legs must be rehearsed/proven while nothing is irreversible:

**Worker leg (live-rehearse):**

```sh
bunx wrangler deployments list --config dist/server/wrangler.json
bunx wrangler rollback --config dist/server/wrangler.json
bun run verify:cutover -- --base-url=https://d-op.sasnews.dev   # must still pass
# then roll forward to the current version (wrangler rollback <newer-id>
# or redeploy dist/server/wrangler.json)
```

Migrations are additive, so an older worker on a newer schema is valid —
the verify run is the compatibility proof; a failure means roll forward,
never edit data.

**Site leg (document + dry-check):** if the Worker becomes unhealthy long
term, the site falls back to Pages — which is why Pages/branches survive
until now. The rollback is: `d-op` DNS back to the records saved in
`dns-before.txt` (CNAME `sas-news.github.io`), with Pages still enabled
(state from `pages-before.json`). If rollback is needed AFTER step 8
already disabled Pages, first restore the site object and branch:

```sh
git push origin archive/gh-pages-pre-cutover:refs/heads/gh-pages
gh api -X POST repos/sas-news/d-op/pages \
  -f "source[branch]=gh-pages" -f "source[path]=/"
```

Rehearse by confirming the recorded commands and that the archive tags
resolve; execute only on a real incident.

## 8. Destructive steps — ONLY after steps 2–7 are evidenced

```sh
# a) Disable GitHub Pages (site object removed; branch untouched yet)
gh api -X DELETE repos/sas-news/d-op/pages
gh api repos/sas-news/d-op/pages     # after-state: expect 404 — record it

# b) Confirm archive refs are remote BEFORE deleting branches (again)
git ls-remote origin "refs/tags/archive/*"   # BOTH tags must appear

# c) Retire the legacy branches
git push origin --delete gh-pages dev
# local cleanup (if local copies exist): git branch -D gh-pages dev
```

- Recovery after retirement: `git push origin <archive-tag>:refs/heads/<name>`
  restores a branch from its archive tag; the full tree is also in the
  `*-tree.txt` manifests.
- Never merge the gh-pages history into main or any product branch — it is
  an unrelated orphan line kept only as an archive.
- If ANY of steps 2–7 failed or is missing evidence: stop here. Pages,
  DNS, and both branches stay exactly as recorded in `ls-remote-before.txt`.

## 9. Release gates that ride on this cutover

**Real d-Anime smoke (production Extension release blocker).** Synthetic
fixtures and Playwright suites are NOT this check. With an authorized
logged-in session, record on real d-Anime: OP/ED skip on a real work page,
playlist playback, markers, window handling — on Chrome stable **and**
Firefox stable/ESR, noting exact browser versions, and label every record
**logged-in real session** vs **synthetic fixture** (never conflate). No
credentials in evidence — redact account identifiers. If no authorized
session exists, record `NOT RUN` and the production Extension release
stays **BLOCKED** — only that step is blocked; the site cutover itself is
independent.

**Store uploads remain draft/review.** CWS/AMO submissions are human
draft uploads per `docs/release.md` — the cutover does not auto-publish
anything; review gates apply normally.

## 10. Failure matrix — what stays intact

| Failure | State afterwards |
|---|---|
| `verify:cutover` fails (DNS/TLS/API/shell) | Pages still serving; nothing deleted; fix and re-run |
| Worker deploy/rollback fails | `wrangler rollback` or Pages fallback leg (§7); branches intact |
| Archive script fails or remote tags missing | No deletion runs — step 8 is gated on pushed archive tags |
| Real-player smoke unavailable | Release blocked, site unaffected — recorded `NOT RUN`, never faked |
| Pages disable API denied | Investigate authorization; branches remain; domain already on Worker so site keeps working |
