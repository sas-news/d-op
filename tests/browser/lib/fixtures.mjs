import http from "node:http"
import { spawnLogged } from "./procs.mjs"

// Task-23 fixture server for real browsers. Serves the SAME synthetic d-Anime
// shapes the Playwright specs intercept: an sc_d_pc player page (seekable WAV,
// window.vc contract, optional ?vcDelay= to block the adapter) and a work
// page with .itemModule episode rows. Also exposes an always-503 /api/v1/*
// so a second extension variant can prove bounded 503 handling without a
// real server. TEST-ONLY: bound to loopback, never shipped.

const VIDEO_SECONDS = 200

function playerHtml(vcDelayMs) {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>fixture player</title></head>
<body>
<a id="backInfo" href="/animestore/ci/work?workId=w1"><span class="backInfoTxt1">Fixture Work</span><span class="backInfoTxt2">第1話</span><span class="backInfoTxt3">Fixture Episode</span></a>
<video id="video" preload="auto"></video>
<div class="buttonArea"><button class="prev">prev</button><button class="next">next</button><div class="skipUi">skip</div><span class="time">0:00</span></div>
<div class="seekArea"><div id="seekThumb"></div><div id="seekPopupInWrap"></div></div>
<script>
(() => {
  const rate = 8000
  const seconds = ${VIDEO_SECONDS}
  const samples = rate * seconds
  const bytes = new Uint8Array(44 + samples * 2)
  const dv = new DataView(bytes.buffer)
  const text = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) bytes[offset + i] = value.charCodeAt(i)
  }
  text(0, "RIFF")
  dv.setUint32(4, 36 + samples * 2, true)
  text(8, "WAVE")
  text(12, "fmt ")
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true)
  dv.setUint32(24, rate, true)
  dv.setUint32(28, rate * 2, true)
  dv.setUint16(32, 2, true)
  dv.setUint16(34, 16, true)
  text(36, "data")
  dv.setUint32(40, samples * 2, true)
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }))
  document.getElementById("video").src = blobUrl
  window.__fixture = { jumps: [], videoUrl: blobUrl }
  const target = () => document.getElementById("video")
  const installVc = () => {
    window.vc = {
      ws010105Data: {
        "duration": ${VIDEO_SECONDS * 1000},
        "chapters": [
          { "start": 0, "end": 90000, "type": "none" },
          { "start": 110000, "end": 200000, "type": "none" }
        ],
      },
      jump: (value) => {
        window.__fixture.jumps.push(value)
        target().currentTime = value
      },
      goNext: () => {},
      procEndedEvent: () => {},
    }
  }
  const delay = ${vcDelayMs}
  if (delay > 0) setTimeout(installVc, delay)
  else installVc()
  window.__dopSetTime = (value) => {
    const v = target()
    v.currentTime = value
    v.dispatchEvent(new Event("timeupdate"))
  }
  window.__dopReplaceVideo = () => {
    const old = document.getElementById("video")
    const v = document.createElement("video")
    v.id = "video"
    v.preload = "auto"
    v.src = window.__fixture.videoUrl
    old.replaceWith(v)
    return true
  }
})()
</script>
</body></html>`
}

const WORK_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>fixture work</title></head>
<body>
<h1>Fixture Work Title</h1>
<div class="itemModule"><a href="/animestore/sc_d_pc?partId=p1">第1話</a><h3>第1話 サブタイ</h3></div>
<div class="itemModule"><a href="/animestore/sc_d_pc?partId=p2">第2話</a><h3>第2話 サブタイ</h3></div>
</body></html>
`

const ALWAYS_503 = JSON.stringify({
  error: { code: "UNAVAILABLE", message: "fixture 503", requestId: "fixture-503" },
})

export function startFixtureServer({ host = "127.0.0.1", port = 8123 } = {}) {
  const requests = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`)
    requests.push(`${req.method} ${url.pathname}${url.search}`)
    if (url.pathname === "/animestore/sc_d_pc") {
      const vcDelay = Number(url.searchParams.get("vcDelay") ?? "0")
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      res.end(playerHtml(Number.isFinite(vcDelay) ? vcDelay : 0))
      return
    }
    if (url.pathname.startsWith("/animestore/")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      res.end(WORK_HTML)
      return
    }
    if (url.pathname.startsWith("/api/v1/")) {
      res.writeHead(503, { "content-type": "application/json; charset=utf-8" })
      res.end(ALWAYS_503)
      return
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    res.end("not found")
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => {
      resolve({
        port,
        requests,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.()
            server.close(() => done())
          }),
      })
    })
  })
}

/**
 * Start the real Share web app (Astro SSR + Cloudflare platformProxy local
 * D1) on `port`. Requires apps/web/dist — the harness builds it beforehand.
 * `wrangler d1 migrations apply --local` must have run once (harness does).
 */
export function startSharePreview({ webDir, port }) {
  const child = spawnLogged(
    "bunx",
    ["astro", "preview", "--ignore-lock", "--host", "127.0.0.1", "--port", String(port)],
    { cwd: webDir, label: "astro-preview" },
  )
  const ready = new Promise((resolve, reject) => {
    const deadline = Date.now() + 90_000
    const poll = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(3000),
        })
        if (res.ok || res.status === 404) {
          resolve()
          return
        }
      } catch {}
      if (child.child.exitCode !== null) {
        reject(
          new Error(
            `astro preview exited ${child.child.exitCode}: ${child.log.stderr.slice(-800)}`,
          ),
        )
        return
      }
      if (Date.now() > deadline) {
        reject(new Error("astro preview did not come up in 90s"))
        return
      }
      setTimeout(poll, 400)
    }
    void poll()
  })
  return { child, ready, close: () => child.child.kill("SIGTERM") }
}
