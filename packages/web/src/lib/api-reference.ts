/**
 * Joins the OpenAPI document to the reader-facing grouping in
 * `src/data/apiGroups.ts`. Build-time only — see the note in `openapi.ts`.
 */
import { apiGroups, groupOwns, type ApiGroup } from "../data/apiGroups"
import { allOperations, referencedSchemas, spec, type Operation } from "./openapi"

export type ApiSection = {
  /** Second path segment the section covers, e.g. `git` in `/mobile/git/status`. */
  key: string
  title: string
  anchor: string
  operations: Operation[]
}

export type ApiGroupPage = {
  group: ApiGroup
  operations: Operation[]
  sections: ApiSection[]
  /** Schema names reachable from this group, linkable within the page. */
  schemaNames: string[]
}

function sectionTitle(key: string) {
  if (key === "") return "Root"
  return key.replace(/[-_]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
}

/**
 * Splits a group into sub-sections when it is large enough that one flat list
 * stops being navigable. The split key is the path segment after the group's
 * common prefix, which is what the server's own route files are organised by.
 */
function sectionsFor(group: ApiGroup, operations: Operation[]): ApiSection[] {
  if (operations.length < 14) return []
  const depth = group.include ? group.include[0]!.split("/").length : 2
  const buckets = new Map<string, Operation[]>()
  for (const operation of operations) {
    const segments = operation.path.split("/").filter(Boolean)
    const key = segments[depth - 1] ?? segments[segments.length - 1] ?? ""
    const bucket = buckets.get(key)
    if (bucket) bucket.push(operation)
    else buckets.set(key, [operation])
  }
  if (buckets.size < 2) return []
  return [...buckets.entries()].map(([key, ops]) => ({
    key,
    title: sectionTitle(key),
    anchor: `section-${key || "root"}`,
    operations: ops,
  }))
}

export function groupPage(slug: string): ApiGroupPage | undefined {
  const group = apiGroups.find((candidate) => candidate.slug === slug)
  if (!group) return undefined
  const operations = allOperations().filter((entry) => groupOwns(group, entry.path, entry.operation.tags ?? []))
  return {
    group,
    operations,
    sections: sectionsFor(group, operations),
    schemaNames: referencedSchemas(operations),
  }
}

export function groupPages(): ApiGroupPage[] {
  return apiGroups.map((group) => groupPage(group.slug)!)
}

/** Totals shown on the reference overview. */
export function apiStats() {
  return {
    operations: allOperations().length,
    paths: Object.keys(spec.paths).length,
    schemas: Object.keys(spec.components?.schemas ?? {}).length,
    groups: apiGroups.length,
    version: spec.openapi,
  }
}
