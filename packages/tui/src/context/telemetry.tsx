import { createSignal, onCleanup } from "solid-js"
import { useSDK } from "./sdk"
import { createSimpleContext } from "./helper"
import { createTelemetryBuffer } from "@tui/util/telemetry-buffer"

export type TelemetryRecord = {
  id: string
  traceId: string
  parentId?: string
  name: string
  kind: string
  startTime: number
  durationMs: number
  statusCode?: number
  statusMessage?: string
  attributes?: Record<string, string>
}

// Records telemetry spans in the background from app start, so the live panel
// shows the whole conversation's spans the moment it is opened (not only the
// ones emitted while it is on screen).
//
// The buffer is what keeps that affordable. Writing the signal per span meant
// rebuilding a 2000-element array on every span of a busy turn, to render
// frames faster than a terminal can show them; `createTelemetryBuffer` keeps
// the same bound and tells the panel on a flush window instead.
export const { use: useTelemetry, provider: TelemetryProvider } = createSimpleContext({
  name: "Telemetry",
  init: () => {
    const sdk = useSDK()
    const [records, setRecords] = createSignal<TelemetryRecord[]>([])

    const buffer = createTelemetryBuffer<TelemetryRecord>({
      onFlush: (kept) => setRecords(kept.slice()),
    })

    sdk.event.on("telemetry.record", (event) => {
      buffer.push(event.properties)
    })

    // A flush parked behind the window would otherwise be the last thing the
    // panel never received.
    onCleanup(() => buffer.flushNow())

    return {
      records,
      clear: () => {
        buffer.clear()
        setRecords([])
      },
    }
  },
})
