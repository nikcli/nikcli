import { describe, expect, test } from "bun:test"
import { SignJWT } from "jose"
import { acceptedIssuers, verifyAccessToken } from "../src/verify"

const secret = "test-secret-that-is-long-enough-for-hs256"
const issuer = "https://auth.test"
const audience = "nikcli-api"

async function token(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({
    email: "user@example.com",
    client_id: "nikcli",
    ...overrides,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(typeof overrides.iss === "string" ? overrides.iss : issuer)
    .setAudience(typeof overrides.aud === "string" ? overrides.aud : audience)
    .setSubject("acc_test")
    .setIssuedAt(now)
    .setExpirationTime(typeof overrides.exp === "number" ? overrides.exp : now + 900)
    .sign(new TextEncoder().encode(secret))
}

describe("verifyAccessToken", () => {
  test("accepts valid HS256 claims", async () => {
    const result = await verifyAccessToken(await token(), {
      issuer,
      audience,
      jwtSecret: secret,
    })
    expect(result.accountID).toBe("acc_test")
    expect(result.email).toBe("user@example.com")
    expect(result.clientID).toBe("nikcli")
  })

  test("rejects an expired token beyond skew", async () => {
    await expect(
      verifyAccessToken(await token({ exp: Math.floor(Date.now() / 1000) - 61 }), {
        issuer,
        audience,
        jwtSecret: secret,
      }),
    ).rejects.toThrow()
  })

  test("accepts expiry inside the configured skew", async () => {
    const result = await verifyAccessToken(await token({ exp: Math.floor(Date.now() / 1000) - 30 }), {
      issuer,
      audience,
      jwtSecret: secret,
    })
    expect(result.accountID).toBe("acc_test")
  })

  test("rejects wrong audience", async () => {
    await expect(
      verifyAccessToken(await token({ aud: "other-api" }), {
        issuer,
        audience,
        jwtSecret: secret,
      }),
    ).rejects.toThrow()
  })

  test("rejects wrong issuer", async () => {
    await expect(
      verifyAccessToken(await token({ iss: "https://other.test" }), {
        issuer,
        audience,
        jwtSecret: secret,
      }),
    ).rejects.toThrow()
  })

  test("accepts tokens minted before the move to nikcli-ai.dev, and after it", async () => {
    for (const [configured, minted] of [
      ["https://auth.nikcli-ai.dev", "https://auth.nikcli-ai.dev"],
      ["https://auth.nikcli-ai.dev", "https://auth.nikcli-ai.dev"],
      ["https://dev.auth.nikcli-ai.dev", "https://dev.auth.nikcli-ai.dev"],
    ]) {
      const result = await verifyAccessToken(await token({ iss: minted }), {
        issuer: configured,
        audience,
        jwtSecret: secret,
      })
      expect(result.accountID).toBe("acc_test")
    }
  })

  test("does not alias the old domain to unrelated issuers", async () => {
    await expect(
      verifyAccessToken(await token({ iss: "https://auth.nikcli-ai.dev" }), {
        issuer: "https://auth.nikcli-ai.dev.evil.test",
        audience,
        jwtSecret: secret,
      }),
    ).rejects.toThrow()
    expect(acceptedIssuers(issuer)).toEqual([issuer])
  })
})
