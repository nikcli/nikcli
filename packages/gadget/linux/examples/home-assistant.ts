/**
 * Home Assistant bridge — what Muse's Home Link does, as a gadget.
 *
 * Runs on any Linux box on the home network with a long-lived access token
 * for Home Assistant in `HA_TOKEN`. The agent sees three commands and asks
 * before calling the ones that change state, because the permission rules
 * on the nikcli side default to "ask" for every gadget command.
 */
import { Gadget } from "@nikcli-ai/gadget"

const HA_URL = process.env.HA_URL ?? "http://homeassistant.local:8123"

async function ha(method: string, path: string, body: unknown, signal: AbortSignal) {
  const token = process.env.HA_TOKEN
  if (!token) throw new Error("HA_TOKEN is not set")
  const response = await fetch(`${HA_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  const text = await response.text()
  return { output: text.slice(0, 64 * 1024), isError: !response.ok, exitCode: response.ok ? 0 : 1 }
}

export default new Gadget({
  name: "home",
  builtins: false,
  commands: {
    "ha.state": {
      description: "Read the state of a Home Assistant entity",
      args: { type: "object", properties: { entity: { type: "string" } }, required: ["entity"] },
      timeoutMs: 10_000,
      run: ({ entity }: { entity: string }, ctx) =>
        ha("GET", `/api/states/${encodeURIComponent(entity)}`, undefined, ctx.signal),
    },
    "ha.call": {
      description: "Call a Home Assistant service, e.g. light.turn_on with {entity_id}",
      args: {
        type: "object",
        properties: {
          domain: { type: "string" },
          service: { type: "string" },
          data: { type: "object", additionalProperties: true },
        },
        required: ["domain", "service"],
      },
      timeoutMs: 15_000,
      run: ({ domain, service, data }: { domain: string; service: string; data?: Record<string, unknown> }, ctx) =>
        ha(
          "POST",
          `/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`,
          data ?? {},
          ctx.signal,
        ),
    },
    "ha.entities": {
      description: "List entity ids, optionally filtered by domain prefix",
      args: { type: "object", properties: { domain: { type: "string" } } },
      timeoutMs: 15_000,
      async run({ domain }: { domain?: string }, ctx) {
        const result = await ha("GET", "/api/states", undefined, ctx.signal)
        if (result.isError) return result
        const states = JSON.parse(result.output) as Array<{ entity_id: string; state: string }>
        const ids = states
          .filter((item) => !domain || item.entity_id.startsWith(`${domain}.`))
          .map((item) => `${item.entity_id}=${item.state}`)
        return ids.join("\n")
      },
    },
  },
})
