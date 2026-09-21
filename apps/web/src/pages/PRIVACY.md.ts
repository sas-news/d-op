import type { APIRoute } from "astro"

// Legacy-link preservation (task 21): the gh-pages footer linked the raw
// PRIVACY.md file at /PRIVACY.md. The content now lives on the real /privacy
// page — permanently redirect so old links land on it instead of 404ing.
export const GET: APIRoute = () => {
  return new Response(null, {
    status: 301,
    headers: { location: "/privacy" },
  })
}
