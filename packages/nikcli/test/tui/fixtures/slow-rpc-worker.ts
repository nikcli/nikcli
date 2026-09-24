// A worker that, like `src/cli/cmd/tui/worker.ts`, awaits something at the top
// level before it installs its RPC listener. Bun delivers a message that arrives
// during that await to no listener, and drops it.
import { Rpc } from "@tui/util/rpc"

await Bun.sleep(Number(process.env.RPC_WORKER_DELAY_MS ?? 200))

Rpc.listen({
  echo: (input: unknown) => input,
})
