# d-Anime Player Contract (observed, baseline fc9d7fd)

> Task 25 note: the baseline root files cited below were removed after parity
> evidence; read them via `git show v1.0.0:<path>` (or the fc9d7fd commit).

Source: `injected.js:14-56,58-153,168-206`, `content.js` bridge
(`sendCommand`, `injectPageScript`, `CHAPTERS_FOUND` handling, enforcement),
`content-store.js:21-40` fetch path. Checked at
`fc9d7fd60a057c5054aadb49e7e1297320f313e4` without a logged-in session.
Everything touching the real player DOM/object is [UNVERIFIED] until a
separate authorized real-site run; the shape below is the code-observed
contract that task 8 must preserve or replace explicitly.

## 1. Worlds and injection

- [OBSERVED] `content.js` (isolated world) never touches `window.vc`. It
  injects `injected.js` once as `<script src=runtime.getURL(injected.js)>`
  (`injectPageScript`, guard id `d-op-injected-script`) and talks only via
  `window.postMessage` with `{source:'d-op-injected', direction, type,
  payload}` to `window.location.origin`.
- [OBSERVED] Both sides check `event.origin === window.location.origin` and
  `source === d-op-injected`; injected requires `direction === 'to-page'`,
  content requires `CHAPTERS_FOUND` from-page. No storage/share secrets ever
  cross this bridge (only bounded player data/commands).

## 2. Read surface (`extractChapters`, injected.js:105-128)

Observed read of `window.vc.ws010105Data`:
`{partId, workId, workTitle, partTitle, partDispNumber, duration, chapters[],
skipWaitTime, minTimeToSkip}`. Chapter entries forwarded as
`{index, start, end, type, showInterface}`. Units are **milliseconds**;
content converts with `seconds(ms)`. Key facts:

- `chapters[].type === 'none'` marks skippable sections; **no op/ed flag
  exists**, so OP/ED names are heuristic (`guessRangeName`). Polluted
  `partDispNumber` containing U+FFFD is nulled.
- Missing/empty chapters returns `null` (no chapters event).
- `getPlayer()` prefers `window.vc.videoEl`, falls back to `#video`.

## 3. Command surface (to-page)

| Type | Implementation | Fallback |
| --- | --- | --- |
| `SEEK {time}` (seconds) | `vc.jump(time)` if function, else `video.currentTime = time` | none; silent if no player |
| `PLAY {}` | `video.play()` if paused, `.catch` logged | none |
| `PAUSE {}` | up to 10 `pause()` retries every 100 ms until `paused` | none |
| `BLOCK_AUTO_ADVANCE` | patches `vc.goNext = noop`, `vc.procEndedEvent` to only clear `sentPauseResumeTimerId` | retries `ensureVcAndPatch(15)` every 200 ms until `vc` appears |
| `UNBLOCK_AUTO_ADVANCE` | restores saved `origGoNext/origProcEndedEvent` | same retry |
| `GO_NEXT` | unblocks, calls `vc.goNext()` | clicks `.buttonArea .next` if enabled |

Native skip cookie `op_skip` (`content.js:122-138`): playlist/custom-test
stores the original value and forces `0` + block; op-ed mode forces the
cookie without blocking; stop paths restore the cookie + unblock.
[UNVERIFIED] real auto-advance/cookie interplay.

## 4. Readiness, polling, navigation

- Initial: if `extractChapters()` is falsy, poll every 500 ms up to 30 tries
  (15 s), send `CHAPTERS_FOUND` once per new `partId`, then stop.
- SPA navigation: `MutationObserver` on `document` watches `location.href`;
  on change resets `lastPartId` and restarts polling.
- Content side `seekToStartWhenReady`: waits for `readyState>=1`+duration or
  `loadedmetadata` (3000 ms deadline), issues SEEK, waits for `seeked`
  within 0.5 s up to 3 attempts, then calls `onReady(play)`.
- Content `handleChapters`: on partId change resets or re-enters op-ed mode,
  reattaches video listeners, rebuilds UI/markers, runs URL-param and
  resume paths, then applies stored op-ed mode if fresh (<5 min) and
  session-flagged.
- Store fetch path (`content-store.js:21-40`): `GET sc_d_pc?partId=` with
  `credentials:same-origin`, regex for `"chapters"` + `"duration"`, null on
  any failure. [DEFECT] regex cannot handle nested JSON; fallback plays
  range 0. Task 8 replaces with a bounded explicit parser.

## 5. DOM touchpoints (all [UNVERIFIED] live)

`#video`, `.buttonArea .time/.prev/.next`, `.seekArea` (+`#seekThumb`,
`#seekPopupInWrap`), `#backInfo .backInfoTxt1/2/3`, `.itemModule` rows with
`a[href*=partId=]`, `h1/h3` titles. Adapter owns all of these in v2 (task 8);
production must not vendor player code and fixtures must stay synthetic.

## 6. What v2 must keep vs fix

Keep: world boundary, envelope + origin checks, ms-at-rest/seconds-at-adapter
rule, readiness handshake before chapter delivery, reversible method hooks
with restore, bounded polling with cleanup, same-origin fetch only.
Fix: regex parser, unbounded polling edge cases (`startPolling` re-entry,
observer cost), `GO_NEXT`/cookie behavior proven against the real player,
and any property the authorized real-site run shows to differ. Observed
method/property list (`vc.jump/goNext/procEndedEvent/videoEl/ws010105Data/
sentPauseResumeTimerId`) is recorded for task 8's adapter tests, not as a
guarantee the site keeps them.
