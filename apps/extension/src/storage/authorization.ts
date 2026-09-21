export type StorageAccess = "public" | "vault"

export type StorageMessageSender = {
  readonly id?: string | undefined
  readonly url?: string | undefined
  readonly tab?: { readonly url?: string | undefined } | undefined
}

export type AuthorizationResult =
  | { readonly kind: "allowed"; readonly surface: "background" | "extension-ui" | "content" }
  | {
      readonly kind: "denied"
      readonly reason: "content-sender-cannot-access-vault" | "untrusted-sender"
    }

function senderUrl(sender: StorageMessageSender): string | undefined {
  return sender.url ?? sender.tab?.url
}

export function authorizeStorageRequest(
  sender: StorageMessageSender | undefined,
  access: StorageAccess,
  extensionId: string,
): AuthorizationResult {
  if (sender === undefined) return { kind: "allowed", surface: "background" }
  if (sender.id !== extensionId) return { kind: "denied", reason: "untrusted-sender" }
  const url = senderUrl(sender)
  if (url === undefined) return { kind: "denied", reason: "untrusted-sender" }
  const parsed = URL.parse(url)
  if (parsed === null) return { kind: "denied", reason: "untrusted-sender" }
  if (parsed.protocol === "chrome-extension:" || parsed.protocol === "moz-extension:") {
    return { kind: "allowed", surface: "extension-ui" }
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { kind: "denied", reason: "untrusted-sender" }
  }
  return access === "vault"
    ? { kind: "denied", reason: "content-sender-cannot-access-vault" }
    : { kind: "allowed", surface: "content" }
}
