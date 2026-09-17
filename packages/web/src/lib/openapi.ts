/**
 * Build-time reader for the OpenAPI document that backs `/docs/api`.
 *
 * The document is the same artifact the SDK generator consumes
 * (`packages/sdk/openapi.json`, written by `bun run script/generate.ts` from
 * `Server.openapi()`), so the reference pages track the real server contract
 * instead of a second, hand-maintained copy of it.
 *
 * Two constraints shape this file:
 *
 * - It is loaded with `?raw` + `JSON.parse` rather than a plain JSON import.
 *   A JSON import makes TypeScript infer a literal type for 600+ schemas,
 *   which is enough on its own to stall a typecheck.
 * - Every page that reaches this module must set `prerender = true`. The parsed
 *   document is ~1.6 MB and has no business inside the Cloudflare worker.
 */
import specSource from "../../../sdk/openapi.json?raw"

export type SchemaObject = {
  $ref?: string
  type?: string | string[]
  format?: string
  title?: string
  description?: string
  enum?: unknown[]
  const?: unknown
  default?: unknown
  properties?: Record<string, SchemaObject>
  required?: string[]
  additionalProperties?: SchemaObject | boolean
  items?: SchemaObject
  anyOf?: SchemaObject[]
  oneOf?: SchemaObject[]
  allOf?: SchemaObject[]
  nullable?: boolean
}

export type ParameterObject = {
  name: string
  in: "query" | "path" | "header" | "cookie"
  required?: boolean
  description?: string
  schema?: SchemaObject
}

export type MediaTypeObject = { schema?: SchemaObject }

export type OperationObject = {
  tags?: string[]
  operationId?: string
  summary?: string
  description?: string
  deprecated?: boolean
  parameters?: ParameterObject[]
  requestBody?: { required?: boolean; description?: string; content?: Record<string, MediaTypeObject> }
  responses?: Record<string, { description?: string; content?: Record<string, MediaTypeObject> }>
  security?: Array<Record<string, string[]>>
  "x-codeSamples"?: Array<{ lang: string; label?: string; source: string }>
}

export type OpenApiDocument = {
  openapi: string
  info: { title: string; version: string }
  paths: Record<string, Record<string, OperationObject>>
  components?: {
    schemas?: Record<string, SchemaObject>
    securitySchemes?: Record<string, Record<string, unknown>>
  }
  security?: Array<Record<string, string[]>>
  tags?: Array<{ name: string; description?: string }>
}

export const spec = JSON.parse(specSource) as OpenApiDocument

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

export type Operation = {
  method: HttpMethod
  path: string
  operation: OperationObject
  /** Stable anchor for the operation, unique across a page. */
  id: string
}

function operationAnchor(method: string, path: string) {
  const slug = path
    .replace(/[{}]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  return `op-${method}-${slug || "root"}`
}

let cachedOperations: Operation[] | undefined

/** Every operation in the document, in document order. */
export function allOperations(): Operation[] {
  if (cachedOperations) return cachedOperations
  const out: Operation[] = []
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method]
      if (!operation) continue
      out.push({ method, path, operation, id: operationAnchor(method, path) })
    }
  }
  cachedOperations = out
  return out
}

/** The bare schema name behind a `#/components/schemas/Name` pointer. */
export function refName(ref: string): string {
  return ref.slice(ref.lastIndexOf("/") + 1)
}

export function lookupSchema(name: string): SchemaObject | undefined {
  return spec.components?.schemas?.[name]
}

export function schemaAnchor(name: string): string {
  return `schema-${name}`
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }
function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (char) => ESCAPES[char]!)
}

type RenderContext = {
  /** Schema names that may be linked; anything else renders as plain text. */
  linkable?: Set<string>
  /** How many `$ref` hops to expand inline before falling back to the name. */
  expand: number
  /** Refs already expanded on the current branch, so recursive types terminate. */
  seen: Set<string>
  indent: string
}

function token(text: string, kind: "punct" | "key" | "type" | "literal" | "comment") {
  return `<span class="api-t-${kind}">${escapeHtml(text)}</span>`
}

function typeLink(name: string, ctx: RenderContext) {
  const label = token(name, "type")
  if (!ctx.linkable?.has(name)) return label
  return `<a class="api-type-link" href="#${schemaAnchor(name)}">${label}</a>`
}

/** True when a rendered fragment is safe to inline inside a union. */
function isMultiline(html: string) {
  return html.includes("\n")
}

/**
 * Visible width of a rendered fragment. Every fragment is HTML by the time a
 * union decides whether to inline it, so measuring the raw string would count
 * span markup and break short unions like `string | null` onto three lines.
 */
function visibleLength(html: string) {
  return html.replace(/<[^>]*>/g, "").length
}

/** `(a | b)[]` needs the parentheses; `Foo[]` does not. */
function needsParens(schema: SchemaObject | undefined, rendered: string) {
  if (isMultiline(rendered)) return true
  if (!schema) return false
  const members = schema.anyOf ?? schema.oneOf ?? schema.allOf
  if (members && members.length > 1) return true
  if (Array.isArray(schema.type) && schema.type.length > 1) return true
  return (schema.enum?.length ?? 0) > 1
}

function renderObject(schema: SchemaObject, ctx: RenderContext): string {
  const properties = schema.properties ?? {}
  const names = Object.keys(properties)
  const additional =
    schema.additionalProperties && typeof schema.additionalProperties === "object"
      ? schema.additionalProperties
      : undefined

  if (names.length === 0 && !additional) {
    return schema.additionalProperties === false
      ? token("{}", "punct")
      : `${token("{ [key: string]: ", "punct")}${token("unknown", "type")}${token(" }", "punct")}`
  }

  const inner = { ...ctx, indent: ctx.indent + "  " }
  const required = new Set(schema.required ?? [])
  const lines: string[] = []

  for (const name of names) {
    const property = properties[name]!
    const optional = required.has(name) ? "" : "?"
    const description = property.description
    if (description) lines.push(`${inner.indent}${token(`// ${description}`, "comment")}`)
    const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)
    lines.push(`${inner.indent}${token(key, "key")}${token(`${optional}: `, "punct")}${render(property, inner)}`)
  }

  if (additional) {
    lines.push(`${inner.indent}${token("[key: string]", "key")}${token(": ", "punct")}${render(additional, inner)}`)
  }

  return `${token("{", "punct")}\n${lines.join("\n")}\n${ctx.indent}${token("}", "punct")}`
}

function renderUnion(members: SchemaObject[], ctx: RenderContext, separator: "|" | "&"): string {
  if (members.length === 1) return render(members[0]!, ctx)
  const rendered = members.map((member) => render(member, ctx))
  if (!rendered.some(isMultiline) && rendered.reduce((width, member) => width + visibleLength(member) + 3, 0) < 72) {
    return rendered.join(token(` ${separator} `, "punct"))
  }
  const inner = ctx.indent + "  "
  return rendered.map((member) => `\n${inner}${token(`${separator} `, "punct")}${member}`).join("")
}

function renderPrimitive(schema: SchemaObject, ctx: RenderContext): string {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  if (types.length === 0) return token("unknown", "type")
  const rendered = types.map((type) => {
    switch (type) {
      case "integer":
        return token("number", "type")
      case "null":
        return token("null", "type")
      case "array":
        return `${schema.items ? render(schema.items, ctx) : token("unknown", "type")}${token("[]", "punct")}`
      case "object":
        return renderObject(schema, ctx)
      default:
        return token(type, "type")
    }
  })
  const base = rendered.join(token(" | ", "punct"))
  if (schema.format) return `${base} ${token(`/* ${schema.format} */`, "comment")}`
  return base
}

function render(schema: SchemaObject | undefined, ctx: RenderContext): string {
  if (!schema) return token("unknown", "type")

  if (schema.$ref) {
    const name = refName(schema.$ref)
    const target = lookupSchema(name)
    if (!target || ctx.expand <= 0 || ctx.seen.has(name)) return typeLink(name, ctx)
    return render(target, { ...ctx, expand: ctx.expand - 1, seen: new Set([...ctx.seen, name]) })
  }

  if (schema.const !== undefined) return token(JSON.stringify(schema.const), "literal")

  if (schema.enum) {
    const values = schema.enum.map((value) => token(JSON.stringify(value), "literal"))
    if (values.reduce((width, value) => width + visibleLength(value) + 3, 0) < 72)
      return values.join(token(" | ", "punct"))
    const inner = ctx.indent + "  "
    return values.map((value) => `\n${inner}${token("| ", "punct")}${value}`).join("")
  }

  if (schema.allOf) return renderUnion(schema.allOf, ctx, "&")
  if (schema.oneOf) return renderUnion(schema.oneOf, ctx, "|")
  if (schema.anyOf) return renderUnion(schema.anyOf, ctx, "|")

  if (schema.type === "array" || schema.items) {
    const item = render(schema.items, ctx)
    const wrapped = needsParens(schema.items, item) ? `${token("(", "punct")}${item}${token(")", "punct")}` : item
    return `${wrapped}${token("[]", "punct")}`
  }

  if (schema.properties || schema.type === "object" || schema.additionalProperties !== undefined) {
    return renderObject(schema, ctx)
  }

  return renderPrimitive(schema, ctx)
}

/**
 * Render a schema as a TypeScript-shaped, syntax-tagged HTML fragment.
 *
 * `linkable` is the set of schema names the surrounding page also documents;
 * names outside it render as plain text rather than as dead anchors.
 */
export function renderSchemaHtml(
  schema: SchemaObject | undefined,
  options: { linkable?: Set<string>; expand?: number } = {},
): string {
  return render(schema, {
    linkable: options.linkable,
    expand: options.expand ?? 1,
    seen: new Set(),
    indent: "",
  })
}

/** Direct `$ref` names reachable from a schema, without following them. */
function directRefs(schema: SchemaObject | undefined, out: Set<string>) {
  if (!schema || typeof schema !== "object") return
  if (schema.$ref) {
    out.add(refName(schema.$ref))
    return
  }
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) value.forEach((entry) => directRefs(entry as SchemaObject, out))
    else if (value && typeof value === "object") directRefs(value as SchemaObject, out)
  }
}

/** Every schema name reachable from a set of operations, transitively. */
export function referencedSchemas(operations: Operation[]): string[] {
  const queue: string[] = []
  const seen = new Set<string>()

  const visit = (schema: SchemaObject | undefined) => {
    const refs = new Set<string>()
    directRefs(schema, refs)
    for (const name of refs) {
      if (seen.has(name)) continue
      seen.add(name)
      queue.push(name)
    }
  }

  for (const { operation } of operations) {
    for (const parameter of operation.parameters ?? []) visit(parameter.schema)
    for (const media of Object.values(operation.requestBody?.content ?? {})) visit(media.schema)
    for (const response of Object.values(operation.responses ?? {})) {
      for (const media of Object.values(response.content ?? {})) visit(media.schema)
    }
  }

  while (queue.length > 0) {
    const name = queue.shift()!
    visit(lookupSchema(name))
  }

  return [...seen].sort((a, b) => a.localeCompare(b))
}

/** The media type a body is documented under, preferring JSON. */
export function primaryContent(content: Record<string, MediaTypeObject> | undefined) {
  if (!content) return undefined
  const entries = Object.entries(content)
  if (entries.length === 0) return undefined
  const json = entries.find(([type]) => type.includes("json"))
  const [mediaType, media] = json ?? entries[0]!
  return { mediaType, schema: media.schema }
}

/**
 * A JSON skeleton for a request body, used to prefill the playground editor.
 *
 * Optional fields are included: a reader filling in a request wants to see what
 * they *could* send, and deleting a line is easier than discovering a field
 * exists. Depth is capped and refs are expanded once per branch so a recursive
 * schema terminates.
 */
export function sampleJson(
  schema: SchemaObject | undefined,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): unknown {
  if (!schema || depth > 3) return null

  if (schema.$ref) {
    const name = refName(schema.$ref)
    if (seen.has(name)) return null
    const target = lookupSchema(name)
    if (!target) return null
    return sampleJson(target, depth, new Set([...seen, name]))
  }

  if (schema.const !== undefined) return schema.const
  if (schema.enum && schema.enum.length > 0) return schema.enum[0]

  // A union's first member is the one a caller is most likely to mean; `null`
  // members are skipped so an optional field shows its real shape.
  const union = schema.anyOf ?? schema.oneOf
  if (union) {
    const preferred = union.find((member) => member.type !== "null" && member.const !== null) ?? union[0]
    return sampleJson(preferred, depth, seen)
  }

  if (schema.allOf) {
    return schema.allOf.reduce<Record<string, unknown>>((merged, member) => {
      const part = sampleJson(member, depth, seen)
      return part && typeof part === "object" && !Array.isArray(part) ? { ...merged, ...part } : merged
    }, {})
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  const type = types.find((candidate) => candidate !== "null") ?? (schema.properties ? "object" : undefined)

  if (type === "array" || schema.items) {
    const item = sampleJson(schema.items, depth + 1, seen)
    return item === null ? [] : [item]
  }

  if (type === "object" || schema.properties) {
    const out: Record<string, unknown> = {}
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      out[name] = sampleJson(property, depth + 1, seen)
    }
    return out
  }

  switch (type) {
    case "string":
      return schema.format === "date-time" ? new Date(0).toISOString() : ""
    case "number":
    case "integer":
      return 0
    case "boolean":
      return false
    default:
      return null
  }
}
