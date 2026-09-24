// A server worker that never answers: `crash` dies while loading, before it
// listens; `never` stays alive but never reaches `Rpc.listen`.
const mode = process.env.RPC_WORKER_MODE

if (mode === "crash") {
  await Bun.sleep(20)
  throw new Error("worker failed while loading")
}

setInterval(() => {}, 1_000)
await new Promise(() => {})
