// Minimal W3C WebDriver + geckodriver (Marionette) client — task-23 native
// Firefox harness. Plain HTTP over fetch; no external dependency. Covers only
// the commands the parity scenario needs:
//   session lifecycle, navigation, sync/async script, element click/text,
//   window handles, screenshot, moz:context switch, moz:addon install/uninstall.
//
// geckodriver endpoints are the *supported* native-extension automation path
// for real Firefox binaries (Playwright's patched Firefox is never used here).

export class WebDriverError extends Error {
  constructor(method, path, status, body) {
    const detail =
      body?.value !== undefined
        ? `${body.value.error ?? "error"}: ${body.value.message ?? ""}`
        : `HTTP ${status}`
    super(`${method} ${path} -> ${detail}`)
    this.status = status
    this.body = body
    this.webdriverError = body?.value?.error
  }
}

export class WebDriverClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl
    this.sessionId = undefined
  }

  async request(method, path, body) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { value: text }
    }
    if (!response.ok || parsed?.value?.error !== undefined) {
      throw new WebDriverError(method, path, response.status, parsed)
    }
    return parsed.value
  }

  sessionPath(suffix) {
    if (this.sessionId === undefined) throw new Error("no active session")
    return `/session/${this.sessionId}${suffix}`
  }

  async newSession(capabilities) {
    const value = await this.request("POST", "/session", {
      capabilities: { alwaysMatch: capabilities },
    })
    this.sessionId = value.sessionId
    this.capabilities = value.capabilities
    return value
  }

  async deleteSession() {
    if (this.sessionId === undefined) return
    const path = `/session/${this.sessionId}`
    this.sessionId = undefined
    try {
      await this.request("DELETE", path)
    } catch {
      // Session may already be gone (browser quit) — teardown is best-effort.
    }
  }

  navigate(url) {
    return this.request("POST", this.sessionPath("/url"), { url })
  }

  getUrl() {
    return this.request("GET", this.sessionPath("/url"))
  }

  title() {
    return this.request("GET", this.sessionPath("/title"))
  }

  setTimeouts(timeouts) {
    return this.request("POST", this.sessionPath("/timeouts"), timeouts)
  }

  /** Synchronous script; `script` is a function body returning a value. */
  execute(script, args = []) {
    return this.request("POST", this.sessionPath("/execute/sync"), { script, args })
  }

  /** Async script; last argument is the callback the script must invoke. */
  executeAsync(script, args = []) {
    return this.request("POST", this.sessionPath("/execute/async"), { script, args })
  }

  /** Poll `script` (sync, truthy) until it returns a truthy value. */
  async waitForScript(script, { timeoutMs = 15_000, intervalMs = 200, label } = {}) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      let value
      try {
        value = await this.execute(script)
      } catch (error) {
        if (error instanceof WebDriverError && error.webdriverError === "no such window")
          throw error
        value = undefined
      }
      if (value) return value
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for script: ${label ?? script.slice(0, 80)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  async findElement(css) {
    try {
      const value = await this.request("POST", this.sessionPath("/element"), {
        using: "css selector",
        value: css,
      })
      return value["element-6066-11e4-a52e-4f735466cecf"] ?? value.ELEMENT
    } catch (error) {
      if (error instanceof WebDriverError && error.webdriverError === "no such element") {
        return undefined
      }
      throw error
    }
  }

  async findElements(css) {
    const value = await this.request("POST", this.sessionPath("/elements"), {
      using: "css selector",
      value: css,
    })
    return value.map((entry) => entry["element-6066-11e4-a52e-4f735466cecf"] ?? entry.ELEMENT)
  }

  /** Wait for a css selector to exist; returns element id. */
  async waitForElement(css, options = {}) {
    await this.waitForScript(`return document.querySelector(${JSON.stringify(css)}) !== null`, {
      ...options,
      label: `element ${css}`,
    })
    return this.findElement(css)
  }

  click(elementId) {
    return this.request("POST", this.sessionPath(`/element/${elementId}/click`), {})
  }

  sendKeys(elementId, text) {
    return this.request("POST", this.sessionPath(`/element/${elementId}/value`), { text })
  }

  elementText(elementId) {
    return this.request("GET", this.sessionPath(`/element/${elementId}/text`))
  }

  elementAttribute(elementId, name) {
    return this.request("GET", this.sessionPath(`/element/${elementId}/attribute/${name}`))
  }

  elementEnabled(elementId) {
    return this.request("GET", this.sessionPath(`/element/${elementId}/enabled`))
  }

  windowHandles() {
    return this.request("GET", this.sessionPath("/window/handles"))
  }

  currentWindowHandle() {
    return this.request("GET", this.sessionPath("/window"))
  }

  switchToWindow(handle) {
    return this.request("POST", this.sessionPath("/window"), { handle })
  }

  /** Close the current top-level browsing context; returns remaining handles. */
  async closeWindow() {
    return this.request("DELETE", this.sessionPath("/window"))
  }

  /** Open a new tab or window; returns its handle. */
  async newWindow(type = "tab") {
    const value = await this.request("POST", this.sessionPath("/window/new"), { type })
    return value.handle
  }

  /** Ensure the session has a live browsing context; creates a tab if all
   *  windows were discarded (e.g. add-on uninstall closed extension tabs). */
  async ensureWindow() {
    const handles = await this.windowHandles().catch(() => [])
    if (handles.length === 0) {
      const handle = await this.newWindow("tab")
      await this.switchToWindow(handle)
      return handle
    }
    // Current window may be dead — probe and recover if needed.
    try {
      await this.getUrl()
    } catch {
      await this.switchToWindow(handles[0])
    }
    return this.currentWindowHandle()
  }

  /** Close the current window and switch to any remaining handle. */
  async closeCurrentWindow() {
    try {
      const remaining = await this.closeWindow()
      if (Array.isArray(remaining) && remaining.length > 0) {
        await this.switchToWindow(remaining[0])
      }
      return remaining
    } catch {
      const handles = await this.windowHandles()
      if (handles.length > 0) await this.switchToWindow(handles[0])
      return handles
    }
  }

  /** Wait until a window handle appears that isn't in `known` (a Set). */
  async waitForNewWindow(known, { timeoutMs = 15_000, intervalMs = 200 } = {}) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const handles = await this.windowHandles()
      const fresh = handles.find((handle) => !known.has(handle))
      if (fresh !== undefined) return fresh
      if (Date.now() > deadline) throw new Error("timed out waiting for a new window handle")
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  screenshot() {
    return this.request("GET", this.sessionPath("/screenshot"))
  }

  // ---- geckodriver moz: extension endpoints ----

  async mozContext() {
    return this.request("GET", this.sessionPath("/moz/context"))
  }

  async mozSetContext(context) {
    return this.request("POST", this.sessionPath("/moz/context"), { context })
  }

  /** Install an add-on. `path` is an absolute .xpi/zip or unpacked dir. */
  async installAddon(path, { temporary = true } = {}) {
    return this.request("POST", this.sessionPath("/moz/addon/install"), { path, temporary })
  }

  async uninstallAddon(id) {
    return this.request("POST", this.sessionPath("/moz/addon/uninstall"), { id })
  }
}
