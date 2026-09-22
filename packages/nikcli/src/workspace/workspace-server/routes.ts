import { GlobalBus } from "@nikcli-ai/util/global-bus"
import { EventFeed } from "@/server/httpapi/event-feed"

const HEARTBEAT = EventFeed.frame({ type: "server.heartbeat", properties: {} })

export function shouldForwardWorkspaceEvent(eventDirectory: string | undefined, allowed: Array<string | undefined>) {
  const targets = allowed.filter((target): target is string => Boolean(target))
  if (!eventDirectory || targets.length === 0) return true
  return targets.includes(eventDirectory)
}

export function workspaceEventResponse(request: Request) {
  const url = new URL(request.url)
  const directory = url.searchParams.get("directory") ?? request.headers.get("x-nikcli-directory") ?? undefined
  const workspaceID = url.searchParams.get("workspace") ?? request.headers.get("x-nikcli-workspace") ?? undefined
  const stream = EventFeed.filtered({
    signal: request.signal,
    envelope: (event) => event,
    greeting: EventFeed.frame({ type: "server.connected", properties: {} }),
    heartbeat: { frame: HEARTBEAT, intervalMs: 10_000 },
    subscribe(offer) {
      const handler = (event: { directory?: string; payload: unknown }) => {
        if (!shouldForwardWorkspaceEvent(event.directory, [directory, workspaceID])) return
        offer(event.payload, (event.payload as { type?: string } | undefined)?.type)
      }
      GlobalBus.on("event", handler)
      return () => GlobalBus.off("event", handler)
    },
  })
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  })
}
