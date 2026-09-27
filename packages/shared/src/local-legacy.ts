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

/** Coerces a legacy scalar field to a trimmed string. v1 wrote numbers for
 *  episode numbers and empty strings for unset fields; non-string scalars are
 *  stringified, objects are dropped. */
function coerceString(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return ""
}

/** Recovers partId from the stored player URL (`...sc_d_pc?partId=...`) when
 *  the item's own field is missing or empty — v1's importer saved
 *  `partId: i.partId || ''`, so the URL is the only remaining carrier. */
function derivePartId(partId: string, url: unknown): string {
  if (partId.length > 0) return partId
  const text = coerceString(url)
  if (text.length === 0) return ""
  try {
    return new URL(text).searchParams.get("partId")?.trim() ?? ""
  } catch {
    return ""
  }
}

/** Coerces a legacy range bound to a millisecond integer. v1 stored
 *  floor()'d integers; older dev builds and hand-edited exports may carry
 *  floats or numeric strings. Negative values clamp to 0. */
function coerceMs(value: unknown): number | undefined {
  const num =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(num)) return undefined
  return Math.max(0, Math.round(num))
}

/** Range names survive as-is (truncated to the schema budget); legacy
 *  `type` still maps to OP/ED/CUSTOM. */
function normalizeRangeName(rawName: unknown, rawType: unknown): string | undefined {
  const name = coerceString(rawName)
  if (name.length > 0) return name.slice(0, 80)
  const type = coerceString(rawType)
  if (type.length > 0) return mapLegacyRangeTypeToName(type).slice(0, 80)
  return undefined
}

function normalizeRange(range: unknown): unknown {
  if (range === null || range === undefined) return null
  const parsed = RangeInputSchema.safeParse(range)
  if (!parsed.success) return null
  const start = coerceMs(parsed.data.start)
  const end = coerceMs(parsed.data.end)
  const name = normalizeRangeName(parsed.data.name, parsed.data.type)
  // An unreadable or reversed range demotes to "no range" instead of
  // quarantining the whole clip — v1 kept such items visible as 範囲未設定.
  if (start === undefined || end === undefined || start >= end) return null
  return name === undefined ? { start, end } : { start, end, name }
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
    // v1 persisted absent fields as "" (item writer + JSON importer), which
    // the strict v2 schema rejects — coerce and drop instead of quarantining.
    const workId = coerceString(item.workId)
    const url = coerceString(item.url)
    return {
      repaired: id.repaired,
      raw: {
        id: id.id,
        partId: derivePartId(coerceString(item.partId), item.url),
        ...(workId.length > 0 ? { workId } : {}),
        title: coerceString(item.title),
        episodeTitle: coerceString(item.episodeTitle),
        episodeNumber: coerceString(item.episodeNumber),
        ...(url.length > 0 ? { url } : {}),
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
