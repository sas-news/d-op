import http from "node:http"

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

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`)
  if (req.method === "GET" && url.pathname === "/harness.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-dop-fixture": MARKER })
    res.end(HARNESS_HTML)
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
