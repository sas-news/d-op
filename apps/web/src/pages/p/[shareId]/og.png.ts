import { env } from "cloudflare:workers"
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm"
import type { APIRoute } from "astro"
import { DOpConfigurationError } from "../../../server/env"
import { newRequestId } from "../../../server/services/respond"
import { type OgRuntime, renderShareOgPng } from "../../../server/services/share-og"
import { loadSharePage } from "../../../server/services/share-page"

/** Reads renderer binaries through the ASSETS binding — fails closed when unbound. */
async function fetchOgAsset(path: string): Promise<ArrayBuffer> {
  const assets: Fetcher | undefined = env.ASSETS
  if (assets === undefined) {
    throw new DOpConfigurationError(
      "DOP_MISSING_ASSETS",
      "ASSETS",
      'Static assets binding "ASSETS" is not configured for this Worker; the OGP renderer cannot load fonts or the resvg binary.',
    )
  }
  const response = await assets.fetch(new Request(`https://og-assets.internal${path}`))
  if (!response.ok) {
    throw new DOpConfigurationError(
      "DOP_OG_ASSET_MISSING",
      "ASSETS",
      `OGP asset ${path} is missing from the deployed bundle (status ${response.status}).`,
    )
  }
  return response.arrayBuffer()
}

// workerd forbids runtime wasm codegen, so the resvg binary enters the
// bundle as a pre-compiled WebAssembly.Module import (wrangler's default
// CompiledWasm rule for **/*.wasm — no wasm_modules config needed).
const OG_RUNTIME: OgRuntime = {
  resvgModule: resvgWasm,
  fetchAsset: fetchOgAsset,
}

// GET /p/:shareId/og.png — the crawler-facing card image. Shares the page's
// nonrevealing contract: unknown/blocked/malformed ids get a bare 404, read
// admission still applies (crawler bursts are rate-limited like page reads),
// and a storage or asset failure fails closed with an honest status rather
// than a guessed or empty image.
export const GET: APIRoute = async ({ params, request }) => {
  const result = await loadSharePage(params["shareId"], request, newRequestId())
  if (result.kind === "notfound") {
    return new Response(null, { status: 404 })
  }
  if (result.kind === "unavailable") {
    const response = new Response(null, { status: result.status })
    if (result.retryAfter !== null) {
      response.headers.set("retry-after", result.retryAfter)
    }
    return response
  }
  try {
    const png = await renderShareOgPng(result.view, OG_RUNTIME)
    return new Response(png as unknown as BodyInit, {
      headers: {
        "content-type": "image/png",
        // Snapshots are updated and deleted in place: keep the stale window
        // at max-age so a blocked playlist's card stops propagating quickly.
        // The ?v= content-hash token (see shareOgImageUrl) busts caches on
        // republish, so a short TTL costs little freshness-wise.
        "cache-control": "public, max-age=600",
      },
    })
  } catch {
    return new Response(null, { status: 503 })
  }
}
