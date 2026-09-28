import { initWasm, Resvg } from "@resvg/resvg-wasm"
import * as opentype from "opentype.js"
import { collapseWhitespace } from "../../../../../packages/shared/src/index"
import { formatClockMs, type SharePageView } from "./share-page"

// Per-playlist OGP card (1200x630 PNG) for /p/:shareId — replaces the static
// og-share.svg that crawlers could not rasterise. The card is the site's own
// dark design language rendered server-side: d-OP icon + brand eyebrow, the
// playlist title/author, aggregate stats, and a numbered track list.
// The card is authored as a fixed-layout SVG (positions computed here, text
// widths measured with opentype.js for real advance + kerning) and rasterised
// by resvg-wasm, which shapes text itself — so no JS-side text engine and no
// second wasm dependency. Output is a bitmap every major crawler accepts.
//
// workerd forbids in-sandbox wasm codegen, so the resvg binary arrives as a
// pre-compiled WebAssembly.Module import (wrangler's default CompiledWasm
// rule for **/*.wasm); the fonts and d-OP icon are bytes served via ASSETS.

export const OG_WIDTH = 1200 as const
export const OG_HEIGHT = 630 as const

const OG_ASSET_PATHS = {
  icon: "/assets/d-OP-small.png",
  fontRegular: "/assets/og/NotoSansJP-Regular.ttf",
  fontBold: "/assets/og/NotoSansJP-Bold.ttf",
  fontBlack: "/assets/og/NotoSansJP-Black.ttf",
  monoMedium: "/assets/og/IBMPlexMono-Medium.ttf",
  monoBold: "/assets/og/IBMPlexMono-Bold.ttf",
} as const

export type OgAssetFetcher = (path: string) => Promise<ArrayBuffer>

/** Runtime surfaces the renderer needs — supplied by the route's env. */
export type OgRuntime = {
  readonly resvgModule: WebAssembly.Module
  readonly fetchAsset: OgAssetFetcher
}

type MeasureFont = opentype.Font

export type OgResources = {
  readonly fontBuffers: readonly Uint8Array[]
  readonly iconDataUri: string
  readonly measure: {
    readonly regular: MeasureFont
    readonly bold: MeasureFont
    readonly black: MeasureFont
    readonly monoMedium: MeasureFont
    readonly monoBold: MeasureFont
  }
}

// Palette mirrors styles/tokens.css — paper/raised/ink/accent, no new colors.
const C = {
  paper: "#0a0a0c",
  surface: "#141418",
  raised: "#1c1c22",
  ink: "#f7f8fa",
  muted: "rgba(247,248,250,0.68)",
  subtle: "rgba(247,248,250,0.44)",
  line: "rgba(255,255,255,0.10)",
  accent: "#e60012",
  accentBright: "#ff1a2d",
  accentDeep: "#7a000c",
} as const

const SANS = "Noto Sans JP"
const MONO = "IBM Plex Mono"

const PAD = 56 as const
const RIGHT = OG_WIDTH - PAD
const CONTENT_W = OG_WIDTH - PAD * 2
const MAX_TRACK_ROWS = 6 as const
const ROW_H = 40 as const
const ROWS_TOP = 336 as const
const DURATION_W = 64 as const

/**
 * BMP-less emoji and symbol planes that Noto Sans JP does not cover — without
 * stripping, rasterisation emits tofu boxes in shared titles. BMP symbols
 * (♪★ etc.) and variation selectors stay.
 */
const UNSUPPORTED_RE =
  /[\u{1F000}-\u{1FAFF}\u{1FB00}-\u{1FBFF}\u{20000}-\u{2FA1F}]|\u{FE0F}|\u{200D}/gu

function sanitize(text: string): string {
  return collapseWhitespace(text).replace(UNSUPPORTED_RE, "").trim()
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes)
  let binary = ""
  for (let offset = 0; offset < view.length; offset += 0x8000) {
    binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

/** Pixel width including SVG letter-spacing (applied after every glyph). */
function measure(font: MeasureFont, text: string, size: number, letterSpacing = 0): number {
  if (text === "") {
    return 0
  }
  return font.getAdvanceWidth(text, size) + letterSpacing * text.length
}

/**
 * True ellipsis truncation on measured advances — appends "…" and drops
 * glyphs until the result fits maxWidth.
 */
function ellipsize(
  font: MeasureFont,
  text: string,
  size: number,
  maxWidth: number,
  letterSpacing = 0,
): string {
  const clean = sanitize(text)
  if (measure(font, clean, size, letterSpacing) <= maxWidth) {
    return clean
  }
  const ellipsisW = measure(font, "…", size, letterSpacing)
  let end = clean.length
  while (end > 1) {
    const w = measure(font, clean.slice(0, end), size, letterSpacing)
    if (w + ellipsisW <= maxWidth) {
      return `${clean.slice(0, end)}…`
    }
    end -= 1
  }
  return "…"
}

/** Greedy word/character wrap into at most two lines; line 2 ellipsizes. */
function wrapTitle(
  font: MeasureFont,
  text: string,
  size: number,
  maxWidth: number,
): [string, string] {
  // A title made only of unsupported glyphs (e.g. an emoji-only title) would
  // vanish entirely while the page still shows it — fall back to a label.
  const clean = sanitize(text) || "プレイリスト"
  if (measure(font, clean, size) <= maxWidth) {
    return [clean, ""]
  }
  // Break at grapheme boundaries so surrogate pairs are never split.
  const chars = [...clean]
  let lineEnd = 0
  while (lineEnd < chars.length) {
    if (measure(font, chars.slice(0, lineEnd + 1).join(""), size) > maxWidth) {
      break
    }
    lineEnd += 1
  }
  const first = chars.slice(0, Math.max(1, lineEnd)).join("")
  const rest = ellipsize(font, chars.slice(lineEnd).join(""), size, maxWidth)
  return [first, rest]
}

function textElement(options: {
  x: number
  y: number
  text: string
  size: number
  weight: 400 | 500 | 700 | 900
  fill: string
  family?: string
  anchor?: "start" | "middle" | "end"
  letterSpacing?: number
}): string {
  const family = options.family ?? SANS
  const anchor = options.anchor ?? "start"
  const ls = options.letterSpacing ?? 0
  const lsAttr = ls === 0 ? "" : ` letter-spacing="${ls}"`
  return `<text x="${options.x}" y="${options.y}" font-family="${family}" font-size="${options.size}" font-weight="${options.weight}" fill="${options.fill}" text-anchor="${anchor}"${lsAttr}>${escapeXml(options.text)}</text>`
}

let resourcesPromise: Promise<OgResources> | null = null

/**
 * One-time wasm/font/icon load per isolate. A rejection clears the cached
 * promise so the next request retries instead of poisoning the isolate.
 */
export function ogResources(runtime: OgRuntime): Promise<OgResources> {
  resourcesPromise ??= loadOgResources(runtime).catch((error: unknown) => {
    resourcesPromise = null
    throw error
  })
  return resourcesPromise
}

async function loadOgResources(runtime: OgRuntime): Promise<OgResources> {
  const { fetchAsset } = runtime
  const [icon, regular, bold, black, monoMedium, monoBold] = await Promise.all([
    fetchAsset(OG_ASSET_PATHS.icon),
    fetchAsset(OG_ASSET_PATHS.fontRegular),
    fetchAsset(OG_ASSET_PATHS.fontBold),
    fetchAsset(OG_ASSET_PATHS.fontBlack),
    fetchAsset(OG_ASSET_PATHS.monoMedium),
    fetchAsset(OG_ASSET_PATHS.monoBold),
    initWasm(runtime.resvgModule),
  ])
  const fontBuffers = [
    new Uint8Array(regular),
    new Uint8Array(bold),
    new Uint8Array(black),
    new Uint8Array(monoMedium),
    new Uint8Array(monoBold),
  ]
  return {
    fontBuffers,
    iconDataUri: `data:image/png;base64,${base64(icon)}`,
    measure: {
      regular: opentype.parse(regular),
      bold: opentype.parse(bold),
      black: opentype.parse(black),
      monoMedium: opentype.parse(monoMedium),
      monoBold: opentype.parse(monoBold),
    },
  }
}

function trackRow(
  item: SharePageView["items"][number],
  top: number,
  resources: OgResources,
): string {
  const { bold, regular, monoBold } = resources.measure
  const baseline = top + 27
  const parts: string[] = [
    `<rect x="${PAD}" y="${top}" width="${CONTENT_W}" height="1" fill="${C.line}"/>`,
    textElement({
      x: PAD,
      y: baseline,
      text: String(item.index).padStart(2, "0"),
      size: 13,
      weight: 700,
      family: MONO,
      fill: C.accentBright,
      letterSpacing: 1,
    }),
  ]

  const duration = formatClockMs(Math.max(0, item.durationMs))
  parts.push(
    textElement({
      x: RIGHT,
      y: baseline,
      text: duration,
      size: 12,
      weight: 500,
      family: MONO,
      fill: C.subtle,
      anchor: "end",
    }),
  )

  // Badge sits immediately left of the duration column.
  let badgeX = RIGHT - DURATION_W - 14
  if (item.rangeName !== null) {
    const label = ellipsize(monoBold, sanitize(item.rangeName).toUpperCase(), 11, 120, 1)
    const badgeW = measure(monoBold, label, 11, 1) + 16
    const rectX = badgeX - badgeW
    parts.push(
      `<rect x="${rectX}" y="${top + 9}" width="${badgeW}" height="22" rx="4" fill="${
        label === "OP" ? C.accent : C.raised
      }" stroke="${label === "OP" ? C.accent : C.line}"/>`,
      textElement({
        x: rectX + badgeW / 2,
        y: top + 25,
        text: label,
        size: 11,
        weight: 700,
        family: MONO,
        fill: label === "OP" ? "#ffffff" : C.muted,
        anchor: "middle",
        letterSpacing: 1,
      }),
    )
    badgeX = rectX
  }

  const titleX = PAD + 48
  const titleMaxW = badgeX - 14 - titleX
  const title = ellipsize(bold, item.title, 17, titleMaxW)
  parts.push(
    textElement({
      x: titleX,
      y: baseline,
      text: title,
      size: 17,
      weight: 700,
      fill: C.ink,
    }),
  )

  const episode =
    item.episodeNumber !== null
      ? item.episodeTitle === ""
        ? `第${item.episodeNumber}話`
        : item.episodeTitle
      : item.episodeTitle
  if (episode !== "") {
    const titleW = measure(bold, title, 17)
    const episodeX = titleX + titleW + 8
    const episodeMaxW = badgeX - 14 - episodeX
    if (episodeMaxW > 40) {
      parts.push(
        textElement({
          x: episodeX,
          y: baseline,
          text: ellipsize(regular, episode, 12, episodeMaxW),
          size: 12,
          weight: 400,
          fill: C.subtle,
        }),
      )
    }
  }
  return parts.join("")
}

/** Card markup — a pure function of the share-page view model. */
export function shareOgSvg(view: SharePageView, resources: OgResources): string {
  // The overflow note occupies the last row slot, so truncate first and then
  // count what is left out — counting against MAX_TRACK_ROWS understates the
  // hidden clips by one whenever the note itself renders.
  const rows = view.items.slice(
    0,
    view.clipCount > MAX_TRACK_ROWS ? MAX_TRACK_ROWS - 1 : MAX_TRACK_ROWS,
  )
  const overflow = view.clipCount - rows.length
  const { bold, black, regular, monoBold, monoMedium } = resources.measure

  const parts: string[] = [
    `<rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="${C.paper}"/>`,
    `<rect width="${OG_WIDTH}" height="5" fill="url(#topbar)"/>`,
    `<rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#glow)"/>`,
  ]

  // Header: small d-mark + lowercase-leaning wordmark, domain on the right.
  const brand = "d-OP"
  const brandW = measure(monoBold, brand, 22, 1)
  parts.push(
    `<image href="${resources.iconDataUri}" x="${PAD}" y="42" width="48" height="48" clip-path="url(#iconClip)"/>`,
    textElement({
      x: PAD + 48 + 16,
      y: 76,
      text: brand,
      size: 22,
      weight: 700,
      family: MONO,
      fill: C.accentBright,
      letterSpacing: 1,
    }),
    textElement({
      x: PAD + 48 + 16 + brandW + 10,
      y: 76,
      text: "shared playlist",
      size: 14,
      weight: 500,
      family: MONO,
      fill: C.subtle,
      letterSpacing: 2,
    }),
    textElement({
      x: RIGHT,
      y: 74,
      text: "d-op.sasnews.dev",
      size: 13,
      weight: 500,
      family: MONO,
      fill: C.subtle,
      letterSpacing: 1,
      anchor: "end",
    }),
  )

  // Eyebrow + visibility pill.
  const eyebrow = "PLAYLIST"
  const eyebrowW = measure(monoBold, eyebrow, 12, 4)
  const visibility = view.visibility === "public" ? "公開" : "限定公開"
  const pillW = measure(bold, visibility, 12) + 18
  parts.push(
    textElement({
      x: PAD,
      y: 140,
      text: eyebrow,
      size: 12,
      weight: 700,
      family: MONO,
      fill: C.subtle,
      letterSpacing: 4,
    }),
    `<rect x="${PAD + eyebrowW + 10}" y="122" width="${pillW}" height="24" rx="12" fill="${C.surface}" stroke="${C.line}"/>`,
    textElement({
      x: PAD + eyebrowW + 10 + pillW / 2,
      y: 138,
      text: visibility,
      size: 12,
      weight: 700,
      fill: C.muted,
      anchor: "middle",
    }),
  )

  // Title — up to two measured lines at 36px black.
  const [line1, line2] = wrapTitle(black, view.title, 36, CONTENT_W)
  parts.push(textElement({ x: PAD, y: 198, text: line1, size: 36, weight: 900, fill: C.ink }))
  if (line2 !== "") {
    parts.push(textElement({ x: PAD, y: 244, text: line2, size: 36, weight: 900, fill: C.ink }))
  }

  // Meta line: author · published … tags.
  const metaParts: string[] = []
  let metaX = PAD
  if (view.author !== "") {
    const authorText = `by ${ellipsize(regular, view.author, 14, 260)}`
    metaParts.push(
      textElement({ x: metaX, y: 286, text: authorText, size: 14, weight: 400, fill: C.subtle }),
    )
    metaX += measure(regular, authorText, 14)
    metaParts.push(
      textElement({ x: metaX, y: 286, text: "  ·  ", size: 14, weight: 400, fill: C.subtle }),
    )
    metaX += measure(regular, "  ·  ", 14)
  }
  metaParts.push(
    textElement({
      x: metaX,
      y: 286,
      text: `${view.publishedAtLabel} 公開`,
      size: 14,
      weight: 400,
      fill: C.subtle,
    }),
  )
  if (view.tags.length > 0) {
    const tags = view.tags
      .slice(0, 3)
      .map((tag) => `#${ellipsize(monoMedium, tag, 12, 160)}`)
      .join("  ")
    metaParts.push(
      textElement({
        x: RIGHT,
        y: 285,
        text: tags,
        size: 12,
        weight: 500,
        family: MONO,
        fill: C.subtle,
        anchor: "end",
      }),
    )
  }
  parts.push(...metaParts)

  // Tracklist header + stats.
  const stats = `${view.clipCount} クリップ · 合計 ${view.totalDurationLabel} · ${view.importCount} 回保存`
  parts.push(
    textElement({
      x: PAD,
      y: 320,
      text: "TRACKLIST",
      size: 12,
      weight: 700,
      family: MONO,
      fill: C.accentBright,
      letterSpacing: 4,
    }),
    textElement({
      x: RIGHT,
      y: 320,
      text: stats,
      size: 13,
      weight: 400,
      fill: C.subtle,
      anchor: "end",
    }),
  )

  // Rows.
  let top = ROWS_TOP
  for (const item of rows) {
    parts.push(trackRow(item, top, resources))
    top += ROW_H
  }
  if (overflow > 0) {
    parts.push(
      `<rect x="${PAD}" y="${top}" width="${CONTENT_W}" height="1" fill="${C.line}"/>`,
      textElement({
        x: PAD,
        y: top + 27,
        text: "…",
        size: 13,
        weight: 700,
        family: MONO,
        fill: C.accentBright,
        letterSpacing: 1,
      }),
      textElement({
        x: PAD + 48,
        y: top + 27,
        text: `+${overflow} クリップ`,
        size: 13,
        weight: 500,
        family: MONO,
        fill: C.subtle,
        letterSpacing: 1,
      }),
    )
    top += ROW_H
  }
  // Bottom border of the list.
  parts.push(`<rect x="${PAD}" y="${top}" width="${CONTENT_W}" height="1" fill="${C.line}"/>`)

  // Footer.
  parts.push(
    textElement({
      x: PAD,
      y: 612,
      text: "dアニメストアのOP/EDクリップをまとめて再生・共有",
      size: 13,
      weight: 400,
      fill: C.subtle,
    }),
    textElement({
      x: RIGHT,
      y: 612,
      text: "OPだけ見てやろうってんだ",
      size: 13,
      weight: 700,
      fill: C.accentBright,
      anchor: "end",
    }),
  )

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">
  <defs>
    <linearGradient id="topbar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${C.accentBright}"/>
      <stop offset="0.55" stop-color="${C.accent}"/>
      <stop offset="1" stop-color="${C.accentDeep}"/>
    </linearGradient>
    <radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="${OG_WIDTH * 0.88}" cy="0" r="560">
      <stop offset="0" stop-color="${C.accent}" stop-opacity="0.38"/>
      <stop offset="1" stop-color="${C.accent}" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="iconClip"><rect x="${PAD}" y="42" width="48" height="48" rx="12"/></clipPath>
  </defs>
  ${parts.join("\n  ")}
</svg>`
}

/** Renders the card for a ready share page to PNG bytes. */
export async function renderShareOgPng(
  view: SharePageView,
  runtime: OgRuntime,
): Promise<Uint8Array> {
  const resources = await ogResources(runtime)
  const svg = shareOgSvg(view, resources)
  const resvg = new Resvg(svg, {
    background: C.paper,
    fitTo: { mode: "original" },
    font: {
      fontBuffers: [...resources.fontBuffers],
      defaultFontFamily: SANS,
      sansSerifFamily: SANS,
      monospaceFamily: MONO,
    },
  })
  return resvg.render().asPng()
}
