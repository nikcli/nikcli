import { useState } from "react"
import { AuthProvider, useAuth } from "../auth/AuthContext"
import { getErrorMessage } from "../lib/studio-api"

const DEFAULT_SERVER_URL = "https://s.nikcli-ai.dev"

type Mode = "oauth" | "account" | "token"

function LoginFormInner() {
  const { login, loginWithOAuth, connect, loading, error, serverUrl, setServerUrl } = useAuth()
  const [mode, setMode] = useState<Mode>("oauth")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [token, setToken] = useState("")
  const [showToken, setShowToken] = useState(false)
  const [urlInput, setUrlInput] = useState(serverUrl || DEFAULT_SERVER_URL)
  const [connectError, setConnectError] = useState<string | null>(null)

  const isConnected = !!serverUrl

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setConnectError(null)
    if (!isConnected) {
      try {
        setServerUrl(urlInput)
      } catch (err) {
        setConnectError(getErrorMessage(err))
      }
      return
    }
    try {
      if (mode === "oauth") await loginWithOAuth()
      else if (mode === "account") await login(email, password)
      else await connect(token)
      window.location.href = "/dashboard"
    } catch {
      /* error surfaced via context */
    }
  }

  const tabClass = (active: boolean) =>
    [
      "flex-1 rounded-[var(--radius-md)] px-3 py-2 text-[12.5px] font-semibold transition-colors",
      active ? "bg-terminal-accent/10 text-terminal-accent" : "text-terminal-muted hover:text-terminal-text",
    ].join(" ")

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {(connectError || error) && (
        <div className="rounded-[var(--radius-md)] border border-terminal-error/30 bg-terminal-error/10 px-4 py-3 text-[13px] text-terminal-error">
          {connectError || error}
        </div>
      )}

      {!isConnected && (
        <div className="space-y-2">
          <label className="block text-[13px] font-medium text-terminal-text">Server URL</label>
          <input
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            required
            placeholder={DEFAULT_SERVER_URL}
            className="w-full rounded-[var(--radius-md)] border border-terminal-border bg-terminal-panel px-4 py-3 text-[13px] text-terminal-text placeholder:text-terminal-muted/50 focus:border-terminal-accent focus:outline-none focus:ring-2 focus:ring-terminal-accent/20 transition-colors duration-150"
          />
          <p className="text-[12px] leading-5 text-terminal-muted">
            Your nikcli server (the Railway deployment, or a local <code>nikcli serve</code>).
          </p>
          <button
            type="submit"
            className="w-full rounded-[var(--radius-md)] bg-terminal-accent px-4 py-3 text-[13px] font-semibold text-terminal-bg transition-all duration-150 hover:opacity-90 active:scale-[0.97]"
          >
            Continue
          </button>
        </div>
      )}

      {isConnected && (
        <>
          <div className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-terminal-border bg-terminal-panel px-4 py-2">
            <span className="min-w-0 truncate font-mono text-[11px] text-terminal-muted">{serverUrl}</span>
            <button
              type="button"
              onClick={() => setServerUrl("")}
              className="shrink-0 text-[11px] text-terminal-accent hover:underline"
            >
              Change
            </button>
          </div>

          <div className="flex gap-1 rounded-[var(--radius-md)] border border-terminal-border bg-terminal-panel p-1">
            <button type="button" onClick={() => setMode("oauth")} className={tabClass(mode === "oauth")}>
              Nikcli account
            </button>
            <button type="button" onClick={() => setMode("account")} className={tabClass(mode === "account")}>
              Account
            </button>
            <button type="button" onClick={() => setMode("token")} className={tabClass(mode === "token")}>
              Pairing token
            </button>
          </div>

          {mode === "oauth" ? (
            <p className="text-[13px] leading-6 text-terminal-muted">
              Continue securely with GitHub or an email code through the configured Nikcli identity issuer.
            </p>
          ) : mode === "account" ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="email" className="block text-[13px] font-medium text-terminal-text">
                  Email
                </label>
                <input
                  type="email"
                  id="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="you@example.com"
                  className="w-full rounded-[var(--radius-md)] border border-terminal-border bg-terminal-panel px-4 py-3 text-[13px] text-terminal-text placeholder:text-terminal-muted/50 focus:border-terminal-accent focus:outline-none focus:ring-2 focus:ring-terminal-accent/20 transition-colors duration-150"
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="password" className="block text-[13px] font-medium text-terminal-text">
                  Password
                </label>
                <input
                  type="password"
                  id="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  placeholder="••••••••"
                  className="w-full rounded-[var(--radius-md)] border border-terminal-border bg-terminal-panel px-4 py-3 text-[13px] text-terminal-text placeholder:text-terminal-muted/50 focus:border-terminal-accent focus:outline-none focus:ring-2 focus:ring-terminal-accent/20 transition-colors duration-150"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <label htmlFor="token" className="block text-[13px] font-medium text-terminal-text">
                Pairing token
              </label>
              <div className="relative">
                <input
                  type={showToken ? "text" : "password"}
                  id="token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  required
                  autoComplete="off"
                  placeholder="nkm_…"
                  className="w-full rounded-[var(--radius-md)] border border-terminal-border bg-terminal-panel px-4 py-3 pr-16 font-mono text-[13px] text-terminal-text placeholder:text-terminal-muted/50 focus:border-terminal-accent focus:outline-none focus:ring-2 focus:ring-terminal-accent/20 transition-colors duration-150"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-[var(--radius-sm)] px-2 py-1 text-[11px] text-terminal-muted hover:text-terminal-text"
                >
                  {showToken ? "Hide" : "Show"}
                </button>
              </div>
              <p className="text-[12px] leading-5 text-terminal-muted">
                The shared CLI/mobile/web token. Create one with <code>nikcli mobile pair</code>.
              </p>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-[var(--radius-md)] bg-terminal-accent px-4 py-3 text-[13px] font-semibold text-terminal-bg transition-all duration-150 hover:opacity-90 disabled:opacity-50 active:scale-[0.97]"
          >
            {loading
              ? "Connecting…"
              : mode === "oauth"
                ? "Continue with Nikcli"
                : mode === "account"
                  ? "Legacy sign in"
                  : "Connect"}
          </button>
        </>
      )}
    </form>
  )
}

export function LoginForm() {
  return (
    <AuthProvider>
      <LoginFormInner />
    </AuthProvider>
  )
}
