import type { APIRoute } from "astro"

function shortDomain(requestURL: URL) {
  const protocol = "https:"
  const hostname = requestURL.hostname

  if (hostname === "nikcli-ai.dev") return `${protocol}//s.nikcli-ai.dev`
  if (hostname === "dev.nikcli-ai.dev") return `${protocol}//dev.s.nikcli-ai.dev`
  if (hostname.endsWith(".dev.nikcli-ai.dev")) {
    const stage = hostname.slice(0, -".dev.nikcli-ai.dev".length)
    if (stage) return `${protocol}//${stage}.dev.s.nikcli-ai.dev`
  }

  const stage = import.meta.env.SST_STAGE
  if (stage === "production") return `${protocol}//s.nikcli-ai.dev`
  if (!stage || stage === "dev") return `${protocol}//dev.s.nikcli-ai.dev`
  return `${protocol}//${stage}.dev.s.nikcli-ai.dev`
}

export const GET: APIRoute = ({ params, url }) => {
  const id = params.id
  if (!id) {
    return new Response("Missing share ID", { status: 400 })
  }

  const target = new URL(`/share/${encodeURIComponent(id)}`, shortDomain(url))
  target.search = url.search

  return Response.redirect(target.toString(), 308)
}
