import { describe, expect, test } from "bun:test"
import { startupTerminalMode } from "../../script/tui-startup-terminal"
import { spawnPty } from "@nikcli-ai/util/pty"

describe("startup terminal evidence", () => {
  test("default remains a non-answering PTY even when attached", () => {
    expect(startupTerminalMode(undefined, false, false)).toBe("non-answering-pty")
    expect(startupTerminalMode("0", true, true)).toBe("non-answering-pty")
  })

  test("relay refuses headless or redirected streams", () => {
    for (const [input, output] of [
      [false, false],
      [true, false],
      [false, true],
    ]) {
      expect(() => startupTerminalMode("1", input, output)).toThrow("requires attached terminal")
    }
    expect(startupTerminalMode("1", true, true)).toBe("attached-terminal")
    expect(() => startupTerminalMode("ghostty", true, true)).toThrow("must be 0 or 1")
  })

  test("relay carries output and replies through real PTYs and restores input ownership", async () => {
    const module = new URL("../../script/tui-startup-terminal.ts", import.meta.url).pathname
    const ptyModule = new URL("../../../util/src/pty.ts", import.meta.url).pathname
    const inner = `process.stdin.setRawMode(true); process.stdin.once('data', (data) => { process.stdout.write('REPLY:' + data.toString().trim()); process.exit(0) }); process.stdout.write('PROBE_READY')`
    const script = `
      import { spawnPty } from ${JSON.stringify(ptyModule)};
      import { relayStartupTerminal } from ${JSON.stringify(module)};
      const raw = process.stdin.isRaw;
      const listeners = process.stdin.listenerCount('data');
      const child = spawnPty({ command: process.execPath, args: ['-e', ${JSON.stringify(inner)}], env: process.env });
      const restore = relayStartupTerminal(child);
      child.onExit(() => {
        restore(); restore();
        console.log('RESTORED:' + (process.stdin.isRaw === raw && process.stdin.listenerCount('data') === listeners));
        process.exit(0);
      });
    `
    const outer = spawnPty({
      command: process.execPath,
      args: ["-e", script],
      env: process.env,
    })
    let output = ""
    let sent = false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const exit = await new Promise<number>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`relay did not finish: ${output}`)), 5000)
        outer.onData((data) => {
          output += data
          if (sent || !output.includes("PROBE_READY")) return
          sent = true
          outer.write("terminal-response\n")
        })
        outer.onExit(({ exitCode }) => resolve(exitCode))
      })
      expect(exit).toBe(0)
      expect(output).toContain("REPLY:terminal-response")
      expect(output).toContain("RESTORED:true")
    } finally {
      clearTimeout(timer)
      outer.kill()
    }
  })
})
