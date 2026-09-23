const LEGACY_ISSUER_HOSTS: Record<string, string> = {
  "auth.nikcli.store": "auth.nikcli-ai.dev",
  "dev.auth.nikcli.store": "dev.auth.nikcli-ai.dev",
}

/**
 * Normalize a server URL to ensure it has a trailing slash and proper protocol.
 * Ported from the upstream account URL helper.
 */
export function normalizeServerUrl(input: string): string {
  if (!input) {
    return "https://auth.nikcli-ai.dev"
  }

  let url: URL
  try {
    url = new URL(input)
  } catch {
    // If it's not a valid URL, assume it's a hostname and use https
    url = new URL(`https://${input}`)
  }

  // Accounts signed in before the issuer moved hosts stored the old URL. Map it
  // so refresh goes to the current host and a new sign-in updates that row
  // instead of adding a second one for the same account.
  const moved = LEGACY_ISSUER_HOSTS[url.hostname]
  if (moved && url.protocol === "https:") url.hostname = moved

  // Ensure trailing slash
  let result = url.toString()
  if (!result.endsWith("/")) {
    result += "/"
  }

  return result
}
