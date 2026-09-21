import { describe, expect, it } from "vitest"
import { dedupeNames, findNameConflicts, mergePlaylists } from "../../src/ui/import-merge"
import { item, playlist } from "../domain/fixtures"

describe("ui/import-merge (options.js:596-650 parity)", () => {
  it("findNameConflicts returns imported playlists whose name exists", () => {
    const existing = [playlist("p1"), playlist("p2")]
    const imported = [
      { ...playlist("x"), name: "Playlist p1" },
      { ...playlist("y"), name: "Brand new" },
    ]
    const conflicts = findNameConflicts(existing, imported)
    expect(conflicts.map((c) => c.name)).toEqual(["Playlist p1"])
  })

  it("mergePlaylists appends non-conflicting imports untouched", () => {
    const existing = [playlist("p1")]
    const imported = [{ ...playlist("x"), name: "Brand new" }]
    const { playlists, skipped } = mergePlaylists(existing, imported, [])
    expect(playlists).toHaveLength(2)
    expect(skipped).toBe(0)
  })

  it("mergePlaylists folds same-name items and skips id/content duplicates", () => {
    const existing = [{ ...playlist("p1", ["a", "b"]), name: "Shared" }]
    const imported = [
      {
        ...playlist("x", ["a", "z", "q"]),
        name: "Shared",
        items: [
          // id duplicate (same item id)
          item("a"),
          // content duplicate: different id but same partId+range
          { ...item("other"), partId: "part-b" },
          item("fresh"),
        ],
      },
    ]
    const { playlists, skipped } = mergePlaylists(existing, imported, ["Shared"])
    expect(playlists).toHaveLength(1)
    const merged = playlists[0]
    expect(merged?.items.map((i) => i.id)).toEqual(["a", "b", "fresh"])
    expect(skipped).toBe(2)
  })

  it("mergePlaylists keeps a same-name import separate when not in mergeNames", () => {
    const existing = [{ ...playlist("p1"), name: "Shared" }]
    const imported = [{ ...playlist("x"), name: "Shared" }]
    const { playlists } = mergePlaylists(existing, imported, [])
    expect(playlists).toHaveLength(2)
    expect(playlists[1]?.id).toBe("x")
  })

  it("dedupeNames renames colliding imports to 'name (n)' with fresh ids", () => {
    let counter = 0
    const existing = [
      { ...playlist("p1"), name: "Dup" },
      { ...playlist("p2"), name: "Dup (2)" },
    ]
    const imported = [{ ...playlist("x"), name: "Dup" }, playlist("y")]
    const deduped = dedupeNames(imported, existing, () => {
      counter += 1
      return `new-${counter}`
    })
    expect(deduped[0]?.name).toBe("Dup (3)")
    expect(deduped[0]?.id).toBe("new-1")
    expect(deduped[1]?.name).toBe("Playlist y")
    expect(deduped[1]?.id).toBe("y")
  })
})
