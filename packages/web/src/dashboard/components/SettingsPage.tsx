import { useState } from "react"
import { AuthProvider, useAuth } from "../auth/AuthContext"
import {
  getErrorMessage,
  getSharedToken,
  normalizeServerUrl,
  resolveServerBase,
  saveSharedToken,
  studioApi,
} from "../lib/studio-api"

const PROD_SERVER_URL = "https://s.nikcli-ai.dev"
const LOCAL_SERVER_URL = "http://localhost:4096"

interface SettingsSectionProps {
  title: string
  description?: string
  children: React.ReactNode
}

function SettingsSection({ title, description, children }: SettingsSectionProps) {
  return (
    <section className="rounded-[var(--radius-card)] border border-terminal-border bg-terminal-panel p-6">
      <div className="mb-5">
        <h3 className="font-display text-xl font-semibold text-terminal-text">{title}</h3>
        {description && <p className="mt-1 text-sm leading-6 text-terminal-muted">{description}</p>}
      </div>
      {children}
    </section>
  )
}

function SettingsPageInner() {
  const { user, logout, serverUrl, setServerUrl, connect } = useAuth()
  // A real account session has a "usr_…" id; the pairing-token identity is "self".
  const isAccount = !!user && user.id !== "self"
  const [serverUrlInput, setServerUrlInput] = useState(serverUrl || PROD_SERVER_URL)
  const [authToken, setAuthToken] = useState(() => getSharedToken() || "")
  const [showToken, setShowToken] = useState(false)
  const [displayName, setDisplayName] = useState(user?.displayName || "")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function saveProfile() {
    if (!user) return
    setSaving(true)
    setNotice(null)
    setError(null)
    try {
      await studioApi.users.update(user.id, { displayName: displayName.trim() || undefined })
      setNotice("Profile updated")
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  async function savePassword() {
    if (!user) return
    setNotice(null)
    setError(null)
    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters")
      return
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match")
      return
    }
    setSaving(true)
    try {
      await studioApi.users.update(user.id, { password: newPassword })
      setNewPassword("")
      setConfirmPassword("")
      setNotice("Password updated")
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  function saveServer() {
    setNotice(null)
    setError(null)
    const trimmed = serverUrlInput.trim()
    if (!trimmed) {
      setServerUrl("")
      setNotice("Server connection cleared")
      return
    }
    try {
      setServerUrl(normalizeServerUrl(trimmed))
      setNotice("Server connection updated")
    } catch (err) {
      setError(getErrorMessage(err))
    }
  }

  function applyServerPreset(url: string) {
    setNotice(null)
    setError(null)
    try {
      const normalized = normalizeServerUrl(url)
      setServerUrlInput(normalized)
      setServerUrl(normalized)
      setNotice(`Server set to ${normalized}`)
    } catch (err) {
      setError(getErrorMessage(err))
    }
  }

  async function saveToken() {
    setNotice(null)
    setError(null)
    const trimmed = authToken.trim()
    if (!trimmed) {
      saveSharedToken("")
      setNotice("Token cleared")
      return
    }
    setSaving(true)
    try {
      // Validates the token against the server and persists it for the whole ecosystem.
      await connect(trimmed)
      setNotice("Token verified and saved")
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const activeBase = resolveServerBase(serverUrl)
  const activeBackend = activeBase ? activeBase.replace(/^https?:\/\//, "") : "Not connected"

  return (
    <div className="space-y-6">
      <div className="border-b border-terminal-border/60 pb-5">
        <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-terminal-accent">
          Connection
        </p>
        <h2 className="mt-2 font-display text-2xl sm:text-3xl font-bold text-terminal-text">
          Server &amp; pairing token
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-terminal-muted">
          The Studio reads your sessions, config, MCP servers, skills and more from your nikcli server using the shared
          pairing token — the same credential used by the CLI, mobile, and web app.
        </p>
      </div>

      {error && (
        <div className="rounded-[var(--radius-md)] border border-terminal-error/30 bg-terminal-error/10 px-4 py-3 text-sm text-terminal-error">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-[var(--radius-md)] border border-terminal-success/30 bg-terminal-success/10 px-4 py-3 text-sm text-terminal-success">
          {notice}
        </div>
      )}

      {isAccount && (
        <SettingsSection title="Profile" description="Your account in the nikcli server database.">
          <div className="grid gap-4 lg:grid-cols-[auto_1fr]">
            <div className="flex h-16 w-16 items-center justify-center rounded-[var(--radius-md)] border border-terminal-accent/25 bg-terminal-accent/10 text-2xl font-bold text-terminal-accent">
              {(displayName || user?.username || "U")[0].toUpperCase()}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-1.5">
                <span className="block text-xs font-semibold uppercase tracking-[0.16em] text-terminal-muted">
                  Display name
                </span>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full rounded-[var(--radius-md)] border border-terminal-border bg-terminal-bg px-3.5 py-2.5 text-sm text-terminal-text outline-none focus:border-terminal-accent focus:ring-2 focus:ring-terminal-accent/20"
                />
              </label>
              <label className="space-y-1.5">
                <span className="block text-xs font-semibold uppercase tracking-[0.16em] text-terminal-muted">
                  Username
                </span>
                <input
                  value={user?.username || ""}
                  disabled
                  className="w-full cursor-not-allowed rounded-[var(--radius-md)] border border-terminal-border bg-terminal-border/30 px-3.5 py-2.5 text-sm text-terminal-muted"
                />
              </label>
              <label className="space-y-1.5">
                <span className="block text-xs font-semibold uppercase tracking-[0.16em] text-terminal-muted">
                  Email
                </span>
                <input
                  value={user?.email || ""}
                  disabled
                  className="w-full cursor-not-allowed rounded-[var(--radius-md)] border border-terminal-border bg-terminal-border/30 px-3.5 py-2.5 text-sm text-terminal-muted"
                />
              </label>
              <label className="space-y-1.5">
                <span className="block text-xs font-semibold uppercase tracking-[0.16em] text-terminal-muted">
                  Role
                </span>
                <input
                  value={user?.role || "user"}
                  disabled
                  className="w-full cursor-not-allowed rounded-[var(--radius-md)] border border-terminal-border bg-terminal-border/30 px-3.5 py-2.5 text-sm text-terminal-muted"
                />
              </label>
            </div>
          </div>
          <button
            onClick={saveProfile}
            disabled={saving}
            className="mt-5 rounded-[var(--radius-md)] bg-terminal-accent px-4 py-2.5 text-sm font-semibold text-terminal-bg transition-colors hover:opacity-90 disabled:opacity-50"
          >
            Save profile
          </button>
        </SettingsSection>
      )}

      {isAccount && (
        <SettingsSection title="Security" description="Rotate this account's password.">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1.5">
              <span className="block text-xs font-semibold uppercase tracking-[0.16em] text-terminal-muted">
                New password
              </span>
              <input
                type={showPassword ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                minLength={8}
                className="w-full rounded-[var(--radius-md)] border border-terminal-border bg-terminal-bg px-3.5 py-2.5 text-sm text-terminal-text outline-none focus:border-terminal-accent focus:ring-2 focus:ring-terminal-accent/20"
              />
            </label>
            <label className="space-y-1.5">
              <span className="block text-xs font-semibold uppercase tracking-[0.16em] text-terminal-muted">
                Confirm password
              </span>
              <input
                type={showPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                minLength={8}
                className="w-full rounded-[var(--radius-md)] border border-terminal-border bg-terminal-bg px-3.5 py-2.5 text-sm text-terminal-text outline-none focus:border-terminal-accent focus:ring-2 focus:ring-terminal-accent/20"
              />
            </label>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              onClick={savePassword}
              disabled={saving || !newPassword || !confirmPassword}
              className="rounded-[var(--radius-md)] bg-terminal-accent px-4 py-2.5 text-sm font-semibold text-terminal-bg transition-colors hover:opacity-90 disabled:opacity-50"
            >
              Update password
            </button>
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              className="rounded-[var(--radius-md)] border border-terminal-border px-4 py-2.5 text-sm font-medium text-terminal-text hover:bg-terminal-border/40"
            >
              {showPassword ? "Hide passwords" : "Show passwords"}
            </button>
          </div>
        </SettingsSection>
      )}

      <SettingsSection
        title="Server"
        description="Point the Studio at your nikcli server — the Railway deployment, or a local nikcli serve."
      >
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-terminal-border/60 bg-terminal-bg px-3.5 py-2.5">
          <span className="text-xs font-semibold uppercase tracking-[0.16em] text-terminal-muted">Active server</span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-terminal-accent/10 px-2.5 py-1 font-mono text-xs font-medium text-terminal-accent">
            <span className="h-1.5 w-1.5 rounded-full bg-terminal-accent" aria-hidden="true" />
            {activeBackend}
          </span>
        </div>
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => applyServerPreset(PROD_SERVER_URL)}
            className="rounded-[var(--radius-md)] border border-terminal-border px-3 py-1.5 text-xs font-medium text-terminal-text transition-colors hover:border-terminal-accent/50 hover:bg-terminal-accent/10"
          >
            Railway · s.nikcli-ai.dev
          </button>
          <button
            type="button"
            onClick={() => applyServerPreset(LOCAL_SERVER_URL)}
            className="rounded-[var(--radius-md)] border border-terminal-border px-3 py-1.5 text-xs font-medium text-terminal-muted transition-colors hover:border-terminal-accent/50 hover:text-terminal-text"
          >
            Local · localhost:4096
          </button>
        </div>
        <label className="block space-y-1.5">
          <span className="block text-xs font-semibold uppercase tracking-[0.16em] text-terminal-muted">
            Server URL
          </span>
          <input
            type="url"
            value={serverUrlInput}
            onChange={(e) => setServerUrlInput(e.target.value)}
            placeholder={PROD_SERVER_URL}
            className="w-full rounded-[var(--radius-md)] border border-terminal-border bg-terminal-bg px-3.5 py-2.5 text-sm text-terminal-text outline-none focus:border-terminal-accent focus:ring-2 focus:ring-terminal-accent/20"
          />
        </label>
        <button
          onClick={saveServer}
          className="mt-4 rounded-[var(--radius-md)] bg-terminal-accent px-4 py-2.5 text-sm font-semibold text-terminal-bg transition-colors hover:opacity-90"
        >
          Save server
        </button>
      </SettingsSection>

      <SettingsSection
        title="Pairing token"
        description="The Bearer token your server accepts. Create one with nikcli mobile pair, or reuse the web/mobile app token."
      >
        <label className="block space-y-1.5">
          <span className="block text-xs font-semibold uppercase tracking-[0.16em] text-terminal-muted">Token</span>
          <div className="relative">
            <input
              type={showToken ? "text" : "password"}
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              autoComplete="off"
              placeholder="nkm_…"
              className="w-full rounded-[var(--radius-md)] border border-terminal-border bg-terminal-bg px-3.5 py-2.5 pr-16 font-mono text-sm text-terminal-text outline-none focus:border-terminal-accent focus:ring-2 focus:ring-terminal-accent/20"
            />
            <button
              type="button"
              onClick={() => setShowToken((value) => !value)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-[var(--radius-sm)] px-2 py-1 text-xs text-terminal-muted hover:text-terminal-text"
            >
              {showToken ? "Hide" : "Show"}
            </button>
          </div>
        </label>
        <button
          onClick={saveToken}
          disabled={saving}
          className="mt-4 rounded-[var(--radius-md)] bg-terminal-accent px-4 py-2.5 text-sm font-semibold text-terminal-bg transition-colors hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Verifying…" : "Verify & save token"}
        </button>
      </SettingsSection>

      <SettingsSection title="Account" description="Disconnect this dashboard from the server.">
        <button
          onClick={() => logout()}
          className="rounded-[var(--radius-md)] border border-terminal-error/30 bg-terminal-error/10 px-4 py-2.5 text-sm font-semibold text-terminal-error transition-colors hover:bg-terminal-error/20"
        >
          Disconnect
        </button>
      </SettingsSection>
    </div>
  )
}

export function SettingsPage() {
  return (
    <AuthProvider>
      <SettingsPageInner />
    </AuthProvider>
  )
}
