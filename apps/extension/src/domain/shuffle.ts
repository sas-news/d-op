import { assertNever } from "../../../../packages/shared/src/limits"
import { findDuplicateId } from "./identity"

export type ShuffleResult =
  | { readonly kind: "ready"; readonly order: readonly string[] }
  | { readonly kind: "duplicate-id"; readonly id: string }
  | { readonly kind: "item-not-found"; readonly itemId: string }
  | { readonly kind: "empty-playlist" }
  | { readonly kind: "invalid-random"; readonly value: number }

export type ReconcileShuffleResult =
  | { readonly kind: "ready"; readonly order: readonly string[] }
  | { readonly kind: "stop"; readonly reason: "empty-playlist" | "current-item-removed" }
  | { readonly kind: "duplicate-id"; readonly id: string }

type ReshuffleRequest = {
  readonly itemIds: readonly string[]
  readonly order: readonly string[]
  readonly currentItemId: string
  readonly random: () => number
}

function shuffled(ids: readonly string[], random: () => number): ShuffleResult {
  const order = [...ids]
  for (let index = order.length - 1; index > 0; index -= 1) {
    const value = random()
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      return { kind: "invalid-random", value }
    }
    const swapIndex = Math.floor(value * (index + 1))
    const current = order[index]
    const swap = order[swapIndex]
    if (current === undefined || swap === undefined) continue
    order[index] = swap
    order[swapIndex] = current
  }
  return { kind: "ready", order }
}

export function shuffleAll(itemIds: readonly string[], random: () => number): ShuffleResult {
  const duplicate = findDuplicateId(itemIds)
  if (duplicate !== null) return { kind: "duplicate-id", id: duplicate }
  if (itemIds.length === 0) return { kind: "empty-playlist" }
  return shuffled(itemIds, random)
}

export function shuffleFromClicked(
  itemIds: readonly string[],
  clickedItemId: string,
  random: () => number,
): ShuffleResult {
  const duplicate = findDuplicateId(itemIds)
  if (duplicate !== null) return { kind: "duplicate-id", id: duplicate }
  if (!itemIds.includes(clickedItemId)) return { kind: "item-not-found", itemId: clickedItemId }
  const suffix = shuffled(
    itemIds.filter((id) => id !== clickedItemId),
    random,
  )
  if (suffix.kind !== "ready") return suffix
  return { kind: "ready", order: [clickedItemId, ...suffix.order] }
}

export function shuffleFromCurrent(
  itemIds: readonly string[],
  currentItemId: string,
  random: () => number,
): ShuffleResult {
  return shuffleFromClicked(itemIds, currentItemId, random)
}

export function reconcileShuffleOrder(
  itemIds: readonly string[],
  staleOrder: readonly string[],
  currentItemId: string,
): ReconcileShuffleResult {
  const duplicate = findDuplicateId(itemIds)
  if (duplicate !== null) return { kind: "duplicate-id", id: duplicate }
  if (itemIds.length === 0) return { kind: "stop", reason: "empty-playlist" }
  if (!itemIds.includes(currentItemId)) return { kind: "stop", reason: "current-item-removed" }

  const available = new Set(itemIds)
  const included = new Set<string>()
  const order: string[] = []
  for (const id of staleOrder) {
    if (available.has(id) && !included.has(id)) {
      included.add(id)
      order.push(id)
    }
  }
  for (const id of itemIds) {
    if (!included.has(id)) order.push(id)
  }
  return { kind: "ready", order }
}

export function reshuffleAfterCurrent(request: ReshuffleRequest): ShuffleResult {
  const reconciled = reconcileShuffleOrder(request.itemIds, request.order, request.currentItemId)
  switch (reconciled.kind) {
    case "duplicate-id":
      return reconciled
    case "stop":
      return reconciled.reason === "empty-playlist"
        ? { kind: "empty-playlist" }
        : { kind: "item-not-found", itemId: request.currentItemId }
    case "ready": {
      const position = reconciled.order.indexOf(request.currentItemId)
      const prefix = reconciled.order.slice(0, position + 1)
      const suffix = shuffled(reconciled.order.slice(position + 1), request.random)
      if (suffix.kind !== "ready") return suffix
      return { kind: "ready", order: [...prefix, ...suffix.order] }
    }
    default:
      return assertNever(reconciled)
  }
}
