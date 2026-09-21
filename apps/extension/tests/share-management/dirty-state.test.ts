// Dirty-state unit tests (task 15): dirty is ALWAYS recomputed by hashing the
// current local publish projection against the record's acknowledgedHash —
// the sent snapshot stays immutable between acknowledgements, and edits made
// while a request is in flight still compare dirty afterwards.
import { describe, expect, it } from "vitest"
import { publicationDirty, snapshotMetadata } from "../../src/share/dirty-state"
import { item, playlist } from "../domain/fixtures"
import { linkedRecord, publicationRecord } from "./fixtures"

describe("dirty-state/publicationDirty", () => {
  it("clean when the current projection matches the acknowledged hash", async () => {
    const local = playlist("p1", ["a", "b"])
    const record = await linkedRecord(local)
    expect(await publicationDirty(record, local)).toEqual({ kind: "clean" })
  })

  it("dirty after a local rename or item change — even mid-request", async () => {
    const local = playlist("p1", ["a", "b"])
    const record = await linkedRecord(local)
    // Simulate "request in flight": the record is unchanged while the local
    // playlist already moved on. The compare still reports dirty.
    const renamed = { ...local, name: "Renamed playlist" }
    expect(await publicationDirty(record, renamed)).toEqual({ kind: "dirty" })
    const added = { ...local, items: [...local.items, item("c")] }
    expect(await publicationDirty(record, added)).toEqual({ kind: "dirty" })
  })

  it("detached when the record has no local playlist", async () => {
    const local = playlist("p1", ["a"])
    const record = await linkedRecord(local, {
      localPlaylistId: null,
      state: "local-deleted",
    })
    expect(await publicationDirty(record, local)).toEqual({ kind: "detached" })
    expect(await publicationDirty(record, undefined)).toEqual({ kind: "detached" })
  })

  it("unpublishable when the local edit removed every range", async () => {
    const local = playlist("p1", ["a"])
    const record = await linkedRecord(local)
    const broken = { ...local, items: [item("a", null)] }
    const result = await publicationDirty(record, broken)
    expect(result.kind).toBe("unpublishable")
    if (result.kind === "unpublishable") {
      expect(result.reasons.some((reason) => reason.code === "null-range")).toBe(true)
    }
  })

  it("snapshot-invalid when the stored sentSnapshot no longer parses", async () => {
    const local = playlist("p1", ["a"])
    const record = await linkedRecord(local, { sentSnapshot: "{not json" })
    expect(await publicationDirty(record, local)).toEqual({ kind: "snapshot-invalid" })
    const wrongShape = await linkedRecord(local, { sentSnapshot: '{"a":1}' })
    expect(await publicationDirty(wrongShape, local)).toEqual({ kind: "snapshot-invalid" })
  })

  it("clean only against the ACKNOWLEDGED hash — a stale acknowledgedHash stays dirty", async () => {
    const local = playlist("p1", ["a"])
    const record = await linkedRecord(local, { acknowledgedHash: "0".repeat(64) })
    expect(await publicationDirty(record, local)).toEqual({ kind: "dirty" })
  })
})

describe("dirty-state/snapshotMetadata", () => {
  it("recovers publish metadata (incl. derivedFrom) from the sent snapshot", async () => {
    const local = playlist("p1", ["a"])
    const record = await linkedRecord(local)
    const meta = snapshotMetadata(record)
    expect(meta).toMatchObject({ visibility: "public", tags: [] })
  })

  it("returns undefined for a corrupt snapshot", () => {
    const record = publicationRecord({ sentSnapshot: "!!!" })
    expect(snapshotMetadata(record)).toBeUndefined()
  })
})
