// Task 22: the Share consent gate. Share traffic (publish/activate/update/
// delete/inspect, provenance/source checks, the web→ext import preview fetch
// and the anonymous import notification) may ONLY run while consent is
// effectively granted. "Effectively granted" means BOTH:
//
//   1. The persisted user decision is "granted" — the user picked 有効にする
//      on a privileged extension surface (options dialog or the import
//      confirmation window). Undecided (no record) and "declined" both block.
//   2. Where Firefox's built-in data-collection consent exists — detected by
//      the `data_collection` key on `browser.permissions.getAll()` — every
//      declared optional data category is still granted. Revoking a category
//      in about:addons therefore stops Share traffic even if the in-extension
//      record still says granted (the UI then re-prompts).
//
// Consent is revocable from the options page; revoking stops future Share
// traffic but never deletes remote publications or local data automatically.
// Declined users keep every local-only feature and emit zero Share requests.

import type { ShareConsent, ShareConsentChoice } from "../../../../packages/shared/src/local-model"
import type { LocalRepository } from "../storage/repository"
import { runMutation, type UiStorageClient } from "../ui/storage-client"

/**
 * Optional Firefox data-collection categories that Share transmits, declared
 * in `browser_specific_settings.gecko.data_collection_permissions.optional`:
 *  - websiteContent: published snapshots carry titles/episode titles/ids of
 *    d-Anime pages the user curated into a playlist.
 *  - personallyIdentifyingInfo: the free-text author/description fields can
 *    carry a name or other self-provided identifying text.
 *  - technicalAndInteraction: the anonymous aggregate import notification
 *    ({eventId} only) is extension-usage signalling to our own service.
 * The list is all-or-nothing: Share is one optional feature, so the gate
 * requires every declared category.
 */
export const SHARE_DATA_COLLECTION_PERMISSIONS = [
  "websiteContent",
  "personallyIdentifyingInfo",
  "technicalAndInteraction",
] as const

/** The fixed privacy page the consent copy links to (same origin as Share). */
export const SHARE_PRIVACY_URL = "https://d-op.sasnews.dev/privacy" as const

export type ShareConsentState = "granted" | "declined" | "undecided"

/** Minimal shape of `browser.permissions` needed here — keeps the module
 *  browser-free so handlers/dialogs stay unit-testable. */
export type DataPermissions = {
  readonly getAll?: () => Promise<{ readonly data_collection?: readonly string[] }>
  readonly request?: (permissions: {
    readonly data_collection: readonly string[]
  }) => Promise<boolean>
}

/** Effective local decision: absent record → undecided; stored choice else. */
export function consentChoice(consent: ShareConsent | undefined): ShareConsentState {
  return consent === undefined ? "undecided" : consent.choice
}

/**
 * Background-side effective gate. `dataPermissions.getAll` is the Firefox
 * ≥140 built-in consent surface; when it returns an object WITHOUT a
 * `data_collection` key the browser has no native consent layer and the
 * in-extension decision alone decides (Chrome, Firefox <140 — the custom
 * consent UI is the experience Mozilla requires there). When the key IS
 * present, every declared category must currently be granted — an
 * about:addons revocation downgrades "granted" to "undecided" so the next
 * Share surface re-prompts instead of silently transmitting.
 */
export async function effectiveShareConsent(
  repository: LocalRepository,
  dataPermissions?: DataPermissions,
): Promise<ShareConsentState> {
  const vault = await repository.readVault()
  const choice = consentChoice(vault.shareConsent)
  if (choice !== "granted" || dataPermissions?.getAll === undefined) return choice
  try {
    const all = await dataPermissions.getAll()
    const granted = all.data_collection
    if (granted === undefined) return "granted" // no native layer — local decision stands
    return SHARE_DATA_COLLECTION_PERMISSIONS.every((category) => granted.includes(category))
      ? "granted"
      : "undecided"
  } catch {
    // A failing permissions read must not silently allow traffic.
    return "undecided"
  }
}

/**
 * Upper bound on the native data-consent request. The doorhanger can stay
 * pending indefinitely when no user can answer it (headless automation,
 * dismissed notifications), so an unsettled request must degrade to
 * "native-denied" rather than wedge the consent UI forever.
 */
export const NATIVE_CONSENT_REQUEST_TIMEOUT_MS = 90_000

/**
 * Page-side companion for the explicit grant buttons (options dialog, import
 * confirmation). Runs the Firefox built-in data-consent prompt when the API
 * exists; resolves true when the native layer is absent or grants the
 * categories, false when the user denies the native prompt or the request
 * never settles within NATIVE_CONSENT_REQUEST_TIMEOUT_MS — the caller must
 * not persist "granted" then. Never throws.
 */
export async function requestShareDataPermissions(
  permissions: DataPermissions | undefined,
): Promise<boolean> {
  if (permissions?.getAll === undefined || permissions.request === undefined) return true
  try {
    const all = await permissions.getAll()
    if (all.data_collection === undefined) return true // unsupported → nothing native to grant
    return await Promise.race([
      permissions.request({
        data_collection: SHARE_DATA_COLLECTION_PERMISSIONS,
      }),
      new Promise<false>((resolve) =>
        setTimeout(() => resolve(false), NATIVE_CONSENT_REQUEST_TIMEOUT_MS),
      ),
    ])
  } catch {
    return false
  }
}

/**
 * UI-side persist path for privileged extension pages (options dialog, the
 * options consent section). The write goes through the repository's
 * revision-checked single writer via `set-share-consent` — pages never touch
 * storage directly. A GRANT first runs the Firefox ≥140 native data-consent
 * prompt when the API exists; if the user denies it there, nothing is
 * persisted and the caller re-renders as undecided. "native-denied" is
 * returned only in that case; "failed" covers storage/write failures.
 */
export async function writeShareConsent(
  storage: Pick<UiStorageClient, "readPublic" | "dispatch">,
  dataPermissions: DataPermissions | undefined,
  choice: ShareConsentChoice,
  newId: () => string,
  now: () => string = () => new Date().toISOString(),
): Promise<"written" | "native-denied" | "failed"> {
  if (choice === "granted" && !(await requestShareDataPermissions(dataPermissions))) {
    return "native-denied"
  }
  const reply = await runMutation(
    storage,
    () => ({ kind: "set-share-consent", choice, decidedAt: now() }),
    newId,
  )
  return reply.kind === "committed" ? "written" : "failed"
}
