import { Runtime } from "../framework/runtime"
import { passthrough } from "../framework/args"
import { Commands } from "../commands"
import { Log } from "@nikcli-ai/util/log"
import { bootstrap } from "@/cli/bootstrap"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { ACP } from "@/acp/agent"
import { Server } from "@/server/server"
import { createNikcliClient } from "@nikcli-ai/sdk/httpapi"
import { Auth } from "@/server/httpapi/auth"
import { resolveNetworkOptions } from "@/cli/network"

export const log = Log.create({ service: "acp-command" })

export default Runtime.handler(Commands.commands["acp"], async (input) => {
  const args = {
    _: [],
    $0: "nikcli",
    "--": passthrough(),
    port: input["port"],
    hostname: input["hostname"],
    mdns: input["mdns"],
    cors: [...input["cors"]],
    cwd: input["cwd"],
  }
  await bootstrap(process.cwd(), async () => {
    // SAFETY: this command's builder is `withNetworkOptions`, which declares
    // exactly the flags `resolveNetworkOptions` reads. yargs infers a wider
    // argv type than the builder guarantees.
    const opts = await resolveNetworkOptions(args as Parameters<typeof resolveNetworkOptions>[0])
    const server = Server.listen(opts)

    // This process's own server, reached over its socket: present the
    // credentials it requires, as every in-process client does.
    const authorization = Auth.authorizationHeader()
    const sdk = createNikcliClient({
      baseUrl: `http://${server.hostname}:${server.port}`,
      headers: authorization ? { authorization } : undefined,
    })

    const input = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          process.stdout.write(chunk, (err) => {
            if (err) {
              reject(err)
            } else {
              resolve()
            }
          })
        })
      },
    })
    const output = new ReadableStream<Uint8Array>({
      start(controller) {
        process.stdin.on("data", (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk))
        })
        process.stdin.on("end", () => controller.close())
        process.stdin.on("error", (err) => controller.error(err))
      },
    })

    const stream = ndJsonStream(input, output)
    const agent = await ACP.init({ sdk })

    new AgentSideConnection((conn) => {
      return agent.create(conn, { sdk })
    }, stream)

    log.info("setup connection")
    process.stdin.resume()
    await new Promise((resolve, reject) => {
      process.stdin.on("end", resolve)
      process.stdin.on("error", reject)
    })
  })
})
