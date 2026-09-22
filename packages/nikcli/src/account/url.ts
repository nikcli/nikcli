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

  // Ensure trailing slash
  let result = url.toString()
  if (!result.endsWith("/")) {
    result += "/"
  }

  return result
}
