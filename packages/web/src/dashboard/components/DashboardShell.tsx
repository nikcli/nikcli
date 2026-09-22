import React, { type ReactNode, useState, useEffect } from "react"
import { AuthProvider, useAuth } from "../auth/AuthContext"
import { getErrorMessage, requestJson } from "../lib/studio-api"

const DEFAULT_SERVER_URL = "https://s.nikcli-ai.dev"

interface DashboardShellProps {
  title: string
  children: ReactNode
}

// SVG icon helpers — 16x16 viewBox, 1.5 stroke, inherits currentColor
const Icon = ({ d, d2 }: { d: string; d2?: string }) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
    {d2 && <path d={d2} />}
  </svg>
)

const icons = {
  overview: () => <Icon d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" d2="M9 22V12h6v10" />,
  sessions: () => <Icon d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  mcp: () => <Icon d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />,
  profiles: () => (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  ),
  skills: () => (
    <Icon d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
  ),
  agents: () => (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <circle cx="12" cy="5" r="2" />
      <path d="M12 7v4M8 15h.01M16 15h.01" />
    </svg>
  ),
  config: () => (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  backup: () => <Icon d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />,
  users: () => (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  settings: () => (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
}

function ServerSetup() {
  const { setServerUrl } = useAuth()
  const [url, setUrl] = useState(DEFAULT_SERVER_URL)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setChecking(true)
    try {
      // /global/health is public — proves the server is reachable before we ask for a token.
      await requestJson<unknown>("/global/health", {
        serverUrl: url,
        signal: AbortSignal.timeout(5000),
      })
      setServerUrl(url)
      window.location.href = "/dashboard/login"
    } catch (err) {
      setError(getErrorMessage(err) || "Cannot reach the nikcli server. Make sure it is running.")
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-terminal-bg p-8">
      <div className="w-full max-w-md space-y-6">
        <div className="flex flex-col items-start gap-3">
          <img
            src="/brand/wordmark-light.png"
            alt="nikcli"
            width={158}
            height={52}
            loading="eager"
            decoding="async"
            className="h-10 w-auto dark:hidden"
          />
          <img
            src="/brand/wordmark-dark.png"
            alt="nikcli"
            width={158}
            height={52}
            loading="eager"
            decoding="async"
            className="h-10 w-auto hidden dark:block"
          />
          <div className="text-[12px] text-terminal-muted">Connect to your server</div>
        </div>

        <div className="rounded-[var(--radius-card)] border border-terminal-border bg-terminal-panel p-6">
          <h2 className="mb-1 text-[15px] font-semibold text-terminal-text">Server URL</h2>
          <p className="mb-4 text-[13px] text-terminal-muted">Enter the address of your running nikcli server</p>
          <form onSubmit={handleConnect} className="space-y-3">
            {error && (
              <div className="rounded-[var(--radius-md)] border border-terminal-error/30 bg-terminal-error/8 px-4 py-3 text-[13px] text-terminal-error">
                {error}
              </div>
            )}
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={DEFAULT_SERVER_URL}
              required
              className="w-full rounded-[var(--radius-md)] border border-terminal-border bg-terminal-bg px-4 py-2.5 text-[13px] text-terminal-text placeholder:text-terminal-muted/50 focus:border-terminal-accent focus:outline-none focus:ring-2 focus:ring-terminal-accent/20 transition-colors duration-150"
            />
            <button
              type="submit"
              disabled={checking}
              className="w-full rounded-[var(--radius-md)] bg-terminal-accent px-4 py-2.5 text-[13px] font-semibold text-terminal-bg transition-all duration-150 hover:opacity-90 disabled:opacity-50 active:scale-[0.97]"
            >
              {checking ? "Connecting…" : "Connect"}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}

function Spinner() {
  return (
    <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-terminal-bg">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-terminal-border border-t-terminal-accent" />
    </div>
  )
}

type NavItem = {
  href: string
  label: string
  icon: () => React.ReactElement
  exact?: boolean
}

const navSections: Array<{ heading: string; items: NavItem[] }> = [
  {
    heading: "Dashboard",
    items: [
      {
        href: "/dashboard",
        label: "Overview",
        icon: icons.overview,
        exact: true,
      },
      { href: "/dashboard/sessions", label: "Sessions", icon: icons.sessions },
    ],
  },
  {
    heading: "Studio",
    items: [
      { href: "/dashboard/mcp", label: "MCP Servers", icon: icons.mcp },
      { href: "/dashboard/profiles", label: "Profiles", icon: icons.profiles },
      { href: "/dashboard/skills", label: "Skills", icon: icons.skills },
      { href: "/dashboard/agents", label: "Agents", icon: icons.agents },
      { href: "/dashboard/config", label: "Config", icon: icons.config },
      { href: "/dashboard/backup", label: "Backup", icon: icons.backup },
    ],
  },
  {
    heading: "Account",
    items: [
      { href: "/dashboard/users", label: "Users", icon: icons.users },
      { href: "/dashboard/settings", label: "Settings", icon: icons.settings },
    ],
  },
]

function DashboardShellInner({ title, children }: DashboardShellProps) {
  const { user, loading, logout, serverUrl, connected } = useAuth()
  const [mounted, setMounted] = useState(false)
  const [navOpen, setNavOpen] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  // Lock body scroll while the mobile nav drawer is open
  useEffect(() => {
    if (typeof document === "undefined") return
    document.body.style.overflow = navOpen ? "hidden" : ""
    return () => {
      document.body.style.overflow = ""
    }
  }, [navOpen])

  // Close the drawer on Escape
  useEffect(() => {
    if (!navOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [navOpen])

  useEffect(() => {
    if (mounted && !loading && !connected && serverUrl) {
      window.location.href = "/dashboard/login"
    }
  }, [mounted, loading, connected, serverUrl])

  if (!mounted) return <Spinner />
  if (!serverUrl) return <ServerSetup />
  if (loading && !connected) return <Spinner />
  if (!connected || !user) return null

  const pathname = typeof window !== "undefined" ? window.location.pathname : ""
  const isActive = (href: string, exact?: boolean) =>
    exact ? pathname === href : pathname === href || pathname.startsWith(href + "/")

  return (
    <div className="flex">
      {/* Mobile drawer backdrop */}
      {navOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-30 bg-black/50 backdrop-blur-[2px] lg:hidden"
          style={{ top: "var(--topbar-height)" }}
        />
      )}

      {/* Sidebar — positioned below the main Navbar; off-canvas drawer on mobile */}
      <aside
        className={[
          "fixed left-0 bottom-0 z-40 w-64 max-w-[82vw] border-r border-terminal-border bg-terminal-panel flex flex-col",
          "transition-transform duration-200 ease-out lg:translate-x-0 lg:shadow-none",
          navOpen ? "translate-x-0 shadow-strong" : "-translate-x-full",
        ].join(" ")}
        style={{ top: "var(--topbar-height)" }}
      >
        {/* Nav sections */}
        <nav className="flex-1 overflow-y-auto p-3 space-y-0.5">
          {navSections.map((section) => (
            <div key={section.heading} className="mb-1">
              <div className="px-3 py-2 text-[10.5px] font-display font-bold uppercase tracking-[0.18em] text-terminal-muted/50">
                {section.heading}
              </div>
              {section.items.map(({ href, label, icon: IconFn, exact }) => {
                const active = isActive(href, exact)
                return (
                  <a
                    key={href}
                    href={href}
                    onClick={() => setNavOpen(false)}
                    className={[
                      "relative flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-2.5 text-[13px] font-medium transition-colors duration-100",
                      active
                        ? "bg-terminal-accent/10 text-terminal-accent"
                        : "text-terminal-muted hover:bg-terminal-border/30 hover:text-terminal-text",
                    ].join(" ")}
                    aria-current={active ? "page" : undefined}
                  >
                    {active && (
                      <span
                        className="absolute left-0 inset-y-[6px] w-[3px] bg-terminal-accent rounded-full"
                        aria-hidden="true"
                      />
                    )}
                    <span className={active ? "text-terminal-accent" : "text-terminal-muted/70"}>
                      <IconFn />
                    </span>
                    {label}
                  </a>
                )
              })}
            </div>
          ))}
        </nav>

        {/* User footer */}
        <div className="border-t border-terminal-border p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-terminal-accent/15 text-[12px] font-bold text-terminal-accent border border-terminal-accent/20">
                {(user.displayName?.[0] ?? user.username[0]).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="text-[12px] font-semibold text-terminal-text truncate">
                  {user.displayName || user.username}
                </div>
                <div className="text-[11px] text-terminal-muted truncate">{user.email}</div>
              </div>
            </div>
            <button
              onClick={() => logout()}
              className="shrink-0 rounded-[var(--radius-sm)] border border-terminal-border px-2.5 py-1 text-[11px] font-medium text-terminal-muted transition-all duration-100 hover:border-terminal-error/50 hover:text-terminal-error active:scale-[0.94]"
            >
              Out
            </button>
          </div>

          {/* Server status */}
          {serverUrl && (
            <div className="mt-2.5 flex items-center gap-2 px-1">
              <div className="h-1.5 w-1.5 rounded-full bg-terminal-success shrink-0" />
              <span className="font-mono text-[10.5px] text-terminal-muted/60 truncate">{serverUrl}</span>
            </div>
          )}
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 min-w-0 lg:ml-64 min-h-[calc(100vh-4rem)]">
        {/* Subtle page breadcrumb + mobile nav toggle */}
        <div className="sticky top-[var(--topbar-height)] z-20 flex items-center gap-1.5 h-12 px-4 sm:px-6 lg:px-8 border-b border-terminal-border/40 bg-terminal-bg/80 backdrop-blur-sm">
          <button
            type="button"
            onClick={() => setNavOpen((v) => !v)}
            aria-label={navOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={navOpen}
            className="-ml-1.5 mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-terminal-border text-terminal-muted transition-colors hover:bg-terminal-border/40 hover:text-terminal-text lg:hidden"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {navOpen ? <path d="M6 18L18 6M6 6l12 12" /> : <path d="M4 6h16M4 12h16M4 18h16" />}
            </svg>
          </button>
          <span className="hidden text-[12.5px] font-medium text-terminal-muted/70 sm:inline">Studio</span>
          <svg
            className="mx-1.5 hidden w-3 h-3 text-terminal-muted/40 sm:block"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
          </svg>
          <span className="truncate text-[12.5px] font-medium text-terminal-text">{title}</span>
        </div>
        <div className="p-4 sm:p-6 lg:p-8">{children}</div>
      </main>
    </div>
  )
}

export function DashboardShell({ title, children }: DashboardShellProps) {
  return (
    <AuthProvider>
      <DashboardShellInner title={title}>{children}</DashboardShellInner>
    </AuthProvider>
  )
}
