import { preserveTestEnv } from "../helpers/env"
import { afterEach, describe, expect, it, spyOn } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { removeTestDir } from "../helpers/fs"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-service-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
process.env.XDG_DATA_HOME = path.join(testHome, "data")
process.env.XDG_CACHE_HOME = path.join(testHome, "cache")
process.env.XDG_CONFIG_HOME = path.join(testHome, "config")
process.env.XDG_STATE_HOME = path.join(testHome, "state")

preserveTestEnv([
  "NIKCLI_TEST_HOME",
  "NIKCLI_DISABLE_PROJECT_CONFIG",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
])

const { Global } = await import("@nikcli-ai/util/global")
const { BackgroundService } = await import("@/service/service")
const { Installation } = await import("@/installation")

const registrationPath = () => path.join(Global.Path.state, BackgroundService.filename())

async function writeRegistration(value: unknown) {
  await fs.mkdir(Global.Path.state, { recursive: true })
  await fs.writeFile(registrationPath(), typeof value === "string" ? value : JSON.stringify(value))
}

async function registrationExists() {
  return fs
    .access(registrationPath())
    .then(() => true)
    .catch(() => false)
}

/** A port nothing is listening on, so the health probe is guaranteed to fail. */
const DEAD_URL = "http://127.0.0.1:9"

/** A live process that is not a service: what a reused pid looks like. */
function spawnBystander() {
  return Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1 << 30)"], {
    stdio: ["ignore", "ignore", "ignore"],
  })
}

/**
 * A stand-in service in its own process: answers health with `FAKE_VERSION`
 * and, on SIGTERM, writes `SUCCESSOR_JSON` to `SUCCESSOR_FILE` (when given)
 * before exiting — a new service registering while the old one shuts down.
 */
const FAKE_SERVICE = `
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => Response.json({ healthy: true, version: process.env.FAKE_VERSION }),
})
process.on("SIGTERM", async () => {
  if (process.env.SUCCESSOR_FILE) await Bun.write(process.env.SUCCESSOR_FILE, process.env.SUCCESSOR_JSON)
  server.stop(true)
  process.exit(0)
})
console.log(server.url.origin)
setInterval(() => {}, 1 << 30)
`

async function spawnFakeService(env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, "-e", FAKE_SERVICE], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "ignore"],
  })
  const reader = child.stdout.getReader()
  let text = ""
  while (!text.includes("\n")) {
    const { value, done } = await reader.read()
    if (done) break
    text += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  return { child, url: text.trim() }
}

function untouched(child: ReturnType<typeof Bun.spawn>) {
  return child.exitCode === null && child.signalCode === null
}

afterEach(async () => {
  await fs.rm(registrationPath(), { force: true }).catch(() => {})
})

describe("BackgroundService.discover", () => {
  it("reports nothing when no registration exists", async () => {
    expect(await BackgroundService.discover()).toBeUndefined()
  })

  it("removes a registration whose process is gone", async () => {
    // A pid this high is beyond every platform's default pid_max, so it cannot
    // collide with a real process and make the test pass for the wrong reason.
    await writeRegistration({ pid: 4_194_303, url: DEAD_URL, version: "x", startedAt: 1 })
    expect(await BackgroundService.discover()).toBeUndefined()
    expect(await registrationExists()).toBe(false)
  })

  it("removes a registration whose process is alive but unreachable", async () => {
    // This test process is certainly alive, and nothing answers on DEAD_URL —
    // exactly the shape of a service that crashed and had its pid reused.
    await writeRegistration({ pid: process.pid, url: DEAD_URL, version: "x", startedAt: 1 })
    expect(await BackgroundService.discover()).toBeUndefined()
    expect(await registrationExists()).toBe(false)
  })

  it("ignores a corrupt registration instead of throwing", async () => {
    await writeRegistration("this is not json")
    expect(await BackgroundService.discover()).toBeUndefined()
  })

  it("ignores a registration missing the fields it needs", async () => {
    await writeRegistration({ url: DEAD_URL })
    expect(await BackgroundService.discover()).toBeUndefined()
  })

  it("gives a service that is slow to answer another chance instead of writing it off", async () => {
    // Removing the entry of a live service evicts it, suspending every
    // session it runs. One health answer lost to a blocked event loop must
    // not be enough.
    let calls = 0
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        calls++
        if (calls === 1) await Bun.sleep(2_500)
        return Response.json({ healthy: true, version: "1.2.3" })
      },
    })
    try {
      await writeRegistration({ id: "busy", pid: process.pid, url: server.url.origin, version: "1.2.3", startedAt: 1 })
      const found = await BackgroundService.discover()
      expect(found?.id).toBe("busy")
      expect(calls).toBe(2)
      expect(await registrationExists()).toBe(true)
    } finally {
      server.stop(true)
    }
  }, 10_000)
})

describe("BackgroundService.status", () => {
  it("reports not running with no registration", async () => {
    const status = await BackgroundService.status()
    expect(status.running).toBe(false)
    expect(status.registration).toBeUndefined()
    expect(status.file).toBe(registrationPath())
  })
})

describe("per-channel isolation", () => {
  it("keeps shared channels on one file and gives every other channel its own", () => {
    for (const channel of ["latest", "dev", "beta", "next"]) {
      expect(BackgroundService.filename(channel)).toBe("service.json")
    }
    // A local dev build must not discover — and restart — an installed release.
    expect(BackgroundService.filename("local")).toBe("service-local.json")
    expect(BackgroundService.filename("pr-123")).toBe("service-pr-123.json")
  })

  it("sanitises a channel name into a filename that cannot leave the state directory", () => {
    expect(BackgroundService.filename("feat/some thing")).toBe("service-feat-some-thing.json")
    // Dots survive the whitelist, which is fine: what matters is that no path
    // separator does, so the result is always a plain name in the state dir.
    for (const hostile of ["../escape", "..", "a/../../b", "c:\\windows", "x\u0000y"]) {
      const name = BackgroundService.filename(hostile)
      expect(name).not.toContain("/")
      expect(name).not.toContain("\\")
      expect(path.basename(name)).toBe(name)
    }
  })

  it("gives each channel a distinct, in-range default port", () => {
    expect(BackgroundService.defaultPort("latest")).toBe(0xc0de)
    expect(BackgroundService.defaultPort("local")).toBe(0xc0df)
    const custom = BackgroundService.defaultPort("some-branch")
    expect(custom).toBeGreaterThanOrEqual(10_000)
    expect(custom).toBeLessThan(60_000)
    expect(BackgroundService.defaultPort("some-branch")).toBe(custom)
    expect(BackgroundService.defaultPort("another-branch")).not.toBe(custom)
  })
})

describe("versionBelongsToChannel", () => {
  it("accepts the installed version exactly", () => {
    expect(BackgroundService.versionBelongsToChannel("1.2.3", "latest", "1.2.3")).toBe(true)
  })

  it("accepts any build counter on the same preview channel", () => {
    // Otherwise every rebuild reads as version skew and restarts the service,
    // so the engine never actually stays warm on a preview channel.
    expect(BackgroundService.versionBelongsToChannel("0.0.0-mychan-42", "mychan", "0.0.0-mychan-41")).toBe(true)
  })

  it("rejects another channel's build and a missing version", () => {
    expect(BackgroundService.versionBelongsToChannel("0.0.0-other-42", "mychan", "0.0.0-mychan-41")).toBe(false)
    expect(BackgroundService.versionBelongsToChannel(undefined, "mychan", "0.0.0-mychan-41")).toBe(false)
  })
})

describe("BackgroundService.stop", () => {
  it("is a no-op when nothing is registered", async () => {
    expect(await BackgroundService.stop()).toBe(false)
  })

  it("clears the registration of a process that is already gone", async () => {
    await writeRegistration({ pid: 4_194_303, url: DEAD_URL, version: "x", startedAt: 1 })
    expect(await BackgroundService.stop()).toBe(false)
    expect(await registrationExists()).toBe(false)
  })

  it("does not signal a live pid whose registered URL does not answer", async () => {
    // A crashed service leaves its entry behind, and the OS hands its pid to
    // the next process. That process must survive `service stop`.
    const bystander = spawnBystander()
    try {
      await writeRegistration({ id: "stale", pid: bystander.pid, url: DEAD_URL, version: "x", startedAt: 1 })
      expect(await BackgroundService.stop()).toBe(false)
      await Bun.sleep(100)
      expect(untouched(bystander)).toBe(true)
      expect(await registrationExists()).toBe(false)
    } finally {
      bystander.kill()
    }
  })

  it("does not signal a live pid when the registered URL answers as another version", async () => {
    const bystander = spawnBystander()
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ healthy: true, version: "other" }) })
    try {
      await writeRegistration({ id: "stale", pid: bystander.pid, url: server.url.origin, version: "x", startedAt: 1 })
      expect(await BackgroundService.stop()).toBe(false)
      await Bun.sleep(100)
      expect(untouched(bystander)).toBe(true)
    } finally {
      server.stop(true)
      bystander.kill()
    }
  })

  it("stops a verified service without deleting the entry of one that registered meanwhile", async () => {
    const successor = { id: "successor", pid: process.pid, url: "http://127.0.0.1:5000", version: "x", startedAt: 2 }
    const { child, url } = await spawnFakeService({
      FAKE_VERSION: "x",
      SUCCESSOR_FILE: registrationPath(),
      SUCCESSOR_JSON: JSON.stringify(successor),
    })
    try {
      await writeRegistration({ id: "old", pid: child.pid, url, version: "x", startedAt: 1 })
      expect(await BackgroundService.stop()).toBe(true)
      await child.exited
      expect(JSON.parse(await fs.readFile(registrationPath(), "utf8")).id).toBe("successor")
    } finally {
      child.kill()
    }
  }, 15_000)
})

describe("BackgroundService.start", () => {
  it("returns a service that registered while it waited for the lock, without spawning", async () => {
    // The caller's discover() ran before the lock was taken; a client that
    // finished starting in between must not be answered with a second engine.
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ healthy: true, version: Installation.VERSION }),
    })
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("start() spawned a second service")
    })
    try {
      await writeRegistration({
        id: "raced",
        pid: process.pid,
        url: server.url.origin,
        version: Installation.VERSION,
        startedAt: 1,
      })
      const found = await BackgroundService.start()
      expect(found.id).toBe("raced")
      expect(spawn).not.toHaveBeenCalled()
      const lock = path.join(Global.Path.state, `${BackgroundService.filename()}.lock`)
      expect(
        await fs
          .access(lock)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
    } finally {
      spawn.mockRestore()
      server.stop(true)
    }
  })
})

describe("BackgroundService.register", () => {
  it("writes an owned registration and cleans it up through the disposer", async () => {
    const release = await BackgroundService.register("http://127.0.0.1:4096")
    const raw = JSON.parse(await fs.readFile(registrationPath(), "utf8"))
    expect(raw.pid).toBe(process.pid)
    expect(raw.url).toBe("http://127.0.0.1:4096")
    expect(typeof raw.id).toBe("string")
    expect(raw.id.length).toBeGreaterThan(0)
    await release()
    expect(await registrationExists()).toBe(false)
  })

  it("leaves no temp file behind (the write is a rename, not an append)", async () => {
    const release = await BackgroundService.register("http://127.0.0.1:4096")
    const entries = await fs.readdir(Global.Path.state)
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([])
    await release()
  })

  it("stands down when another instance takes the registration over", async () => {
    let evicted = 0
    const release = await BackgroundService.register("http://127.0.0.1:4096", () => evicted++, { intervalMs: 20 })
    try {
      await writeRegistration({ id: "successor", pid: process.pid, url: "http://127.0.0.1:5000", version: "x" })
      await Bun.sleep(150)
      expect(evicted).toBe(1)
    } finally {
      await release()
    }
  })

  it("does not stand down because a read of the registration failed", async () => {
    // EMFILE or EIO under load says nothing about ownership. A directory in the
    // file's place makes every read fail without the file being "gone".
    let evicted = 0
    const release = await BackgroundService.register("http://127.0.0.1:4096", () => evicted++, { intervalMs: 20 })
    try {
      await fs.rm(registrationPath(), { force: true })
      await fs.mkdir(registrationPath())
      await Bun.sleep(150)
      expect(evicted).toBe(0)
    } finally {
      await fs.rm(registrationPath(), { recursive: true, force: true })
      await release()
    }
  })

  it("does not delete a registration it no longer owns", async () => {
    // An older instance exiting must not take the newer one's entry with it,
    // or the survivor becomes undiscoverable while still serving.
    const release = await BackgroundService.register("http://127.0.0.1:4096")
    const successor = { id: "someone-else", pid: process.pid, url: "http://127.0.0.1:5000", version: "x", startedAt: 2 }
    await writeRegistration(successor)
    await release()
    expect(await registrationExists()).toBe(true)
    expect(JSON.parse(await fs.readFile(registrationPath(), "utf8")).id).toBe("someone-else")
  })
})

describe("BackgroundService.password", () => {
  const passwordPath = () => path.join(Global.Path.state, BackgroundService.filename().replace(/\.json$/, ".password"))

  afterEach(async () => {
    await fs.rm(passwordPath(), { force: true }).catch(() => {})
  })

  it("generates one password, keeps it, and writes it for this user only", async () => {
    const first = await BackgroundService.password()
    expect(first.length).toBeGreaterThanOrEqual(32)
    expect(await BackgroundService.password()).toBe(first)
    if (process.platform !== "win32") expect((await fs.stat(passwordPath())).mode & 0o777).toBe(0o600)
  })

  it("agrees on one password when clients generate it at the same time", async () => {
    // Whichever password the service did not read would be refused on every
    // request, so concurrent first starts must converge on one.
    const all = await Promise.all(Array.from({ length: 8 }, () => BackgroundService.password()))
    expect(new Set(all).size).toBe(1)
    expect((await fs.readFile(passwordPath(), "utf8")).trim()).toBe(all[0]!)
    const entries = await fs.readdir(Global.Path.state)
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  it("replaces the password with a given value and refuses an empty one", async () => {
    await BackgroundService.password()
    expect(await BackgroundService.password(" chosen ")).toBe("chosen")
    expect(await BackgroundService.password()).toBe("chosen")
    await expect(BackgroundService.password("  ")).rejects.toThrow()
    expect(await BackgroundService.password()).toBe("chosen")
  })

  it("does not adopt an empty password file", async () => {
    await fs.mkdir(Global.Path.state, { recursive: true })
    await fs.writeFile(passwordPath(), "")
    const generated = await BackgroundService.password()
    expect(generated.length).toBeGreaterThanOrEqual(32)
    expect((await fs.readFile(passwordPath(), "utf8")).trim()).toBe(generated)
  })
})

describe("BackgroundService.authorizedFetch", () => {
  const credentials = BackgroundService.authorization("secret")

  function recorder() {
    const seen: Array<{ authorization: string | null; token: string | null }> = []
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url)
        seen.push({ authorization: request.headers.get("authorization"), token: url.searchParams.get("token") })
        return new Response("ok")
      },
    })
    return { server, seen }
  }

  it("presents the credentials to the service", async () => {
    const { server, seen } = recorder()
    try {
      const fetcher = BackgroundService.authorizedFetch(server.url.origin, credentials)
      await fetcher(`${server.url.origin}/session`)
      await fetcher(new Request(`${server.url.origin}/session`))
      expect(seen).toEqual([
        { authorization: credentials, token: null },
        { authorization: credentials, token: null },
      ])
      expect(credentials).toBe(`Basic ${btoa("nikcli:secret")}`)
    } finally {
      server.stop(true)
    }
  })

  it("never sends the password to another host", async () => {
    const service = recorder()
    const other = recorder()
    try {
      const fetcher = BackgroundService.authorizedFetch(service.server.url.origin, credentials)
      await fetcher(`${other.server.url.origin}/image.png`)
      expect(other.seen).toEqual([{ authorization: null, token: null }])
    } finally {
      service.server.stop(true)
      other.server.stop(true)
    }
  })

  it("keeps a bearer as ?token= so the call keeps its identity and its admission", async () => {
    const { server, seen } = recorder()
    try {
      const fetcher = BackgroundService.authorizedFetch(server.url.origin, credentials)
      await fetcher(`${server.url.origin}/user/me`, { headers: { authorization: "Bearer issuer.jwt" } })
      expect(seen).toEqual([{ authorization: credentials, token: "issuer.jwt" }])
    } finally {
      server.stop(true)
    }
  })

  it("leaves credentials the caller chose alone", async () => {
    const { server, seen } = recorder()
    try {
      const fetcher = BackgroundService.authorizedFetch(server.url.origin, credentials)
      await fetcher(`${server.url.origin}/session`, { headers: { authorization: "Basic other" } })
      expect(seen).toEqual([{ authorization: "Basic other", token: null }])
    } finally {
      server.stop(true)
    }
  })
})

describe("BackgroundService.withCredentials", () => {
  const credentials = BackgroundService.authorization("secret")

  it("adds the credential, and moves a bearer into ?token= beside it", () => {
    const plain = new URL("http://127.0.0.1:1/session")
    const plainHeaders = new Headers()
    expect(BackgroundService.withCredentials(plain, plainHeaders, credentials)).toBe(true)
    expect(plainHeaders.get("authorization")).toBe(credentials)
    expect(plain.searchParams.has("token")).toBe(false)

    const withBearer = new URL("http://127.0.0.1:1/user/me")
    const bearerHeaders = new Headers({ authorization: "Bearer issuer.jwt" })
    expect(BackgroundService.withCredentials(withBearer, bearerHeaders, credentials)).toBe(true)
    expect(bearerHeaders.get("authorization")).toBe(credentials)
    expect(withBearer.searchParams.get("token")).toBe("issuer.jwt")
  })

  it("leaves credentials the caller chose alone", () => {
    const target = new URL("http://127.0.0.1:1/session")
    const headers = new Headers({ authorization: "Basic other" })
    expect(BackgroundService.withCredentials(target, headers, credentials)).toBe(false)
    expect(headers.get("authorization")).toBe("Basic other")
  })
})

describe("BackgroundService.connection", () => {
  it("presents the service's password to the service and asks for the client's directory", async () => {
    await writeRegistration({ id: "svc", pid: process.pid, url: "http://127.0.0.1:4321", version: "x", startedAt: 1 })
    const service = await BackgroundService.connection("http://localhost:4321")
    expect(service.service).toBe(true)
    expect(typeof service.fetch).toBe("function")
  })

  it("leaves another server as it was when no NIKCLI_SERVER_PASSWORD is set", async () => {
    const other = await BackgroundService.connection("http://127.0.0.1:9999")
    expect(other).toEqual({ service: false })
  })
})

describe("ServiceConfig", () => {
  it("refuses service credentials as env settings, which the service password would override", async () => {
    const { ServiceConfig } = await import("@/service/config")
    await expect(ServiceConfig.set("env", "NIKCLI_SERVER_PASSWORD", "x")).rejects.toThrow("nikcli service password")
    await expect(ServiceConfig.set("env", "NIKCLI_SERVER_USERNAME", "x")).rejects.toThrow("nikcli service password")
  })
})

describe("BackgroundService.isServiceUrl", () => {
  it("treats every loopback name as the registered host, and nothing else", async () => {
    expect(await BackgroundService.isServiceUrl("http://127.0.0.1:4321")).toBe(false)
    await writeRegistration({ id: "svc", pid: process.pid, url: "http://127.0.0.1:4321", version: "x", startedAt: 1 })
    expect(await BackgroundService.isServiceUrl("http://127.0.0.1:4321")).toBe(true)
    expect(await BackgroundService.isServiceUrl("http://localhost:4321/")).toBe(true)
    expect(await BackgroundService.isServiceUrl("http://localhost:4322")).toBe(false)
    expect(await BackgroundService.isServiceUrl("https://127.0.0.1:4321")).toBe(false)
    expect(await BackgroundService.isServiceUrl("http://example.com:4321")).toBe(false)
  })
})

describe("BackgroundService.health", () => {
  it("returns the version of a healthy server", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === "/global/health"
          ? Response.json({ healthy: true, version: "1.2.3" })
          : new Response("no", { status: 404 }),
    })
    try {
      expect(await BackgroundService.health(server.url.origin)).toEqual({ version: "1.2.3" })
    } finally {
      server.stop(true)
    }
  })

  it("treats a server that answers without `healthy: true` as down", async () => {
    // A 200 is not enough: an unrelated process on the port, or a half-started
    // server, can answer. The body is the contract.
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ version: "1.2.3" }) })
    try {
      expect(await BackgroundService.health(server.url.origin)).toBeUndefined()
    } finally {
      server.stop(true)
    }
  })

  it("returns undefined instead of throwing when nothing answers", async () => {
    expect(await BackgroundService.health(DEAD_URL, 250)).toBeUndefined()
  })
})

process.on("beforeExit", () => {
  void removeTestDir(testHome)
})
