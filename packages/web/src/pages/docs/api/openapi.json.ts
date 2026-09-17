import type { APIRoute } from "astro"
import specSource from "../../../../../sdk/openapi.json?raw"

/**
 * Serves the OpenAPI document that /docs/api is generated from, so a reader can
 * point a client generator at a URL instead of cloning the repository.
 *
 * Prerendered: the document is ~1.6 MB and belongs in the static assets, not in
 * the Cloudflare worker.
 */
export const prerender = true

export const GET: APIRoute = () =>
  new Response(specSource, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  })
