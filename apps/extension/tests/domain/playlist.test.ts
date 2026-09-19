import { describe, expect, it } from "vitest"
import {
  addItem,
  clearPlaylistItems,
  copyItem,
  createPlaylist,
  deletePlaylist,
  removeItem,
  renamePlaylist,
  reorderItem,
  replaceItem,
} from "../../src/domain/playlist"
import { item, itemDraft, OP_RANGE, playlist } from "./fixtures"

describe("immutable playlist CRUD", () => {
  it("creates a playlist with an injected stable ID without mutating the library", () => {
    // Given: one existing playlist and deterministic identity allocation.
    const original = [playlist()]

    // When: a playlist is created.
    const created = createPlaylist(original, "New", () => "playlist-2")

    // Then: its ID is deterministic and the prior value remains unchanged.
    expect(original).toEqual([playlist()])
    expect(created.kind).toBe("updated")
    if (created.kind !== "updated") return
    expect(created.playlists.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "playlist-1", name: "Playlist playlist-1" },
      { id: "playlist-2", name: "New" },
    ])
  })

  it("renames a playlist while preserving its ID", () => {
    // Given: a playlist. When: renamed.
    const renamed = renamePlaylist([playlist()], "playlist-1", "Renamed")

    // Then: only its name changes.
    expect(renamed.kind).toBe("updated")
    if (renamed.kind === "updated") {
      expect(renamed.playlists[0]).toEqual({ ...playlist(), name: "Renamed" })
    }
  })

  it("adds a full-episode item with an allocated ID", () => {
    // Given: a source playlist and a full-episode draft.
    const original = [playlist("source", ["a"])]

    // When: the item is added.
    const added = addItem(original, {
      playlistId: "source",
      item: itemDraft("ignored", null),
      nextId: () => "b",
    })
    expect(added.kind).toBe("updated")
    if (added.kind !== "updated") return
    // Then: null range and the allocated ID survive without mutating the input.
    expect(added.playlists[0]?.items[1]).toEqual({ ...itemDraft("ignored", null), id: "b" })
    expect(original).toEqual([playlist("source", ["a"])])
  })

  it("edits an item while retaining its stable ID and precise named range", () => {
    // Given: an existing item. When: its content is replaced.
    const original = [playlist("source", ["b"])]
    const edited = replaceItem(original, {
      playlistId: "source",
      itemId: "b",
      item: itemDraft("replacement", { ...OP_RANGE, name: "Exact custom" }),
    })

    // Then: input is unchanged and the stable ID survives replacement.
    expect(original).toEqual([playlist("source", ["b"])])
    expect(edited.kind).toBe("updated")
    if (edited.kind === "updated") {
      expect(edited.playlists[0]?.items[0]).toEqual({
        ...itemDraft("replacement", { ...OP_RANGE, name: "Exact custom" }),
        id: "b",
      })
    }
  })

  it("copies an item with a new ID while preserving source data", () => {
    // Given: source and target playlists. When: an item is copied.
    const original = [playlist("source", ["a"]), playlist("target", [])]
    const copied = copyItem(original, {
      sourcePlaylistId: "source",
      itemId: "a",
      targetPlaylistId: "target",
      nextId: () => "copied-a",
    })

    // Then: source is untouched and target has an equivalent fresh identity.
    expect(copied.kind).toBe("updated")
    if (copied.kind === "updated") {
      expect(copied.playlists[0]).toEqual(original[0])
      expect(copied.playlists[1]?.items[0]).toEqual({ ...item("a"), id: "copied-a" })
    }
    expect(original).toEqual([playlist("source", ["a"]), playlist("target", [])])
  })

  it("reorders an item by ID without changing item identities", () => {
    // Given: three items. When: c moves to the first position.
    const original = [playlist("source", ["a", "b", "c"])]
    const reordered = reorderItem(original, {
      playlistId: "source",
      itemId: "c",
      position: 0,
    })

    // Then: order changes immutably and every ID remains present once.
    expect(reordered.kind).toBe("updated")
    if (reordered.kind === "updated") {
      expect(reordered.playlists[0]?.items.map(({ id }) => id)).toEqual(["c", "a", "b"])
    }
    expect(original[0]?.items.map(({ id }) => id)).toEqual(["a", "b", "c"])
  })

  it("removes an item without mutating the playlist", () => {
    // Given: two items. When: one item is removed.
    const original = [playlist("source", ["a", "b"])]
    const removed = removeItem(original, "source", "a")

    // Then: only the requested stable identity is gone.
    expect(removed.kind).toBe("updated")
    if (removed.kind === "updated") {
      expect(removed.playlists).toEqual([{ ...playlist("source", ["a", "b"]), items: [item("b")] }])
    }
    expect(original).toEqual([playlist("source", ["a", "b"])])
  })

  it("deletes only the requested playlist", () => {
    // Given: two playlists. When: the target is deleted.
    const original = [playlist("source", ["a"]), playlist("target", [])]
    const deleted = deletePlaylist(original, "target")

    // Then: the source playlist remains unchanged.
    expect(deleted.kind).toBe("updated")
    if (deleted.kind === "updated") {
      expect(deleted.playlists).toEqual([playlist("source", ["a"])])
    }
    expect(original).toEqual([playlist("source", ["a"]), playlist("target", [])])
  })

  it("clears every item from only the requested playlist without mutating input", () => {
    // Given: source and untouched playlists with stable identities.
    const original = [playlist("source", ["a", "b"]), playlist("untouched", ["c"])]

    // When: source items are cleared.
    const cleared = clearPlaylistItems(original, "source")

    // Then: source is empty, playlist IDs stay stable, and input/other playlist are unchanged.
    expect(cleared.kind).toBe("updated")
    if (cleared.kind !== "updated") return
    expect(cleared.playlists.map(({ id }) => id)).toEqual(["source", "untouched"])
    expect(cleared.playlists[0]?.items).toEqual([])
    expect(cleared.playlists[1]).toBe(original[1])
    expect(original).toEqual([playlist("source", ["a", "b"]), playlist("untouched", ["c"])])
  })

  it("returns a successful immutable no-op when the playlist is already empty", () => {
    // Given: an empty playlist. When: its items are cleared.
    const original = [playlist("empty", [])]
    const cleared = clearPlaylistItems(original, "empty")

    // Then: success preserves the already-canonical library and playlist references.
    expect(cleared.kind).toBe("updated")
    if (cleared.kind === "updated") {
      expect(cleared.playlists).toBe(original)
      expect(cleared.playlists[0]).toBe(original[0])
    }
  })

  it("returns playlist-not-found when clearing a missing playlist", () => {
    // Given: one playlist. When: another ID is cleared. Then: absence is explicit.
    const original = [playlist("present", ["a"])]
    expect(clearPlaylistItems(original, "missing")).toEqual({
      kind: "playlist-not-found",
      playlistId: "missing",
    })
    expect(original).toEqual([playlist("present", ["a"])])
  })

  it("rejects duplicate identities before clearing", () => {
    // Given: malformed duplicate item identities. When: clear is requested.
    const malformed = [{ ...playlist("source", ["a"]), items: [item("same"), item("same")] }]
    const cleared = clearPlaylistItems(malformed, "source")

    // Then: collision is explicit and no item is silently discarded.
    expect(cleared).toEqual({ kind: "duplicate-id", entity: "item", id: "same" })
    expect(malformed[0]?.items).toHaveLength(2)
  })

  it("rejects duplicate allocated or pre-existing IDs without aliasing", () => {
    // Given: valid and malformed libraries.
    const valid = [playlist("one", ["a"])]
    const duplicateItems = [{ ...playlist("one", ["a"]), items: [item("same"), item("same")] }]

    // When: allocation collides or a malformed library reaches the domain.
    const allocatedCollision = addItem(valid, {
      playlistId: "one",
      item: itemDraft("x"),
      nextId: () => "a",
    })
    const existingCollision = renamePlaylist(duplicateItems, "one", "No alias")
    const duplicatePlaylists = renamePlaylist(
      [playlist("same-playlist", []), playlist("same-playlist", [])],
      "same-playlist",
      "No alias",
    )

    // Then: both return an explicit duplicate outcome and preserve inputs.
    expect(allocatedCollision).toEqual({ kind: "duplicate-id", entity: "item", id: "a" })
    expect(existingCollision).toEqual({ kind: "duplicate-id", entity: "item", id: "same" })
    expect(duplicatePlaylists).toEqual({
      kind: "duplicate-id",
      entity: "playlist",
      id: "same-playlist",
    })
    expect(valid).toEqual([playlist("one", ["a"])])
  })

  it("preserves unique identities and inputs across many additions", () => {
    // Given: libraries of increasing size with unique IDs.
    for (let size = 0; size <= 30; size += 1) {
      const original = [
        playlist(
          "property",
          Array.from({ length: size }, (_, index) => `id-${index}`),
        ),
      ]

      // When: one fresh item is added. Then: all identities remain unique and input stays unchanged.
      const result = addItem(original, {
        playlistId: "property",
        item: itemDraft("fresh"),
        nextId: () => `id-${size}`,
      })
      expect(result.kind).toBe("updated")
      if (result.kind !== "updated") continue
      const ids = result.playlists[0]?.items.map(({ id }) => id) ?? []
      expect(ids).toHaveLength(size + 1)
      expect(new Set(ids).size).toBe(size + 1)
      expect(original[0]?.items).toHaveLength(size)
    }
  })

  it("returns typed not-found and invalid-position outcomes", () => {
    // Given: one playlist. When/Then: invalid targets are explicit.
    const library = [playlist("one", ["a"])]
    expect(removeItem(library, "missing", "a")).toEqual({
      kind: "playlist-not-found",
      playlistId: "missing",
    })
    expect(removeItem(library, "one", "missing")).toEqual({
      kind: "item-not-found",
      itemId: "missing",
    })
    expect(reorderItem(library, { playlistId: "one", itemId: "a", position: 1 })).toEqual({
      kind: "invalid-position",
      position: 1,
    })
  })
})
