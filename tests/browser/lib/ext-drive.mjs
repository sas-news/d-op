// Shared page-driving helpers for the task-23 native browser harness.
// Every step drives the REAL extension surfaces: the options page UI,
// the content-script DOM on the fixture player page, the share dialog,
// and the extension-owned import page. Storage reads go through the same
// DOP_STORAGE_* runtime messages the UI uses — never raw storage writes.

/** Runtime-message round trip from an extension page (options/import).
 *  Works under both `browser` (Firefox / WXT polyfill) and `chrome` (MV3
 *  promise-returning sendMessage). */
export async function sendMessage(c, message) {
  return c.executeAsync(
    `const done = arguments[arguments.length-1];
     const rt = (globalThis.browser ?? globalThis.chrome).runtime;
     rt.sendMessage(${JSON.stringify(message)})
       .then(r => done({ok: true, reply: r === undefined ? null : r}))
       .catch(e => done({ok: false, error: String(e && e.message || e)}))`,
  )
}

export async function readPublic(c) {
  const r = await sendMessage(c, { type: "DOP_STORAGE_READ_PUBLIC" })
  if (!r.ok) throw new Error(`DOP_STORAGE_READ_PUBLIC failed: ${r.error}`)
  return r.reply
}

export async function readVault(c) {
  const r = await sendMessage(c, { type: "DOP_STORAGE_READ_VAULT" })
  if (!r.ok) throw new Error(`DOP_STORAGE_READ_VAULT failed: ${r.error}`)
  return r.reply
}

export async function openOptions(c, extBase) {
  await c.navigate(`${extBase}/options.html`)
  await c.waitForElement("#optionsVersion", { timeoutMs: 15_000 })
  // Playlist render is async; wait for the container to settle.
  await c.waitForScript(`return document.querySelector("#playlistsContainer") !== null`, {
    timeoutMs: 10_000,
    label: "options playlistsContainer",
  })
}

/**
 * Firefox ≥140 native data-collection consent: the doorhanger's accept path
 * performs `ExtensionPermissions.add(extension.id, perms, extension)` — the
 * third argument is the extension object itself, whose emitter live-updates
 * `extension.dataCollectionPermissions`. Headless marionette cannot render
 * the doorhanger, so the harness performs THE SAME store write through
 * chrome context, satisfying the native layer; the in-extension decision is
 * still recorded by clicking the real UI grant button afterwards (the
 * product path `permissions.request` then resolves instantly because every
 * category is already granted).
 * Skipped when `permissions.getAll()` has no `data_collection` key (ESR/older
 * builds without the native layer — the in-extension decision alone gates).
 */
export async function grantNativeDataCollectionIfPresent(c, geckoId) {
  await c.mozSetContext("chrome")
  const applied = await c.executeAsync(
    `const done = arguments[arguments.length-1];
     (async () => {
       if (!Services.prefs.getBoolPref("extensions.dataCollectionPermissions.enabled", false)) {
         return "absent"
       }
       const { ExtensionPermissions } = ChromeUtils.importESModule(
         "resource://gre/modules/ExtensionPermissions.sys.mjs")
       const ext = WebExtensionPolicy.getByID(${JSON.stringify(geckoId)})?.extension
       if (!ext) return "no-extension"
       await ExtensionPermissions.add(ext.id, {
         permissions: [], origins: [],
         data_collection: ["websiteContent", "personallyIdentifyingInfo", "technicalAndInteraction"],
       }, ext)
       return { granted: [...ext.dataCollectionPermissions] }
     })().then(done, e => done("err:" + e))`,
  )
  await c.mozSetContext("content")
  return applied
}

/** Click the real consent-grant button on the options page; waits for the
 *  persisted "granted" status text to render. */
export async function grantConsentOnOptions(c) {
  const status = `[data-testid="share-consent-status"]`
  const grant = `[data-testid="share-consent-grant"]`
  await c.waitForScript(`return document.querySelector(${JSON.stringify(status)}) !== null`, {
    timeoutMs: 15_000,
    label: "consent status",
  })
  const state = await c.execute(
    `const el = document.querySelector(${JSON.stringify(status)});
     return el ? el.textContent : ""`,
  )
  if (!String(state).includes("有効")) {
    await c.waitForElement(grant, { timeoutMs: 5_000 })
    await c.execute(`document.querySelector(${JSON.stringify(grant)}).click()`)
    await c.waitForScript(
      `const el = document.querySelector(${JSON.stringify(status)});
       return el !== null && el.textContent.includes("有効")`,
      { timeoutMs: 15_000, label: "consent granted status" },
    )
  }
  return readVault(c).then((v) => v?.shareConsent?.choice ?? "missing")
}

/**
 * On the fixture player page: open the ♪ add menu, pick the popup row whose
 * label contains `rowText`, create playlist `playlistName`, confirm.
 * Returns the created playlist's id (read back via storage message on an
 * options page opened by the caller — this function stays on the player
 * page and returns the pre-commit state check only).
 */
export async function playerAddRange(c, { rowText, playlistName }) {
  // Reveal the hover/focus-driven popup through the real mouseenter path.
  await c.waitForElement("#d-op-add-wrapper", { timeoutMs: 20_000 })
  await c.waitForScript(
    `return document.querySelectorAll("#d-op-add-popup .d-op-popup-item").length > 0`,
    { timeoutMs: 20_000, label: "add-popup rows (chapters arrived)" },
  )
  await c.execute(
    `document.getElementById("d-op-add-wrapper").dispatchEvent(
       new MouseEvent("mouseenter", { bubbles: true }))`,
  )
  await c.waitForScript(
    `return document.getElementById("d-op-add-popup").classList.contains("d-op-popup-visible")`,
    { timeoutMs: 5_000, label: "add-popup visible" },
  )
  const clicked = await c.execute(
    `const rows = [...document.querySelectorAll("#d-op-add-popup .d-op-popup-item")];
     const row = rows.find(r => r.textContent.includes(${JSON.stringify(rowText)}));
     if (row === undefined) return rows.map(r => r.textContent);
     row.click();
     return true`,
  )
  if (clicked !== true) {
    throw new Error(`add-popup row "${rowText}" not found; rows=${JSON.stringify(clicked)}`)
  }
  // Playlist picker modal: type the new-playlist name into the FIRST
  // new-row input (the second holds the range name).
  await c.waitForElement("#d-op-modal .d-op-modal-new-row input", { timeoutMs: 10_000 })
  const input = await c.findElement(
    `#d-op-modal .d-op-modal-new-row:not(.d-op-modal-name-row) input`,
  )
  await c.sendKeys(input, playlistName)
  // Wait for the primary '追加' button to become enabled (input event ran).
  await c.waitForScript(
    `const b = document.querySelector("#d-op-modal .d-op-modal-footer button.primary");
     return b !== null && !b.disabled`,
    { timeoutMs: 5_000, label: "add button enabled" },
  )
  await c.execute(`document.querySelector("#d-op-modal .d-op-modal-footer button.primary").click()`)
  // '追加完了' confirmation modal → OK.
  await c.waitForScript(
    `const m = document.getElementById("d-op-modal");
     return m !== null && m.textContent.includes("追加しました")`,
    { timeoutMs: 10_000, label: "add-complete modal" },
  )
  await c.execute(`document.querySelector("#d-op-modal .d-op-modal-footer button.primary").click()`)
  await c.waitForScript(`return document.getElementById("d-op-modal") === null`, {
    timeoutMs: 5_000,
    label: "modal closed",
  })
}

/**
 * Options page share dialog for the card whose name input value matches
 * `playlistName`: grant consent if the dialog asks, pick visibility, fill
 * author, publish, activate. Returns { shareId, shareUrl }.
 */
export async function publishPlaylist(
  c,
  { playlistName, visibility = "public", author = "native-test" },
) {
  const cardSel = await c.execute(
    `const cards = [...document.querySelectorAll(".playlist-card")];
     const card = cards.find(cd =>
       cd.querySelector(".playlist-name-input")?.value === ${JSON.stringify(playlistName)});
     if (card === undefined) return cards.map(cd => cd.querySelector(".playlist-name-input")?.value);
     card.querySelector(".share-open").click();
     return true`,
  )
  if (cardSel !== true) {
    throw new Error(`playlist card "${playlistName}" not found: ${JSON.stringify(cardSel)}`)
  }
  await c.waitForElement(".share-dialog", { timeoutMs: 10_000 })

  // Consent gate (task 22): if the dialog shows the consent panel, grant
  // through it once — the product path persists the decision.
  const hasConsent = await c.execute(
    `return document.querySelector(".share-dialog .share-consent-grant") !== null`,
  )
  if (hasConsent) {
    await c.execute(`document.querySelector(".share-dialog .share-consent-grant").click()`)
    await c.waitForScript(
      `return document.querySelector(".share-dialog .share-consent-grant") === null`,
      { timeoutMs: 15_000, label: "dialog consent granted" },
    )
  }

  await c.execute(
    `const r = document.querySelector(
       '.share-dialog input[name="dopShareVisibility"][value="${visibility}"]');
     if (r === null) throw new Error("visibility radio missing");
     r.click()`,
  )
  await c.execute(
    `const a = document.querySelector(".share-dialog .share-author");
     a.value = ${JSON.stringify(author)};
     a.dispatchEvent(new Event("input", { bubbles: true }))`,
  )
  await c.waitForScript(
    `const b = document.querySelector(".share-dialog .share-publish");
     return b !== null && !b.disabled`,
    { timeoutMs: 10_000, label: "publish enabled" },
  )
  const t0 = Date.now()
  await c.execute(`document.querySelector(".share-dialog .share-publish").click()`)
  // The background publish flow performs create → persist key → activate
  // internally (publish-flow.ts). On the happy path the reply is "published"
  // and the status block renders .share-url directly; .share-activate only
  // appears on an "activate-pending" reply (server ack lost / offline), in
  // which case we resume the same attempt by clicking it.
  await c.waitForScript(
    `const r = document.querySelector('.share-dialog [data-testid="share-result"]');
     return r !== null && r.textContent.trim() !== ""`,
    { timeoutMs: 60_000, label: "publish result" },
  )
  const publishText = await c.execute(
    `return document.querySelector('.share-dialog [data-testid="share-result"]').textContent`,
  )
  const publishMs = Date.now() - t0
  const needsActivate = await c.execute(
    `const b = document.querySelector(".share-dialog .share-activate");
     return b !== null && !b.disabled`,
  )
  if (needsActivate === true) {
    await c.execute(`document.querySelector(".share-dialog .share-activate").click()`)
  }
  try {
    await c.waitForScript(
      `const u = document.querySelector(".share-dialog .share-url");
       return u !== null && u.textContent.includes("/p/")`,
      { timeoutMs: 60_000, label: "share url" },
    )
  } catch {
    const dump = await c.execute(
      `return document.querySelector(".share-dialog")?.textContent?.slice(0, 600) ?? "no-dialog"`,
    )
    throw new Error(`publish produced no share url; result="${publishText}" dialog="${dump}"`)
  }
  const shareUrl = await c.execute(
    `return document.querySelector(".share-dialog .share-url").textContent.trim()`,
  )
  const shareId = String(shareUrl).split("/p/")[1]
  if (shareId === undefined || shareId === "") {
    throw new Error(`could not parse shareId from "${shareUrl}"`)
  }
  return { shareId, shareUrl: String(shareUrl), publishText: String(publishText), publishMs }
}

/** Attempt a publish that must fail bounded (503 leg). Returns the reply
 *  text + elapsed ms; throws if the dialog wedged past `timeoutMs`. */
export async function publishExpectFailure(c, { playlistName, timeoutMs = 90_000 }) {
  await c.execute(
    `const cards = [...document.querySelectorAll(".playlist-card")];
     const card = cards.find(cd =>
       cd.querySelector(".playlist-name-input")?.value === ${JSON.stringify(playlistName)});
     card.querySelector(".share-open").click()`,
  )
  await c.waitForElement(".share-dialog", { timeoutMs: 10_000 })
  const hasConsent = await c.execute(
    `return document.querySelector(".share-dialog .share-consent-grant") !== null`,
  )
  if (hasConsent) {
    await c.execute(`document.querySelector(".share-dialog .share-consent-grant").click()`)
    await c.waitForScript(
      `return document.querySelector(".share-dialog .share-consent-grant") === null`,
      { timeoutMs: 15_000 },
    )
  }
  await c.execute(
    `document.querySelector('.share-dialog input[name="dopShareVisibility"][value="public"]').click()`,
  )
  const t0 = Date.now()
  await c.execute(`document.querySelector(".share-dialog .share-publish").click()`)
  const text = await c.waitForScript(
    `const r = document.querySelector('.share-dialog [data-testid="share-result"]');
     return r !== null && r.textContent.trim() !== "" ? r.textContent.trim() : false`,
    { timeoutMs, label: "failure result" },
  )
  return { resultText: String(text), elapsedMs: Date.now() - t0 }
}

/** Close the open share dialog (modal footer 'close' is the only button). */
export async function closeShareDialog(c) {
  await c.execute(
    `const b = [...document.querySelectorAll("#d-op-modal .d-op-modal-footer button")]
       .find(x => x.textContent.includes("閉じる"));
     if (b) b.click()`,
  )
  await c.waitForScript(`return document.getElementById("d-op-modal") === null`, {
    timeoutMs: 5_000,
    label: "share dialog closed",
  })
}

/** Click '▶ 再生' on a playlist card; returns the NEW window handle. */
export async function playFromOptions(c, { playlistName }) {
  const known = new Set(await c.windowHandles())
  await c.execute(
    `const cards = [...document.querySelectorAll(".playlist-card")];
     const card = cards.find(cd =>
       cd.querySelector(".playlist-name-input")?.value === ${JSON.stringify(playlistName)});
     [...card.querySelectorAll("button")].find(b => b.textContent.includes("再生")).click()`,
  )
  const handle = await c.waitForNewWindow(known, { timeoutMs: 15_000 })
  await c.switchToWindow(handle)
  return handle
}

/** Rename a playlist on the options page (edit leg). */
export async function renamePlaylist(c, { from, to }) {
  await c.execute(
    `const cards = [...document.querySelectorAll(".playlist-card")];
     const card = cards.find(cd =>
       cd.querySelector(".playlist-name-input")?.value === ${JSON.stringify(from)});
     const input = card.querySelector(".playlist-name-input");
     input.value = ${JSON.stringify(to)};
     input.dispatchEvent(new Event("change", { bubbles: true }))`,
  )
  await c.waitForScript(
    `const cards = [...document.querySelectorAll(".playlist-card")];
     return cards.some(cd => cd.querySelector(".playlist-name-input")?.value === ${JSON.stringify(to)})`,
    { timeoutMs: 10_000, label: "rename applied" },
  )
}
