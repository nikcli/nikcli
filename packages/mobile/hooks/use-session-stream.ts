import { useEffect, useRef } from "react"
import EventSource from "react-native-sse"
import { buildMobileHeaders, buildMobileUrl } from "@/lib/client"
import type { ServerConfig, SessionStreamEvent } from "@/lib/types"

function extractErrorMessage(error: unknown): string {
  if (typeof error === "string") return error

  if (error && typeof error === "object") {
    const maybeMessage = Reflect.get(error, "message")
    if (typeof maybeMessage === "string" && maybeMessage.trim()) return maybeMessage

    const maybeData = Reflect.get(error, "data")
    if (typeof maybeData === "string" && maybeData.trim()) return maybeData

    if (maybeData && typeof maybeData === "object") {
      const nestedMessage = Reflect.get(maybeData, "message")
      if (typeof nestedMessage === "string" && nestedMessage.trim()) return nestedMessage
    }
  }

  return "Session stream disconnected"
}

export function useSessionStream(input: {
  config: ServerConfig | null
  sessionID: string | undefined
  enabled?: boolean
  onEvent(event: SessionStreamEvent): void
  onError?(error: string): void
  /**
   * The stream came back after a drop. Events published while it was down
   * were never delivered — and the server closes a reader that falls too far
   * behind (a backgrounded app), so this is also how that eviction heals —
   * so whatever the screen shows must be re-read, not resumed.
   */
  onReconnect?(): void
}) {
  const onEventRef = useRef(input.onEvent)
  const onErrorRef = useRef(input.onError)
  const onReconnectRef = useRef(input.onReconnect)

  useEffect(() => {
    onEventRef.current = input.onEvent
  }, [input.onEvent])

  useEffect(() => {
    onErrorRef.current = input.onError
  }, [input.onError])

  useEffect(() => {
    onReconnectRef.current = input.onReconnect
  }, [input.onReconnect])

  // react-native-sse's EventSource does not expose a per-listener
  // removeEventListener; removeAllEventListeners() drops every
  // subscription registered below, and es.close() shuts the stream
  // down. The linter doesn't recognise this two-step teardown.
  // oxlint-disable-next-line react-doctor/effect-needs-cleanup
  useEffect(() => {
    if (!input.enabled || !input.config || !input.sessionID) return

    let active = true
    // The server greets every connection, and react-native-sse reconnects on
    // its own after a close; a second greeting is therefore a reconnection.
    let greeted = false
    const url = buildMobileUrl(input.config, `/mobile/session/${encodeURIComponent(input.sessionID)}/stream`)
    const es = new EventSource(url, {
      headers: buildMobileHeaders(input.config),
    })

    const reportError = (error: unknown) => {
      if (!active) return
      onErrorRef.current?.(extractErrorMessage(error))
    }

    const onMessage = (message: { data?: string }) => {
      if (!active || !message.data) return

      try {
        const event = JSON.parse(message.data) as SessionStreamEvent
        if (event.type === "server.connected") {
          if (greeted) onReconnectRef.current?.()
          greeted = true
        }
        onEventRef.current(event)
      } catch (error) {
        reportError(error)
      }
    }

    const onError = (event: unknown) => {
      reportError(event)
    }

    es.addEventListener("message", onMessage)
    es.addEventListener("error", onError)

    return () => {
      active = false

      try {
        es.removeAllEventListeners?.()
      } finally {
        es.close()
      }
    }
  }, [
    input.enabled,
    input.config?.directory,
    input.config?.password,
    input.config?.token,
    input.config?.url,
    input.config?.username,
    input.sessionID,
  ])
}
