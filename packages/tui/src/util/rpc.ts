export namespace Rpc {
  type Definition = {
    [method: string]: (input: any) => any
  }

  /**
   * Install the worker side, then tell the client it may send.
   *
   * Bun delivers a message that reaches a worker while its module is still
   * suspended on a top-level `await` to no listener, and drops it. The client
   * starts calling as soon as the worker is constructed, so without this a
   * request made during that window was lost — and since `call` has no timeout,
   * so was its caller: the TUI's first bootstrap, which is why a start could
   * never paint (`specs/effect-tui/00-startup-hang.md`). `rpc.ready` is posted
   * only after `onmessage` is in place, and the client holds every request until
   * it arrives, so no import in the worker's graph can reopen the window.
   */
  export function listen(rpc: Definition) {
    onmessage = async (evt) => {
      const parsed = JSON.parse(evt.data)
      if (parsed.type === "rpc.request") {
        try {
          const result = await rpc[parsed.method](parsed.input)
          postMessage(JSON.stringify({ type: "rpc.result", result, id: parsed.id }))
        } catch (error) {
          postMessage(
            JSON.stringify({
              type: "rpc.error",
              error: serializeError(error),
              id: parsed.id,
            }),
          )
        }
      }
    }
    postMessage(JSON.stringify({ type: "rpc.ready" }))
  }

  function serializeError(error: unknown) {
    if (error instanceof Error) {
      // Carry the extra fields too. Effect's tagged errors keep the actual reason in one of them
      // — `UpgradeFailedError.stderr` is the whole message, while `.message` is empty — so
      // name/message/stack alone arrives on the other side as a failure with nothing to show.
      const { name: _n, message: _m, stack: _s, ...rest } = error as Error & Record<string, unknown>
      const data = JSON.parse(JSON.stringify(rest ?? {})) as Record<string, unknown>
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
        data,
      }
    }
    return {
      name: "Error",
      message: String(error),
    }
  }

  /**
   * The receiver gets a plain `Error`: the class cannot cross a worker boundary, so `instanceof`
   * against the original type is always false there. Match on `name` and read `data` instead.
   */
  function deserializeError(input: { name?: string; message?: string; stack?: string; data?: unknown }) {
    const error = new Error(input.message ?? "RPC request failed")
    error.name = input.name ?? "Error"
    error.stack = input.stack
    if (input.data && typeof input.data === "object") Object.assign(error, input.data)
    return error
  }

  export function emit(event: string, data: unknown) {
    postMessage(JSON.stringify({ type: "rpc.event", event, data }))
  }

  export function client<T extends Definition>(target: {
    postMessage: (data: string) => void | null
    onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null
  }) {
    const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>()
    const listeners = new Map<string, Set<(data: any) => void>>()
    let id = 0
    // Requests made before the worker said `rpc.ready`, in call order. See `listen`.
    let ready = false
    let outbox: { id: number; frame: string }[] = []
    const send = (requestId: number, frame: string) => {
      try {
        target.postMessage(frame)
      } catch (error) {
        const request = pending.get(requestId)
        pending.delete(requestId)
        request?.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    target.onmessage = async (evt) => {
      const parsed = JSON.parse(evt.data)
      if (parsed.type === "rpc.ready") {
        if (ready) return
        ready = true
        const queued = outbox
        outbox = []
        for (const item of queued) send(item.id, item.frame)
        return
      }
      if (parsed.type === "rpc.result") {
        const request = pending.get(parsed.id)
        if (request) {
          request.resolve(parsed.result)
          pending.delete(parsed.id)
        }
      }
      if (parsed.type === "rpc.error") {
        const request = pending.get(parsed.id)
        if (request) {
          request.reject(deserializeError(parsed.error))
          pending.delete(parsed.id)
        }
      }
      if (parsed.type === "rpc.event") {
        const handlers = listeners.get(parsed.event)
        if (handlers) {
          for (const handler of handlers) {
            handler(parsed.data)
          }
        }
      }
    }
    return {
      call<Method extends keyof T>(method: Method, input: Parameters<T[Method]>[0]): Promise<ReturnType<T[Method]>> {
        const requestId = id++
        return new Promise((resolve, reject) => {
          let frame: string
          try {
            frame = JSON.stringify({ type: "rpc.request", method, input, id: requestId })
          } catch (error) {
            reject(error)
            return
          }
          pending.set(requestId, { resolve, reject })
          if (ready) send(requestId, frame)
          else outbox.push({ id: requestId, frame })
        })
      },
      on<Data>(event: string, handler: (data: Data) => void) {
        let handlers = listeners.get(event)
        if (!handlers) {
          handlers = new Set()
          listeners.set(event, handlers)
        }
        handlers.add(handler)
        return () => {
          handlers!.delete(handler)
        }
      },
      rejectPending(error: Error = new Error("RPC client disposed")) {
        outbox = []
        for (const request of pending.values()) {
          request.reject(error)
        }
        pending.clear()
      },
    }
  }
}
