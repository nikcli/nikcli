/// <reference path="../.sst/platform/config.d.ts" />

export const domain = (() => {
  if ($app.stage === "production") return "nikcli-ai.dev"
  if ($app.stage === "dev") return "dev.nikcli-ai.dev"
  return `${$app.stage}.dev.nikcli-ai.dev`
})()

export const zoneID = process.env.CLOUDFLARE_ZONE_ID || "e4372dcd6576e2ab82dff394486f080e"

if (process.env.CLOUDFLARE_ENABLE_REGIONAL_HOSTNAME === "1") {
  new cloudflare.RegionalHostname("RegionalHostname", {
    hostname: domain,
    regionKey: "us",
    zoneId: zoneID,
  })
}

export const shortDomain = (() => {
  if ($app.stage === "production") return "s.nikcli-ai.dev"
  if ($app.stage === "dev") return "dev.s.nikcli-ai.dev"
  return `${$app.stage}.dev.s.nikcli-ai.dev`
})()
