/**
 * The MCP servers ADE is prepared to show in its Extensions page.
 *
 * This is deliberately data, rather than a registry fetched at runtime. The
 * list was checked against vendor documentation, official repositories, or
 * the MCP registry on 2026-09-15. Keeping the source URL beside each card
 * makes a later review possible without making the UI trust a mutable remote
 * response.
 */

export type McpOrigin = "official" | "community"
export type McpTransport = "remote" | "stdio"
export type McpInstallMode = "one-click" | "guide"
export type McpAuthKind =
  | "none"
  | "oauth"
  | "oauth-or-api-key"
  | "oauth-or-api-token"
  | "oauth-or-token"
  | "oauth-client"
  | "api-key"
  | "token"

/** The subset of an MCP server definition that ADE writes to `.mcp.json`. */
export interface McpServerConfig {
  /**
   * The transport. Claude Code reads a server with a `url` only when it says
   * `http` or `sse`; without it the entry is ignored (`claude mcp get` finds
   * no such server). Optional for `command` servers, where `stdio` is implied.
   */
  readonly type?: "http" | "sse" | "stdio"
  readonly url?: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly headers?: Readonly<Record<string, string>>
  readonly oauth?: {
    readonly clientId: string
    readonly clientSecret: string
  }
}

export interface McpAuthentication {
  readonly kind: McpAuthKind
  readonly label: string
  /** Names ADE may ask the vault integration for in S23. */
  readonly variables?: readonly string[]
}

export type McpLogo =
  | { readonly kind: "simple-icons"; readonly id: string }
  | { readonly kind: "official-file"; readonly file: string }

export interface McpInstallConfiguration {
  /** The key under `mcpServers` in `.mcp.json`. */
  readonly name: string
  readonly server: McpServerConfig
}

export interface McpInstallation {
  readonly mode: McpInstallMode
  readonly config: McpInstallConfiguration
  /** Documentation the guide button should open. */
  readonly guideUrl: string
}

export interface McpCatalogEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly origin: McpOrigin
  readonly publisher: string
  readonly transport: readonly McpTransport[]
  readonly authentication: McpAuthentication
  readonly installation: McpInstallation
  readonly sourceUrl: string
  readonly logo: McpLogo
  readonly warning?: string
}

/** A remote server: streamable HTTP unless the card says `sse`. */
function remote(
  name: string,
  url: string,
  server: Omit<McpServerConfig, "url" | "type" | "command" | "args"> = {},
  type: "http" | "sse" = "http",
): McpInstallConfiguration {
  return { name, server: { type, url, ...server } }
}

function stdio(
  name: string,
  command: string,
  args: readonly string[],
  server: Omit<McpServerConfig, "command" | "args"> = {},
): McpInstallConfiguration {
  return { name, server: { command, args, ...server } }
}

function simpleLogo(id: string): McpLogo {
  return { kind: "simple-icons", id }
}

function officialLogo(file: string): McpLogo {
  return { kind: "official-file", file }
}

function installation(mode: McpInstallMode, config: McpInstallConfiguration, guideUrl: string): McpInstallation {
  return { mode, config, guideUrl }
}

const googleWorkspaceOAuth = {
  oauth: {
    clientId: "${GOOGLE_WORKSPACE_CLIENT_ID}",
    clientSecret: "${GOOGLE_WORKSPACE_CLIENT_SECRET}",
  },
} as const

/** The 25 servers verified for S16. */
export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    id: "github",
    name: "GitHub",
    description: "Gestisce repository, issue, pull request e workflow GitHub dall'agente.",
    origin: "official",
    publisher: "GitHub",
    transport: ["remote", "stdio"],
    authentication: {
      kind: "oauth-or-token",
      label: "OAuth oppure personal access token",
      variables: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    },
    installation: installation(
      "one-click",
      remote("github", "https://api.githubcopilot.com/mcp/"),
      "https://github.com/github/github-mcp-server",
    ),
    sourceUrl: "https://github.com/github/github-mcp-server",
    logo: simpleLogo("github"),
    warning: "La modalità locale richiede Docker; OAuth remoto è la scelta consigliata.",
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Legge e scrive dati Stripe: clienti, pagamenti, abbonamenti e fatture.",
    origin: "official",
    publisher: "Stripe",
    transport: ["remote"],
    authentication: {
      kind: "oauth-or-api-key",
      label: "OAuth oppure restricted API key",
    },
    installation: installation("one-click", remote("stripe", "https://mcp.stripe.com"), "https://docs.stripe.com/mcp"),
    sourceUrl: "https://docs.stripe.com/mcp",
    logo: simpleLogo("stripe"),
    warning: "Alcune azioni di scrittura, come rimborsi e pagamenti in uscita, chiedono conferma umana.",
  },
  {
    id: "paypal",
    name: "PayPal",
    description: "Gestisce fatture, ordini, pagamenti, abbonamenti e dispute PayPal.",
    origin: "official",
    publisher: "PayPal",
    transport: ["remote", "stdio"],
    authentication: {
      kind: "oauth-or-token",
      label: "OAuth remoto oppure access token locale",
      variables: ["PAYPAL_ACCESS_TOKEN"],
    },
    installation: installation(
      "one-click",
      remote("paypal", "https://mcp.paypal.com/mcp"),
      "https://developer.paypal.com/tools/mcp-server",
    ),
    sourceUrl: "https://developer.paypal.com/tools/mcp-server",
    logo: simpleLogo("paypal"),
    warning: "Per il server locale servono anche Docker o npx; l'endpoint remoto verificato è /mcp, non /http.",
  },
  {
    id: "notion",
    name: "Notion",
    description: "Cerca, legge, crea e aggiorna pagine e database Notion.",
    origin: "official",
    publisher: "Notion",
    transport: ["remote", "stdio"],
    authentication: {
      kind: "oauth-or-token",
      label: "OAuth remoto oppure token di integrazione locale",
      variables: ["NOTION_TOKEN"],
    },
    installation: installation(
      "one-click",
      remote("notion", "https://mcp.notion.com/mcp"),
      "https://developers.notion.com/guides/mcp/get-started-with-mcp",
    ),
    sourceUrl: "https://developers.notion.com/guides/mcp/get-started-with-mcp",
    logo: simpleLogo("notion"),
    warning: "Notion indica il server locale legacy come non più mantenuto attivamente.",
  },
  {
    id: "linear",
    name: "Linear",
    description: "Crea e aggiorna issue, progetti e commenti Linear.",
    origin: "official",
    publisher: "Linear",
    transport: ["remote"],
    authentication: {
      kind: "oauth-or-api-key",
      label: "OAuth 2.1 oppure API key Linear",
    },
    installation: installation(
      "one-click",
      remote("linear", "https://mcp.linear.app/mcp"),
      "https://linear.app/docs/mcp",
    ),
    sourceUrl: "https://linear.app/docs/mcp",
    logo: simpleLogo("linear"),
    warning: "L'endpoint SSE storico è deprecato; usare il trasporto HTTP streamable.",
  },
  {
    id: "figma",
    name: "Figma",
    description: "Porta nel codice il contesto dei design Figma e può scrivere sul canvas.",
    origin: "official",
    publisher: "Figma",
    transport: ["remote"],
    authentication: {
      kind: "oauth",
      label: "OAuth remoto oppure sessione dell'app desktop",
    },
    installation: installation(
      "guide",
      remote("figma-desktop", "http://127.0.0.1:3845/mcp"),
      "https://developers.figma.com/docs/figma-mcp-server/",
    ),
    sourceUrl: "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/",
    logo: simpleLogo("figma"),
    warning: "Il remoto accetta solo client approvati dal catalogo Figma; la guida usa il server desktop locale.",
  },
  {
    id: "supabase",
    name: "Supabase",
    description: "Gestisce progetti Supabase: tabelle, migrazioni, SQL, log ed Edge Functions.",
    origin: "official",
    publisher: "Supabase",
    transport: ["remote", "stdio"],
    authentication: {
      kind: "oauth-or-token",
      label: "OAuth oppure personal access token",
      variables: ["SUPABASE_ACCESS_TOKEN"],
    },
    installation: installation(
      "one-click",
      remote("supabase", "https://mcp.supabase.com/mcp"),
      "https://supabase.com/docs/guides/getting-started/mcp",
    ),
    sourceUrl: "https://supabase.com/docs/guides/getting-started/mcp",
    logo: simpleLogo("supabase"),
    warning: "Supabase raccomanda l'approvazione manuale dei tool; la configurazione in sola lettura è più prudente.",
  },
  {
    id: "vercel",
    name: "Vercel",
    description: "Gestisce progetti e deployment Vercel, log, documentazione e Web Analytics.",
    origin: "official",
    publisher: "Vercel",
    transport: ["remote"],
    authentication: { kind: "oauth", label: "OAuth per client approvati" },
    installation: installation(
      "guide",
      remote("vercel", "https://mcp.vercel.com"),
      "https://vercel.com/docs/agent-resources/vercel-mcp",
    ),
    sourceUrl: "https://vercel.com/docs/agent-resources/vercel-mcp",
    logo: simpleLogo("vercel"),
    warning: "Vercel consente il server solo a client esaminati e approvati: ADE non è nel catalogo verificato.",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "Usa le API Cloudflare e i server dedicati a documentazione, Workers, osservabilità e Radar.",
    origin: "official",
    publisher: "Cloudflare",
    transport: ["remote"],
    authentication: {
      kind: "oauth-or-api-token",
      label: "OAuth oppure API token Cloudflare",
    },
    installation: installation(
      "one-click",
      remote("cloudflare", "https://mcp.cloudflare.com/mcp"),
      "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    ),
    sourceUrl: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    logo: simpleLogo("cloudflare"),
    warning: "Gli endpoint /sse storici non offrono più il trasporto HTTP+SSE; usare HTTP streamable.",
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Cerca errori e issue, analizza performance e fa triage in Sentry.",
    origin: "official",
    publisher: "Sentry",
    transport: ["remote", "stdio"],
    authentication: {
      kind: "oauth-or-token",
      label: "OAuth remoto oppure access token locale",
      variables: ["SENTRY_ACCESS_TOKEN"],
    },
    installation: installation("one-click", remote("sentry", "https://mcp.sentry.dev/mcp"), "https://mcp.sentry.dev/"),
    sourceUrl: "https://mcp.sentry.dev/",
    logo: simpleLogo("sentry"),
    warning: "Il server locale richiede scope Sentry espliciti e, per alcune ricerche, una chiave LLM aggiuntiva.",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Cerca messaggi e canali, legge thread e invia messaggi in Slack.",
    origin: "official",
    publisher: "Slack",
    transport: ["remote"],
    authentication: {
      kind: "oauth-client",
      label: "OAuth confidenziale con app Slack registrata",
      variables: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"],
    },
    installation: installation(
      "guide",
      remote("slack", "https://mcp.slack.com/mcp"),
      "https://docs.slack.dev/ai/mcp-server/",
    ),
    sourceUrl: "https://docs.slack.dev/ai/mcp-server/",
    logo: officialLogo("slack-logo.svg"),
    warning: "Serve un'app Slack pubblicata nel Marketplace o interna al workspace; l'app non listata è vietata.",
  },
  {
    id: "gmail",
    name: "Gmail",
    description: "Cerca email, legge thread e crea bozze in Gmail.",
    origin: "official",
    publisher: "Google",
    transport: ["remote"],
    authentication: {
      kind: "oauth-client",
      label: "OAuth 2.0 con client del proprio progetto Google Cloud",
      variables: ["GOOGLE_WORKSPACE_CLIENT_ID", "GOOGLE_WORKSPACE_CLIENT_SECRET"],
    },
    installation: installation(
      "guide",
      remote("gmail", "https://gmailmcp.googleapis.com/mcp/v1", googleWorkspaceOAuth),
      "https://developers.google.com/workspace/guides/configure-mcp-servers",
    ),
    sourceUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
    logo: simpleLogo("gmail"),
    warning: "Google Workspace MCP è in Developer Preview e richiede l'abilitazione delle API Gmail e MCP.",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Cerca, legge e carica file su Google Drive.",
    origin: "official",
    publisher: "Google",
    transport: ["remote"],
    authentication: {
      kind: "oauth-client",
      label: "OAuth 2.0 con client del proprio progetto Google Cloud",
      variables: ["GOOGLE_WORKSPACE_CLIENT_ID", "GOOGLE_WORKSPACE_CLIENT_SECRET"],
    },
    installation: installation(
      "guide",
      remote("google-drive", "https://drivemcp.googleapis.com/mcp/v1", googleWorkspaceOAuth),
      "https://developers.google.com/workspace/guides/configure-mcp-servers",
    ),
    sourceUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
    logo: simpleLogo("googledrive"),
    warning: "Google Workspace MCP è in Developer Preview e richiede l'abilitazione delle API Drive e MCP.",
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    description: "Elenca eventi, trova orari liberi e pianifica riunioni in Google Calendar.",
    origin: "official",
    publisher: "Google",
    transport: ["remote"],
    authentication: {
      kind: "oauth-client",
      label: "OAuth 2.0 con client del proprio progetto Google Cloud",
      variables: ["GOOGLE_WORKSPACE_CLIENT_ID", "GOOGLE_WORKSPACE_CLIENT_SECRET"],
    },
    installation: installation(
      "guide",
      remote("google-calendar", "https://calendarmcp.googleapis.com/mcp/v1", googleWorkspaceOAuth),
      "https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server",
    ),
    sourceUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
    logo: simpleLogo("googlecalendar"),
    warning: "Google Workspace MCP è in Developer Preview e richiede l'abilitazione delle API Calendar e MCP.",
  },
  {
    id: "higgsfield",
    name: "Higgsfield",
    description: "Genera immagini e video con modelli come Kling, Veo, Flux e Seedream e consulta lo storico.",
    origin: "community",
    publisher: "Higgsfield AI",
    transport: ["remote"],
    authentication: { kind: "oauth", label: "OAuth con account Higgsfield" },
    installation: installation(
      "one-click",
      remote("higgsfield", "https://mcp.higgsfield.ai/mcp"),
      "https://higgsfield.ai/mcp",
    ),
    sourceUrl: "https://higgsfield.ai/mcp",
    logo: officialLogo("higgsfield-logo.svg"),
    warning: "Badge community: il server non è nel registry MCP ufficiale e il logo ufficiale va richiesto al vendor.",
  },
  {
    id: "ryze-ai",
    name: "Ryze AI",
    description:
      "Analizza e gestisce campagne Google Ads e Meta Ads e dati GA4, con approvazione prima delle modifiche.",
    origin: "community",
    publisher: "Ryze AI / Meow AI, LLC",
    transport: ["remote"],
    authentication: { kind: "oauth", label: "OAuth con login Google e Meta" },
    installation: installation(
      "one-click",
      remote("ryze", "https://connector.get-ryze.ai/mcp"),
      "https://www.get-ryze.ai/mcp",
    ),
    sourceUrl: "https://www.get-ryze.ai/mcp",
    logo: officialLogo("ryze-ai-logo.svg"),
    warning:
      "Badge community: concede a un terzo accesso in scrittura agli account pubblicitari Google e Meta; valutare con cautela.",
  },
  {
    id: "atlassian",
    name: "Atlassian Rovo (Jira, Confluence)",
    description: "Lavora su Jira, Jira Service Management, Confluence, Bitbucket, Goals e Loom.",
    origin: "official",
    publisher: "Atlassian",
    transport: ["remote"],
    authentication: {
      kind: "oauth-or-api-token",
      label: "OAuth 2.1 oppure API token",
    },
    installation: installation(
      "one-click",
      remote("atlassian", "https://mcp.atlassian.com/v2/mcp"),
      "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/",
    ),
    sourceUrl:
      "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/",
    logo: simpleLogo("atlassian"),
    warning: "L'endpoint v1 è in dismissione; l'uso consuma crediti Rovo.",
  },
  {
    id: "playwright",
    name: "Playwright",
    description: "Automatizza il browser tramite snapshot di accessibilità, navigazione, click e form.",
    origin: "official",
    publisher: "Microsoft",
    transport: ["stdio"],
    authentication: { kind: "none", label: "Nessuna" },
    installation: installation(
      "one-click",
      stdio("playwright", "npx", ["@playwright/mcp@latest"]),
      "https://github.com/microsoft/playwright-mcp",
    ),
    sourceUrl: "https://github.com/microsoft/playwright-mcp",
    logo: officialLogo("playwright-logo.svg"),
    warning: "Il pacchetto scarica i browser al primo avvio ed è ancora in versione pre-1.0.",
  },
  {
    id: "context7",
    name: "Context7",
    description: "Fornisce documentazione aggiornata e specifica per versione di librerie e framework.",
    origin: "official",
    publisher: "Upstash",
    transport: ["remote", "stdio"],
    authentication: {
      kind: "api-key",
      label: "API key facoltativa; free tier disponibile",
      variables: ["CONTEXT7_API_KEY"],
    },
    installation: installation(
      "one-click",
      remote("context7", "https://mcp.context7.com/mcp"),
      "https://github.com/upstash/context7",
    ),
    sourceUrl: "https://github.com/upstash/context7",
    logo: officialLogo("context7-logo.svg"),
    warning: "L'endpoint remoto verificato risponde anche senza chiave; la chiave serve per limiti più alti.",
  },
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Legge e scrive file limitandosi alle directory consentite.",
    origin: "community",
    publisher: "MCP steering group",
    transport: ["stdio"],
    authentication: { kind: "none", label: "Nessuna" },
    installation: installation(
      "guide",
      stdio("filesystem", "npx", ["-y", "@modelcontextprotocol/server-filesystem", "${MCP_FILESYSTEM_ROOT}"]),
      "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    ),
    sourceUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    logo: simpleLogo("modelcontextprotocol"),
    warning:
      "Serve scegliere almeno una directory consentita; le MCP Roots del client possono sostituire gli argomenti.",
  },
  {
    id: "git",
    name: "Git",
    description: "Legge, cerca e modifica un repository Git: status, diff, log, commit e branch.",
    origin: "community",
    publisher: "MCP steering group",
    transport: ["stdio"],
    authentication: { kind: "none", label: "Nessuna" },
    installation: installation(
      "guide",
      stdio("git", "uvx", ["mcp-server-git", "--repository", "${MCP_GIT_REPOSITORY}"]),
      "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    ),
    sourceUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    logo: simpleLogo("git"),
    warning: "Richiede uv installato e un percorso di repository scelto dall'utente.",
  },
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Cerca web, news, immagini e video tramite la Brave Search API.",
    origin: "official",
    publisher: "Brave",
    transport: ["stdio"],
    authentication: {
      kind: "api-key",
      label: "Brave Search API key",
      variables: ["BRAVE_API_KEY"],
    },
    installation: installation(
      "guide",
      stdio("brave-search", "npx", ["-y", "@brave/brave-search-mcp-server", "--transport", "stdio"], {
        env: { BRAVE_API_KEY: "${BRAVE_API_KEY}" },
      }),
      "https://github.com/brave/brave-search-mcp-server",
    ),
    sourceUrl: "https://github.com/brave/brave-search-mcp-server",
    logo: simpleLogo("brave"),
    warning: "Alcune funzioni richiedono piani Pro o Answers della Brave API.",
  },
  {
    id: "asana",
    name: "Asana",
    description: "Gestisce task, progetti e commenti Asana.",
    origin: "official",
    publisher: "Asana",
    transport: ["remote"],
    authentication: {
      kind: "oauth-client",
      label: "OAuth; client ID e secret se il client non fa DCR",
      variables: ["ASANA_CLIENT_ID", "ASANA_CLIENT_SECRET"],
    },
    installation: installation(
      "guide",
      remote("asana", "https://mcp.asana.com/v2/mcp"),
      "https://developers.asana.com/docs/using-asanas-mcp-server",
    ),
    sourceUrl: "https://developers.asana.com/docs/using-asanas-mcp-server",
    logo: simpleLogo("asana"),
    warning: "Il vecchio endpoint SSE beta è dismesso; sui piani Enterprise+ l'admin può limitare i client.",
  },
  {
    id: "hubspot",
    name: "HubSpot",
    description: "Legge e scrive il CRM HubSpot: contatti, aziende, deal, ticket e attività.",
    origin: "official",
    publisher: "HubSpot",
    transport: ["remote"],
    authentication: {
      kind: "oauth-client",
      label: "OAuth 2.1 + PKCE con MCP auth app propria",
      variables: ["HUBSPOT_MCP_CLIENT_ID", "HUBSPOT_MCP_CLIENT_SECRET"],
    },
    installation: installation(
      "guide",
      remote("hubspot", "https://mcp.hubspot.com"),
      "https://developers.hubspot.com/mcp",
    ),
    sourceUrl: "https://developers.hubspot.com/mcp",
    logo: simpleLogo("hubspot"),
    warning: "Serve creare una MCP auth app HubSpot; il server locale è per sviluppatori, non per il CRM dell'utente.",
  },
  {
    id: "zapier",
    name: "Zapier",
    description: "Espone azioni su oltre 9.000 app collegate a Zapier.",
    origin: "official",
    publisher: "Zapier",
    transport: ["remote"],
    authentication: {
      kind: "oauth-or-token",
      label: "OAuth oppure connection token",
      variables: ["ZAPIER_CONNECTION_TOKEN"],
    },
    installation: installation(
      "guide",
      remote("zapier", "https://mcp.zapier.com/api/v1/connect", {
        headers: { Authorization: "Bearer ${ZAPIER_CONNECTION_TOKEN}" },
      }),
      "https://docs.zapier.com/mcp/home",
    ),
    sourceUrl: "https://docs.zapier.com/mcp/home",
    logo: simpleLogo("zapier"),
    warning: "Ogni tool call riuscita consuma due task del piano Zapier; il token viene mostrato una sola volta.",
  },
] as const

/** Looks up one verified server by its stable catalog id. */
export function findMcpServer(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((server) => server.id === id)
}
