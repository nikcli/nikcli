import { apiGroups } from "./apiGroups"

export type DocsNavItem = { title: string; href: string }

export type DocsNavGroup = {
  title: string
  items: DocsNavItem[]
}

/**
 * A top-level docs area. The sub-navbar switches between these and the sidebar
 * renders only the active one: with the generated API reference added, a single
 * sidebar carried 69 pages, which is more than anyone can scan.
 */
export type DocsNavSection = {
  id: string
  title: string
  /** Where the tab points when the reader has not already picked a page. */
  href: string
  groups: DocsNavGroup[]
}

export const docsNav: DocsNavSection[] = [
  {
    id: "docs",
    title: "Docs",
    href: "/docs",
    groups: [
      {
        title: "Getting Started",
        items: [
          { title: "Overview", href: "/docs" },
          { title: "Architecture", href: "/docs/architecture" },
          { title: "CLI Reference", href: "/docs/cli" },
        ],
      },
      {
        title: "Core",
        items: [
          { title: "Configuration", href: "/docs/configuration" },
          { title: "Agents", href: "/docs/agents" },
          { title: "Tools", href: "/docs/tools" },
          { title: "Providers", href: "/docs/providers" },
          { title: "Connectors", href: "/docs/connectors" },
          { title: "Routines", href: "/docs/routines" },
          { title: "Loops", href: "/docs/loops" },
          { title: "Missions", href: "/docs/missions" },
          { title: "Localization", href: "/docs/localization" },
          { title: "Sessions", href: "/docs/sessions" },
          { title: "Permissions", href: "/docs/permissions" },
        ],
      },
      {
        title: "Systems",
        items: [
          { title: "Server & API", href: "/docs/server-api" },
          { title: "Web App & Studio", href: "/docs/web-app" },
          { title: "Mobile", href: "/docs/mobile" },
          { title: "Sync", href: "/docs/sync" },
          { title: "MCP", href: "/docs/mcp" },
          { title: "LSP", href: "/docs/lsp" },
          { title: "Storage", href: "/docs/storage" },
          { title: "TUI", href: "/docs/tui" },
          { title: "Brain", href: "/docs/brain" },
          { title: "Island", href: "/docs/island" },
          { title: "Observability", href: "/docs/observability" },
        ],
      },
      {
        title: "Engines",
        items: [
          { title: "Computer Use", href: "/docs/computer-use" },
          { title: "Browser Control", href: "/docs/browser-control" },
          { title: "Terminal Control", href: "/docs/terminal-control" },
        ],
      },
    ],
  },
  {
    id: "guides",
    title: "Guides",
    href: "/docs/guides",
    groups: [
      {
        title: "Start here",
        items: [{ title: "All guides", href: "/docs/guides" }],
      },
      {
        title: "Extend",
        items: [
          { title: "Writing a plugin", href: "/docs/guides/plugins" },
          { title: "Plugin recipes", href: "/docs/guides/plugin-recipes" },
          { title: "Custom model providers", href: "/docs/guides/providers" },
        ],
      },
      {
        title: "Integrate",
        items: [
          { title: "Using the API", href: "/docs/guides/api" },
          { title: "Tour with real output", href: "/docs/guides/api-tour" },
          { title: "Streaming a response", href: "/docs/guides/streaming" },
          { title: "Building an interface", href: "/docs/guides/custom-interface" },
          { title: "Driving terminals", href: "/docs/guides/terminals" },
        ],
      },
      {
        title: "Automate",
        items: [
          { title: "Automating with loops", href: "/docs/guides/loops" },
          { title: "Orchestrating missions", href: "/docs/guides/missions" },
          { title: "Parallel workspaces", href: "/docs/guides/workspaces" },
          { title: "Running in CI", href: "/docs/guides/ci" },
        ],
      },
    ],
  },
  {
    id: "build",
    title: "Build",
    href: "/docs/build",
    groups: [
      {
        title: "Extend",
        items: [
          { title: "Overview", href: "/docs/build" },
          { title: "Plugins & Skills", href: "/docs/plugins" },
          { title: "TUI Feature Plugins", href: "/docs/tui-plugins" },
        ],
      },
      {
        title: "Integrate",
        items: [
          { title: "Client", href: "/docs/build/client" },
          { title: "Embedded SDK", href: "/docs/build/sdk" },
        ],
      },
    ],
  },
  {
    id: "api",
    title: "API",
    href: "/docs/api",
    groups: [
      {
        title: "API Reference",
        items: [
          { title: "Overview", href: "/docs/api" },
          ...apiGroups
            .filter((group) => group.section === "API Reference")
            .map((group) => ({ title: group.title, href: `/docs/api/${group.slug}` })),
        ],
      },
      {
        title: "Mobile",
        items: apiGroups
          .filter((group) => group.section === "API · Mobile")
          .map((group) => ({ title: group.title, href: `/docs/api/${group.slug}` })),
      },
    ],
  },
  {
    id: "reference",
    title: "Reference",
    href: "/docs/packages",
    groups: [
      {
        title: "Reference",
        items: [
          { title: "Packages & Suite", href: "/docs/packages" },
          { title: "Brand Assets", href: "/docs/brand" },
          { title: "Source Map", href: "/docs/source-map" },
          { title: "CLI Debug", href: "/docs/cli-debug" },
        ],
      },
    ],
  },
]

/** Every group across every section, in order. The retrieval index reads this. */
export const docsSidebar: DocsNavGroup[] = docsNav.flatMap((section) => section.groups)

/**
 * The section a pathname belongs to.
 *
 * Longest matching item href wins, so `/docs/api/session` resolves to the API
 * section rather than to `/docs`, which prefixes every page on the site.
 */
export function activeDocsSection(pathname: string): DocsNavSection {
  const path = pathname.replace(/\/$/, "") || "/docs"
  let best: { section: DocsNavSection; length: number } | undefined
  for (const section of docsNav) {
    for (const group of section.groups) {
      for (const item of group.items) {
        if (path !== item.href && !path.startsWith(`${item.href}/`)) continue
        if (best && best.length >= item.href.length) continue
        best = { section, length: item.href.length }
      }
    }
  }
  return best?.section ?? docsNav[0]!
}
