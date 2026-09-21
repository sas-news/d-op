import { spawn } from "node:child_process"
import net from "node:net"

// Task-23 process helpers (Windows-safe). Everything spawned here is tracked
// so the harness can tear down browsers/drivers/servers deterministically.

function tryListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(undefined))
    server.listen(port, "127.0.0.1", () => {
      const bound = server.address().port
      server.close(() => resolve(bound))
    })
  })
}

/** Returns `preferred` when free, else an OS-assigned free port. */
export async function findFreePort(preferred) {
  if (preferred !== undefined) {
    const bound = await tryListen(Number(preferred))
    if (bound !== undefined) return bound
  }
  return tryListen(0)
}

/** Is something already listening on 127.0.0.1:port? */
export async function portInUse(port) {
  return (await tryListen(Number(port))) === undefined
}

/**
 * Spawn a process with captured stdout/stderr (kept in memory, tail-exposed).
 * `options.echo` prefixes child output to this process's stderr for logs.
 */
export function spawnLogged(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  const childLog = { stdout: "", stderr: "" }
  const cap = (key) => (chunk) => {
    childLog[key] = (childLog[key] + chunk.toString()).slice(-64_000)
    if (options.echo === true) {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line !== "") process.stderr.write(`[${options.label ?? command}] ${line}\n`)
      }
    }
  }
  child.stdout.on("data", cap("stdout"))
  child.stderr.on("data", cap("stderr"))
  return { child, log: childLog }
}

/** Kill a process tree (taskkill /T on Windows, SIGTERM group elsewhere). */
export async function killTree(childOrPid) {
  const pid = typeof childOrPid === "number" ? childOrPid : childOrPid.pid
  if (pid === undefined || pid <= 0) return
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" })
      killer.once("exit", () => resolve())
      killer.once("error", () => resolve())
    })
    return
  }
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  }
}

/** Wait until `probe()` returns true or throw after `timeoutMs`. */
export async function waitFor(
  probe,
  { timeoutMs = 15_000, intervalMs = 200, label = "condition" } = {},
) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** HTTP GET helper that resolves once a URL answers (any status). */
export async function urlAlive(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
    return response.status > 0
  } catch {
    return false
  }
}

/**
 * Kill ONLY processes whose image name AND command line both match —
 * used to reap orphaned harness browsers (matched on the unique profile
 * dir in their args) without ever touching unrelated user processes.
 * Returns the killed PIDs.
 */
export async function killByCommandLine(imageName, cmdlineNeedle) {
  if (process.platform !== "win32") return []
  const { execFile } = await import("node:child_process")
  return new Promise((resolve) => {
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='${imageName}'" | ` +
          `Where-Object { $_.CommandLine -like '*${cmdlineNeedle.replaceAll("'", "''")}*' } | ` +
          `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }`,
      ],
      { timeout: 20_000 },
      (error, stdout) => {
        if (error) return resolve([])
        resolve(
          String(stdout)
            .split(/\r?\n/)
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isInteger(n) && n > 0),
        )
      },
    )
  })
}
