// Shared popup row helpers — item text projection used by both the picker
// cards and the now-playing list, plus the inline shuffle SVG icon.

import { episodeLeadLabel } from "../../../../packages/shared/src/index"
import type { LocalItem } from "../../../../packages/shared/src/local-model"
import { decodeHtmlEntities, formatRangeName, formatSec } from "./format"

const SHUFFLE_SVG_PATH =
  "M14.83 13.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13zM4 5.41l5.18 5.18 1.42-1.41L5.41 4 4 5.41zM20 4h-5.5l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4z"

export function shuffleIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", "0 0 24 24")
  svg.setAttribute("width", "16")
  svg.setAttribute("height", "16")
  svg.setAttribute("fill", "currentColor")
  svg.style.display = "block"
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path")
  path.setAttribute("d", SHUFFLE_SVG_PATH)
  svg.appendChild(path)
  return svg
}

export type ItemRowTexts = {
  readonly title: string
  readonly sub: string
  readonly range: string
  readonly time: string | null
}

export function itemRowTexts(item: LocalItem): ItemRowTexts {
  const epNum = item.episodeNumber !== undefined ? decodeHtmlEntities(item.episodeNumber) : ""
  const epTitle = decodeHtmlEntities(item.episodeTitle)
  const workTitle = decodeHtmlEntities(item.title)
  return {
    title: episodeLeadLabel({
      title: workTitle,
      episodeTitle: epTitle,
      episodeNumber: epNum,
    }),
    sub: workTitle,
    range: item.range !== null ? formatRangeName(item.range) : "範囲未設定",
    time:
      item.range !== null ? `${formatSec(item.range.start)}-${formatSec(item.range.end)}` : null,
  }
}
