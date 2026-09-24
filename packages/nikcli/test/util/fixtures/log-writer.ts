// One side of a shared log: opens it (no JOIN) or joins it (JOIN = its path),
// then writes COUNT lines with short pauses so two writers interleave.
import { Log } from "@nikcli-ai/util/log"

const who = process.env.WHO ?? "?"
const count = Number(process.env.COUNT ?? 100)
await Log.init({ print: false, dev: true, level: "INFO", file: process.env.JOIN || undefined })
console.log(Log.file())
const log = Log.create({ service: `writer-${who}` })
for (let i = 0; i < count; i++) {
  log.info("line", { who, i })
  if (i % 10 === 0) await Bun.sleep(1)
}
