import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

// `UserSession` resolves the token file once, at import time, from
// `Global.Path.data` — and the preload wipes `XDG_DATA_HOME`, which would land
// it on the *real* one in this developer's home. Point it at an empty test home
// before the module graph loads, so "no stored token" means what it says.
const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-user-api-home-"))
process.env.NIKCLI_TEST_HOME = testHome
preserveTestEnv(["NIKCLI_TEST_HOME"])
await fs.mkdir(path.join(testHome, "data"), { recursive: true })

const { UserApi } = await import("@tui/util/user-api")

afterAll(async () => {
  await removeTestDir(testHome)
})

const user = { id: "usr_1", email: "owner@example.com" }

/**
 * A transport that answers once, and records what it was asked.
 *
 * The real one is `sdk.fetch` over worker RPC; what matters here is only the
 * shape of the answer, since that is what the startup gate reads.
 */
function sdk(answer: Response | (() => never), url = "http://nikcli.local") {
  const seen: Request[] = []
  return {
    seen,
    sdk: {
      url,
      fetch: (async (input: string, init?: RequestInit) => {
        seen.push(new Request(input, init))
        if (typeof answer === "function") answer()
        return answer
      }) as unknown as typeof fetch,
    },
  }
}

/**
 * The startup gate in `app.tsx` opens the sign-in dialog on this answer, so
 * "the server did not answer" and "the server says nobody is signed in" have
 * to be different things. Collapsing them is what put the sign-in chooser in
 * front of a user who had never signed out: a background service still booting
 * — or restarted mid-launch by an auto-update — reads as signed out.
 */
describe("UserApi.session", () => {
  it("reports the account the server returns", async () => {
    const t = sdk(Response.json(user))
    expect(await UserApi.session(t.sdk)).toEqual({ status: "signed-in", user: user as never })
  })

  it("asks even with no stored token", async () => {
    // `/user/me` answers a caller on this machine from the account row it
    // refreshes itself, so an empty token file is not a local verdict.
    const t = sdk(Response.json(user))
    await UserApi.session(t.sdk)
    expect(t.seen).toHaveLength(1)
    expect(t.seen[0]!.url).toBe("http://nikcli.local/user/me")
    expect(t.seen[0]!.headers.get("authorization")).toBeNull()
  })

  it("reports signed out only when the server refuses", async () => {
    for (const status of [401, 403]) {
      const t = sdk(new Response("Unauthorized", { status }))
      expect(await UserApi.session(t.sdk)).toEqual({ status: "signed-out" })
    }
  })

  it("reports unknown when the server fails rather than refuses", async () => {
    for (const status of [500, 502, 404]) {
      const t = sdk(new Response("nope", { status }))
      expect(await UserApi.session(t.sdk)).toEqual({ status: "unknown" })
    }
  })

  it("reports unknown when the transport throws", async () => {
    const t = sdk(() => {
      throw new Error("connection refused")
    })
    expect(await UserApi.session(t.sdk)).toEqual({ status: "unknown" })
  })

  it("reports unknown before there is a server to ask", async () => {
    const t = sdk(Response.json(user), "")
    expect(await UserApi.session(t.sdk)).toEqual({ status: "unknown" })
    expect(t.seen).toHaveLength(0)
  })

  it("maps the same answers onto me()", async () => {
    expect(await UserApi.me(sdk(Response.json(user)).sdk)).toEqual(user as never)
    expect(await UserApi.me(sdk(new Response("", { status: 401 })).sdk)).toBeNull()
    expect(await UserApi.me(sdk(new Response("", { status: 503 })).sdk)).toBeNull()
  })
})
