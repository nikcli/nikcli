import { describe, expect, it } from "bun:test"
import { githubOAuthClientID, resolveGithubOAuthClientID } from "@/server/mobile/helpers"
import { Flag } from "@nikcli-ai/util/flag"

const ENV_KEYS = ["NIKCLI_GITHUB_OAUTH_CLIENT_ID", "GITHUB_CLIENT_ID_CONSOLE", "GITHUB_CLIENT_ID"] as const

/**
 * `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_ID_CONSOLE` carry no `NIKCLI_` prefix, so the preload's
 * per-test env wipe leaves them alone and a developer machine that exports either one would
 * otherwise decide the result.
 */
async function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, run: () => Promise<void>) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  try {
    for (const key of ENV_KEYS) {
      const value = values[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await run()
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/**
 * The precedence these tests pin used to be unreachable past its first branch: the resolver asked
 * `Flag.NIKCLI_GITHUB_OAUTH_CLIENT_ID`, which falls back to the built-in default and is therefore
 * never empty, so every host answered "flag" and a client ID saved into `nikcli.json` was stored
 * but never used.
 */
describe("github oauth client id precedence", () => {
  it("prefers an operator's env var over everything else", () => {
    expect(resolveGithubOAuthClientID({ env: ["env-client"], config: ["config-client"] })).toEqual({
      clientID: "env-client",
      source: "env",
    })
  })

  it("uses the configured client id when no env var is set", () => {
    expect(resolveGithubOAuthClientID({ config: ["config-client"] })).toEqual({
      clientID: "config-client",
      source: "config",
    })
  })

  it("falls back to the built-in default when nothing is configured", () => {
    expect(resolveGithubOAuthClientID({})).toEqual({
      clientID: Flag.NIKCLI_GITHUB_OAUTH_CLIENT_ID_DEFAULT,
      source: "flag",
    })
  })

  it("treats empty candidate lists like absent ones", () => {
    expect(resolveGithubOAuthClientID({ env: [], config: [] }).source).toBe("flag")
  })

  it("skips undefined candidates without consuming the chain", () => {
    expect(resolveGithubOAuthClientID({ env: [undefined, undefined, "third"] })).toEqual({
      clientID: "third",
      source: "env",
    })
  })

  // A blank higher-priority var must not swallow a real lower-priority one: `a || b` on untrimmed
  // values picks a whitespace-only `a`, which is how a valid GITHUB_CLIENT_ID could be lost.
  it("falls through a blank env candidate to the next one", () => {
    expect(resolveGithubOAuthClientID({ env: ["   ", "", "real-client"] })).toEqual({
      clientID: "real-client",
      source: "env",
    })
  })

  it("falls through a blank config candidate to the next one", () => {
    expect(resolveGithubOAuthClientID({ config: ["  ", "fallback-client"] })).toEqual({
      clientID: "fallback-client",
      source: "config",
    })
  })

  it("reaches the config when every env candidate is blank", () => {
    expect(resolveGithubOAuthClientID({ env: ["  ", ""], config: ["config-client"] })).toEqual({
      clientID: "config-client",
      source: "config",
    })
  })

  it("reaches the default when every candidate on both chains is blank", () => {
    expect(resolveGithubOAuthClientID({ env: ["  "], config: ["", " "] })).toEqual({
      clientID: Flag.NIKCLI_GITHUB_OAUTH_CLIENT_ID_DEFAULT,
      source: "flag",
    })
  })

  it("trims the winning value", () => {
    expect(resolveGithubOAuthClientID({ env: ["  padded-client  "] }).clientID).toBe("padded-client")
  })

  it("ships a default so no host is ever left without a client id", () => {
    expect(Flag.NIKCLI_GITHUB_OAUTH_CLIENT_ID_DEFAULT.trim()).not.toBe("")
  })
})

describe("github oauth client id env wiring", () => {
  it("ranks NIKCLI_GITHUB_OAUTH_CLIENT_ID above the two GitHub-named vars", async () => {
    await withEnv(
      {
        NIKCLI_GITHUB_OAUTH_CLIENT_ID: "nikcli-var",
        GITHUB_CLIENT_ID_CONSOLE: "console-var",
        GITHUB_CLIENT_ID: "plain-var",
      },
      async () => {
        expect(await githubOAuthClientID()).toEqual({ clientID: "nikcli-var", source: "env" })
      },
    )
  })

  it("ranks GITHUB_CLIENT_ID_CONSOLE above GITHUB_CLIENT_ID", async () => {
    await withEnv({ GITHUB_CLIENT_ID_CONSOLE: "console-var", GITHUB_CLIENT_ID: "plain-var" }, async () => {
      expect(await githubOAuthClientID()).toEqual({ clientID: "console-var", source: "env" })
    })
  })

  it("does not let a blank NIKCLI_GITHUB_OAUTH_CLIENT_ID hide a real GITHUB_CLIENT_ID", async () => {
    await withEnv({ NIKCLI_GITHUB_OAUTH_CLIENT_ID: "   ", GITHUB_CLIENT_ID: "plain-var" }, async () => {
      expect(await githubOAuthClientID()).toEqual({ clientID: "plain-var", source: "env" })
    })
  })

  it("looks past the env when none of the three vars is set", async () => {
    await withEnv({}, async () => {
      expect((await githubOAuthClientID()).source).not.toBe("env")
    })
  })
})
