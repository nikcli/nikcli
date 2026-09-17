/**
 * The MCP catalog's texts in English (S41).
 *
 * The catalog itself stays one list with its Italian texts, because those are
 * reviewed against each vendor's page and a second copy inline would double
 * every entry. English sits here, by entry id, and the page picks it when the
 * interface is in English. An entry missing here shows its Italian text: a
 * new server is never hidden for want of a translation, and the test in
 * `catalog-en.test.ts` says which ones are missing.
 */
import { locale } from "../i18n"
import type { McpCatalogEntry } from "./mcp-catalog"

export interface CatalogEnglish {
  readonly description: string
  readonly authentication: string
  readonly warning?: string
}

export const CATALOG_EN: Readonly<Record<string, CatalogEnglish>> = {
  github: {
    description: "Manage GitHub repositories, issues, pull requests and workflows from the agent.",
    authentication: "OAuth or personal access token",
    warning: "Local mode needs Docker; remote OAuth is the recommended choice.",
  },
  stripe: {
    description: "Read and write Stripe data: customers, payments, subscriptions and invoices.",
    authentication: "OAuth or restricted API key",
    warning: "Some write actions, such as refunds and payouts, ask a person to confirm.",
  },
  paypal: {
    description: "Manage PayPal invoices, orders, payments, subscriptions and disputes.",
    authentication: "Remote OAuth or local access token",
    warning: "The local server also needs Docker or npx; the verified remote endpoint is /mcp, not /http.",
  },
  notion: {
    description: "Search, read, create and update Notion pages and databases.",
    authentication: "Remote OAuth or local integration token",
    warning: "Notion says the legacy local server is no longer actively maintained.",
  },
  linear: {
    description: "Create and update Linear issues, projects and comments.",
    authentication: "OAuth 2.1 or Linear API key",
    warning: "The old SSE endpoint is deprecated; use the streamable HTTP transport.",
  },
  figma: {
    description: "Bring Figma design context into your code, and write to the canvas.",
    authentication: "Remote OAuth or desktop app session",
    warning:
      "The remote server only accepts clients approved in Figma's catalog; the guide uses the local desktop server.",
  },
  supabase: {
    description: "Manage Supabase projects: tables, migrations, SQL, logs and Edge Functions.",
    authentication: "OAuth or personal access token",
    warning: "Supabase recommends approving tools by hand; a read-only setup is the safer choice.",
  },
  vercel: {
    description: "Manage Vercel projects and deployments, logs, docs and Web Analytics.",
    authentication: "OAuth for approved clients",
    warning: "Vercel only allows reviewed and approved clients, and ADE isn't in its verified catalog.",
  },
  cloudflare: {
    description: "Use the Cloudflare API and its dedicated servers for docs, Workers, observability and Radar.",
    authentication: "OAuth or Cloudflare API token",
    warning: "The old /sse endpoints no longer offer the HTTP+SSE transport; use streamable HTTP.",
  },
  sentry: {
    description: "Search errors and issues, analyze performance and triage in Sentry.",
    authentication: "Remote OAuth or local access token",
    warning: "The local server needs explicit Sentry scopes and, for some searches, an extra LLM key.",
  },
  slack: {
    description: "Search messages and channels, read threads and post messages in Slack.",
    authentication: "Confidential OAuth with a registered Slack app",
    warning:
      "You need a Slack app published in the Marketplace or internal to the workspace; unlisted apps aren't allowed.",
  },
  gmail: {
    description: "Search email, read threads and create drafts in Gmail.",
    authentication: "OAuth 2.0 with a client from your own Google Cloud project",
    warning: "Google Workspace MCP is in Developer Preview and needs the Gmail and MCP APIs enabled.",
  },
  "google-drive": {
    description: "Search, read and upload files on Google Drive.",
    authentication: "OAuth 2.0 with a client from your own Google Cloud project",
    warning: "Google Workspace MCP is in Developer Preview and needs the Drive and MCP APIs enabled.",
  },
  "google-calendar": {
    description: "List events, find free time and schedule meetings in Google Calendar.",
    authentication: "OAuth 2.0 with a client from your own Google Cloud project",
    warning: "Google Workspace MCP is in Developer Preview and needs the Calendar and MCP APIs enabled.",
  },
  higgsfield: {
    description:
      "Generate images and video with models such as Kling, Veo, Flux and Seedream, and browse your history.",
    authentication: "OAuth with a Higgsfield account",
    warning:
      "Community badge: the server isn't in the official MCP registry, and the official logo has to be requested from the vendor.",
  },
  "ryze-ai": {
    description: "Analyze and manage Google Ads and Meta Ads campaigns and GA4 data, with approval before any change.",
    authentication: "OAuth with Google and Meta sign-in",
    warning:
      "Community badge: gives a third party write access to your Google and Meta ad accounts. Consider it carefully.",
  },
  atlassian: {
    description: "Work across Jira, Jira Service Management, Confluence, Bitbucket, Goals and Loom.",
    authentication: "OAuth 2.1 or API token",
    warning: "The v1 endpoint is being retired; usage spends Rovo credits.",
  },
  playwright: {
    description: "Automate the browser with accessibility snapshots, navigation, clicks and forms.",
    authentication: "None",
    warning: "The package downloads browsers on first run and is still pre-1.0.",
  },
  context7: {
    description: "Get up-to-date, version-specific documentation for libraries and frameworks.",
    authentication: "Optional API key; free tier available",
    warning: "The verified remote endpoint also works without a key; a key gets you higher limits.",
  },
  filesystem: {
    description: "Read and write files, limited to the directories you allow.",
    authentication: "None",
    warning: "You need to allow at least one directory; the client's MCP Roots can replace the arguments.",
  },
  git: {
    description: "Read, search and change a Git repository: status, diff, log, commit and branch.",
    authentication: "None",
    warning: "Needs uv installed and a repository path you choose.",
  },
  "brave-search": {
    description: "Search the web, news, images and video through the Brave Search API.",
    authentication: "Brave Search API key",
    warning: "Some features need the Pro or Answers plans of the Brave API.",
  },
  asana: {
    description: "Manage Asana tasks, projects and comments.",
    authentication: "OAuth; client ID and secret if the client doesn't support DCR",
    warning: "The old beta SSE endpoint is retired; on Enterprise+ plans the admin can restrict clients.",
  },
  hubspot: {
    description: "Read and write the HubSpot CRM: contacts, companies, deals, tickets and activities.",
    authentication: "OAuth 2.1 + PKCE with your own MCP auth app",
    warning: "You need to create a HubSpot MCP auth app; the local server is for developers, not for your CRM.",
  },
  zapier: {
    description: "Run actions across more than 9,000 apps connected to Zapier.",
    authentication: "OAuth or connection token",
    warning: "Each successful tool call uses two tasks from your Zapier plan; the token is shown only once.",
  },
}

/** The entry's texts in the interface language. */
export function catalogText(entry: McpCatalogEntry): { description: string; authentication: string; warning?: string } {
  const english = locale() === "en" ? CATALOG_EN[entry.id] : undefined
  if (!english) {
    return {
      description: entry.description,
      authentication: entry.authentication.label,
      ...(entry.warning ? { warning: entry.warning } : {}),
    }
  }
  return {
    description: english.description,
    authentication: english.authentication,
    ...(entry.warning ? { warning: english.warning ?? entry.warning } : {}),
  }
}
