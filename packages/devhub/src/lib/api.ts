import { createNikcliClient, type NikcliClient, type Result } from "@nikcli-ai/sdk/httpapi"
import { native } from "./native"

/**
 * The SDK talks to the local service through the Rust proxy: the channel password
 * is read from its 0600 file there, so it never reaches the webview.
 */
export function clientFor(serviceUrl: string): NikcliClient {
  const proxied: typeof globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      const headers: Record<string, string> = {}
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
      const res = await native.api({
        serviceUrl,
        method: init?.method ?? "GET",
        path: url.pathname + url.search,
        headers,
        body: typeof init?.body === "string" ? init.body : undefined,
      })
      return new Response(res.status === 204 || res.status === 304 ? null : res.body, {
        status: res.status,
        headers: res.headers,
      })
    },
    { preconnect: () => undefined },
  )
  return createNikcliClient({ baseUrl: serviceUrl, fetch: proxied })
}

/** Unwraps the SDK result envelope so callers can use plain `await` + try/catch. */
export async function unwrap<A>(p: Promise<Result<A>>): Promise<A> {
  const r = await p
  if (r.error !== undefined) throw r.error
  return r.data as A
}
