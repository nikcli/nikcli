import { afterEach, describe, expect, it } from "bun:test"

/**
 * The identity verifier must read its environment at every call, not capture
 * it when `@nikcli-ai/util/flag` is first imported.
 *
 * `Flag` is imported by the first module in the process that touches a flag.
 * Under `bun test` that is whichever file happened to load a server module
 * first, so a test that exports its own issuer and HS256 secret at the top of
 * its own file — before importing anything — still got whatever the process
 * started with. Every token it signed then verified as 401, and the failure
 * appeared only when the file ran alongside others: eight tests in
 * `test/server/local-account-session.test.ts` failed in a directory run and
 * passed on their own, for a year, with nothing wrong in either file.
 *
 * This test is the guard. It imports the module first and sets the variables
 * afterwards, which is the ordering that was broken.
 */
const { identityVerifierOptions } = await import("@/server/identity-auth")

const KEYS = ["NIKCLI_AUTH_ISSUER", "NIKCLI_AUTH_JWKS_URL", "NIKCLI_AUTH_AUDIENCE", "NIKCLI_AUTH_JWT_SECRET"] as const

const saved = new Map<string, string | undefined>()
function set(key: (typeof KEYS)[number], value: string | undefined) {
  if (!saved.has(key)) saved.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved.clear()
})

describe("identityVerifierOptions reads the environment at call time", () => {
  it("picks up an issuer set after the module was imported", () => {
    set("NIKCLI_AUTH_ISSUER", "https://issuer.example")
    set("NIKCLI_AUTH_JWT_SECRET", undefined)
    expect(identityVerifierOptions()?.issuer).toBe("https://issuer.example")
  })

  it("picks up a JWT secret set after the module was imported", () => {
    set("NIKCLI_AUTH_ISSUER", "https://issuer.example")
    set("NIKCLI_AUTH_JWT_SECRET", "a-secret-long-enough-for-hs256-abcdefgh")
    const options = identityVerifierOptions()
    expect(options?.jwtSecret).toBe("a-secret-long-enough-for-hs256-abcdefgh")
    // A local secret replaces JWKS entirely: signing is symmetric, so there is
    // no key set to fetch and reaching for one would be a network call the
    // caller did not ask for.
    expect(options?.jwksUrl).toBeUndefined()
  })

  it("derives the JWKS url from the issuer when no secret is set", () => {
    set("NIKCLI_AUTH_ISSUER", "https://issuer.example")
    set("NIKCLI_AUTH_JWT_SECRET", undefined)
    set("NIKCLI_AUTH_JWKS_URL", undefined)
    expect(identityVerifierOptions()?.jwksUrl).toBe("https://issuer.example/.well-known/jwks.json")
  })

  it("picks up an explicit JWKS url set after the module was imported", () => {
    set("NIKCLI_AUTH_ISSUER", "https://issuer.example")
    set("NIKCLI_AUTH_JWT_SECRET", undefined)
    set("NIKCLI_AUTH_JWKS_URL", "https://keys.example/jwks.json")
    expect(identityVerifierOptions()?.jwksUrl).toBe("https://keys.example/jwks.json")
  })

  it("picks up an audience set after the module was imported, and defaults without one", () => {
    set("NIKCLI_AUTH_ISSUER", "https://issuer.example")
    set("NIKCLI_AUTH_AUDIENCE", "custom-audience")
    expect(identityVerifierOptions()?.audience).toBe("custom-audience")
    set("NIKCLI_AUTH_AUDIENCE", undefined)
    expect(identityVerifierOptions()?.audience).toBe("nikcli-api")
  })

  it("honours the off switch set after the module was imported", () => {
    for (const off of ["off", "0", "false", "none", "OFF"]) {
      set("NIKCLI_AUTH_ISSUER", off)
      expect(identityVerifierOptions()).toBeUndefined()
    }
  })
})
