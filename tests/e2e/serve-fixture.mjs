import fs from "node:fs"
import http from "node:http"
import path from "node:path"

// Task-5 synthetic fixture server (TEST-ONLY, never shipped).
// Serves a deterministic DOM page plus a JSON endpoint on a fixed loopback
// origin so Playwright asserts real browser/network behavior without touching
// production or external origins. Started and torn down by Playwright
// webServer; the DOP_TEST_FIXTURE marker lets the artifact checker prove this
// origin never enters production bundles.
const HOST = "127.0.0.1"
const PORT = 8123
const MARKER = "DOP_TEST_FIXTURE"

const HARNESS_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>d-OP task-5 harness</title></head>
<body>
<!-- ${MARKER} -->
<main>
<h1 data-testid="harness-title">d-OP task-5 harness</h1>
<p data-testid="harness-status">fixture:ok</p>
</main>
</body>
</html>
`

const ADAPTER_BRIDGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>d-OP adapter bridge fixture</title></head>
<body><main><h1 data-testid="adapter-title">adapter bridge fixture</h1><video id="video"></video><button class="buttonArea next">next</button></main>
<script>
window.vc = { ws010105Data: { duration: 120000, chapters: [{ start: 0, end: 90000, type: 'none' }] }, jump: (seconds) => { window.__adapterFixture.jumps.push(seconds); }, goNext: () => { window.__adapterFixture.nextCalls += 1; } };
window.__adapterFixture = { events: [], jumps: [], nextCalls: 0 };
window.addEventListener('d-op-player-bridge', (event) => window.__adapterFixture.events.push(event.detail.kind));
</script>
<script src="/danime-isolated-runtime.js"></script>
<script src="/danime-main.js"></script>
</body></html>
`

const outputRoot = path.resolve("apps/extension/.output")

function extensionScript(browser, filename) {
  const target = browser === "firefox" ? "firefox-mv3" : "chrome-mv3"
  return fs.readFileSync(path.join(outputRoot, target, filename))
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`)
  if (req.method === "GET" && url.pathname === "/harness.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-dop-fixture": MARKER })
    res.end(HARNESS_HTML)
    return
  }
  if (req.method === "GET" && url.pathname === "/adapter-bridge.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-dop-fixture": MARKER })
    res.end(ADAPTER_BRIDGE_HTML)
    return
  }
  if (req.method === "GET" && url.pathname === "/danime-main.js") {
    const browser = req.headers["user-agent"]?.includes("Firefox") ? "firefox" : "chrome"
    res.writeHead(200, {
      "content-type": "application/javascript; charset=utf-8",
      "x-dop-fixture": MARKER,
    })
    res.end(extensionScript(browser, "danime-main.js"))
    return
  }
  if (req.method === "GET" && url.pathname === "/danime-isolated-runtime.js") {
    const browser = req.headers["user-agent"]?.includes("Firefox") ? "firefox" : "chrome"
    res.writeHead(200, {
      "content-type": "application/javascript; charset=utf-8",
      "x-dop-fixture": MARKER,
    })
    res.end(extensionScript(browser, "danime-isolated-runtime.js"))
    return
  }
  if (req.method === "GET" && url.pathname === "/api/fixture") {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "x-dop-fixture": MARKER,
    })
    res.end(JSON.stringify({ marker: MARKER, status: "ok", value: 42 }))
    return
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
  res.end("not found")
})

const sockets = new Set()
server.on("connection", (socket) => {
  sockets.add(socket)
  socket.on("close", () => {
    sockets.delete(socket)
  })
})

function shutdown() {
  for (const socket of sockets) {
    socket.destroy()
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

server.listen(PORT, HOST, () => {
  console.log(`dop-fixture-ready http://${HOST}:${PORT}/harness.html`)
})
