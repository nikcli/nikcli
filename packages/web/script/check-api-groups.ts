/**
 * Ensures the `/docs/api` grouping in src/data/apiGroups.ts covers the OpenAPI
 * document exactly: every operation lands on one page, and no group is empty.
 *
 * Run it after regenerating packages/sdk/openapi.json — a new HttpApi group
 * shows up here as an uncovered operation rather than as a silently missing
 * page.
 */
import { apiGroups, groupOwns } from "../src/data/apiGroups"

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const

const spec = (await Bun.file(new URL("../../sdk/openapi.json", import.meta.url)).json()) as {
  paths: Record<string, Record<string, { tags?: string[] }>>
}

const uncovered: string[] = []
const duplicated: string[] = []
const counts = new Map(apiGroups.map((group) => [group.slug, 0]))
let total = 0

for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of METHODS) {
    const operation = item[method]
    if (!operation) continue
    total++
    const owners = apiGroups.filter((group) => groupOwns(group, path, operation.tags ?? []))
    const label = `${method.toUpperCase()} ${path}`
    if (owners.length === 0) uncovered.push(`${label} (tags: ${(operation.tags ?? []).join(", ") || "none"})`)
    if (owners.length > 1) duplicated.push(`${label} -> ${owners.map((group) => group.slug).join(", ")}`)
    for (const owner of owners) counts.set(owner.slug, (counts.get(owner.slug) ?? 0) + 1)
  }
}

const empty = [...counts.entries()].filter(([, count]) => count === 0).map(([slug]) => slug)

if (uncovered.length > 0) console.error(`Operations with no /docs/api page:\n  ${uncovered.join("\n  ")}`)
if (duplicated.length > 0) console.error(`Operations claimed by more than one page:\n  ${duplicated.join("\n  ")}`)
if (empty.length > 0) console.error(`API reference pages with no operations: ${empty.join(", ")}`)

if (uncovered.length > 0 || duplicated.length > 0 || empty.length > 0) process.exit(1)

console.log(`api reference grouping OK (${total} operations across ${apiGroups.length} pages)`)
for (const [slug, count] of counts) console.log(`  ${slug.padEnd(20)} ${count}`)
