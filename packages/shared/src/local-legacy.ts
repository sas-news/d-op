import { z } from "zod"
import { LEGACY_MIGRATION_VERSION } from "./limits"

export const RangeInputSchema = z.object({
  start: z.unknown(),
  end: z.unknown(),
  name: z.unknown().optional(),
  type: z.unknown().optional(),
})
export const ItemInputSchema = z.object({
  id: z.unknown().optional(),
  partId: z.unknown().optional(),
  workId: z.unknown().optional(),
  title: z.unknown().optional(),
  episodeTitle: z.unknown().optional(),
  episodeNumber: z.unknown().optional(),
  url: z.unknown().optional(),
  range: z.unknown().optional(),
  opRange: z.unknown().optional(),
  edRange: z.unknown().optional(),
  customRange: z.unknown().optional(),
})
export const PlaylistInputSchema = z.object({
  id: z.unknown().optional(),
  name: z.unknown().optional(),
  items: z.unknown(),
})
export type LegacyItemInput = z.infer<typeof ItemInputSchema>

export function mapLegacyRangeTypeToName(rangeType: string): string {
  switch (rangeType) {
    case "op":
      return "OP"
    case "ed":
      return "ED"
    case "custom":
      return "CUSTOM"
    default:
      return rangeType.toUpperCase()
  }
}
export function repairMissingId(input: {
  readonly migrationVersion: number
  readonly playlistOrdinal: number
  readonly itemOrdinal: number
  readonly rangeOrdinal: number
}): string {
  return `dop-v${input.migrationVersion}-p${input.playlistOrdinal}-i${input.itemOrdinal}-r${input.rangeOrdinal}`
}
function normalizeRange(range: unknown): unknown {
  if (range === null || range === undefined) return null
  const parsed = RangeInputSchema.safeParse(range)
  if (!parsed.success) return range
  if (typeof parsed.data.name === "string" && parsed.data.name.length > 0)
    return { start: parsed.data.start, end: parsed.data.end, name: parsed.data.name }
  if (typeof parsed.data.type === "string" && parsed.data.type.length > 0)
    return {
      start: parsed.data.start,
      end: parsed.data.end,
      name: mapLegacyRangeTypeToName(parsed.data.type),
    }
  return { start: parsed.data.start, end: parsed.data.end }
}
function sourceId(
  item: LegacyItemInput,
  p: number,
  i: number,
  r: number,
): { readonly id: string; readonly repaired: boolean } {
  if (typeof item.id === "string" && item.id.length > 0) return { id: item.id, repaired: false }
  return {
    id: repairMissingId({
      migrationVersion: LEGACY_MIGRATION_VERSION,
      playlistOrdinal: p,
      itemOrdinal: i,
      rangeOrdinal: r,
    }),
    repaired: true,
  }
}
export function allocateId(
  preferred: string | undefined,
  fallback: string,
  used: ReadonlySet<string>,
): { readonly id: string; readonly repaired: boolean } {
  const base =
    preferred && /^[A-Za-z0-9_-]+$/.test(preferred) && preferred.length <= 256
      ? preferred
      : fallback
  if (!used.has(base)) return { id: base, repaired: preferred !== base }
  for (let suffix = 1; suffix <= 999999; suffix += 1) {
    const suffixText = String(suffix)
    const candidate = `${base.slice(0, 256 - suffixText.length - 2)}-c${suffixText}`
    if (!used.has(candidate)) return { id: candidate, repaired: true }
  }
  const fallbackCandidate = `${fallback.slice(0, 240)}-c${used.size}`
  if (!used.has(fallbackCandidate)) return { id: fallbackCandidate, repaired: true }
  throw new Error(`unable to allocate deterministic local id for ${preferred ?? fallback}`)
}
export function fanOutLegacyItem(
  item: LegacyItemInput,
  p: number,
  i: number,
): readonly { readonly raw: Record<string, unknown>; readonly repaired: boolean }[] {
  const base = (range: unknown, r: number) => {
    const id = sourceId(item, p, i, r)
    return {
      repaired: id.repaired,
      raw: {
        id: id.id,
        partId: typeof item.partId === "string" ? item.partId : "",
        workId: item.workId,
        title: typeof item.title === "string" ? item.title : "",
        episodeTitle: typeof item.episodeTitle === "string" ? item.episodeTitle : "",
        episodeNumber: typeof item.episodeNumber === "string" ? item.episodeNumber : "",
        url: item.url,
        range,
      },
    }
  }
  if (item.range !== undefined) return [base(normalizeRange(item.range), 0)]
  const slots = [
    [item.opRange, "op"],
    [item.edRange, "ed"],
    [item.customRange, "custom"],
  ] as const
  const ranged = slots.flatMap(([slot, type], r) => {
    const parsed = RangeInputSchema.safeParse(slot)
    return parsed.success
      ? [
          base(
            {
              start: parsed.data.start,
              end: parsed.data.end,
              name: mapLegacyRangeTypeToName(type),
            },
            r,
          ),
        ]
      : []
  })
  return ranged.length > 0 ? ranged : [base(null, 0)]
}
