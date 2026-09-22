import { useCallback, useEffect, useRef, useState } from "react"
import { AppState } from "react-native"
import * as WebBrowser from "expo-web-browser"
import type { MobileClient } from "@/lib/client"
import { clearGithubDeviceAuthPending, getGithubDeviceAuthPending, setGithubDeviceAuthPending } from "@/lib/storage"
import type { GitHubDeviceAuthPollResult, GitHubDeviceAuthStart } from "@/lib/types"

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type UseGithubDeviceAuthOptions = {
  client: MobileClient | null
  onApproved: (login: string | undefined) => void | Promise<void>
  onMessage: (message: string) => void
}

/**
 * GitHub's OAuth device flow: open a browser for the user to approve a code,
 * then poll until it resolves. Used to live entirely as a client-side
 * `while` + `setTimeout` loop, duplicated near-identically in two settings
 * screens. On Android that loop stalls or dies while the user is away in the
 * browser tab — RN backgrounds/kills JS timers far more aggressively there
 * than iOS's modal-style browser presentation allows — which read as either
 * "stuck on Authorization in progress" or a false "authorization expired"
 * right after actually approving.
 *
 * This hook keeps the interval loop for the normal case but backs it with
 * two things the duplicated inline versions had neither of:
 *  - an `AppState` "active" listener that polls immediately on resume,
 *    instead of waiting for a timer that may never have fired while
 *    backgrounded;
 *  - persisting the in-flight flow to SecureStore, so a full process kill
 *    (Android reclaiming backgrounded memory) doesn't orphan an
 *    already-approved code — the next mount picks it back up and checks it.
 */
export function useGithubDeviceAuth({ client, onApproved, onMessage }: UseGithubDeviceAuthOptions) {
  const [oauthBusy, setOauthBusy] = useState(false)
  const [oauthFlow, setOauthFlow] = useState<GitHubDeviceAuthStart | null>(null)
  const authRun = useRef(0)
  const clientRef = useRef(client)
  clientRef.current = client
  const onApprovedRef = useRef(onApproved)
  onApprovedRef.current = onApproved
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage

  useEffect(
    () => () => {
      authRun.current = -1
    },
    [],
  )

  const settle = useCallback(async (runID: number, result: GitHubDeviceAuthPollResult) => {
    if (result.status === "pending") return result.interval

    // Any other status ends the flow. The loop and the AppState-triggered
    // resume poll can both land here around the same tick; claiming the run
    // by zeroing it out first (before any `await`) makes whichever call
    // arrives second a no-op instead of double-firing `onApproved`.
    if (authRun.current !== runID) return undefined
    authRun.current = 0
    setOauthFlow(null)
    await clearGithubDeviceAuthPending().catch(() => undefined)

    if (result.status === "approved") {
      await onApprovedRef.current(result.user?.login)
    } else if (result.status === "denied") {
      onMessageRef.current("GitHub authorization was denied")
    } else {
      onMessageRef.current("GitHub authorization expired. Start a new sign-in.")
    }
    return undefined
  }, [])

  const pollOnce = useCallback(
    async (flow: GitHubDeviceAuthStart, runID: number) => {
      const host = clientRef.current
      if (!host || authRun.current !== runID) return
      try {
        const result = await host.pollGithubDeviceAuth(flow.deviceCode)
        if (authRun.current !== runID) return
        await settle(runID, result)
      } catch (cause) {
        // Network/server failure mid-poll: surface a message and unblock the
        // UI so the user can retry, instead of leaving the run pinned with an
        // unclosable sheet.
        if (authRun.current !== runID) return
        authRun.current = 0
        setOauthFlow(null)
        onMessageRef.current(
          cause instanceof Error
            ? `GitHub sign-in interrupted: ${cause.message}`
            : "GitHub sign-in was interrupted by a network error. Try again.",
        )
      }
    },
    [settle],
  )

  const waitForApproval = useCallback(
    async (flow: GitHubDeviceAuthStart, runID: number) => {
      let interval = flow.interval
      while (authRun.current === runID && Date.now() < flow.expiresAt) {
        await sleep(interval * 1000)
        if (authRun.current !== runID) return
        const host = clientRef.current
        if (!host) return
        let result: GitHubDeviceAuthPollResult
        try {
          result = await host.pollGithubDeviceAuth(flow.deviceCode)
        } catch (cause) {
          if (authRun.current !== runID) return
          authRun.current = 0
          setOauthFlow(null)
          onMessageRef.current(
            cause instanceof Error
              ? `GitHub sign-in interrupted: ${cause.message}`
              : "GitHub sign-in was interrupted by a network error. Try again.",
          )
          return
        }
        if (authRun.current !== runID) return
        const nextInterval = await settle(runID, result)
        if (nextInterval === undefined) return
        interval = nextInterval
      }
      if (authRun.current === runID) {
        authRun.current = 0
        setOauthFlow(null)
        await clearGithubDeviceAuthPending().catch(() => undefined)
        onMessageRef.current("GitHub authorization expired. Start a new sign-in.")
      }
    },
    [settle],
  )

  const arm = useCallback(
    (flow: GitHubDeviceAuthStart) => {
      authRun.current += 1
      const runID = authRun.current
      setOauthFlow(flow)
      void waitForApproval(flow, runID)
      return runID
    },
    [waitForApproval],
  )

  // Resume an in-flight flow that survived a background/process kill — a
  // mount with nothing else going on is exactly when that matters.
  useEffect(() => {
    let cancelled = false
    void getGithubDeviceAuthPending().then((pending) => {
      if (cancelled || !pending || oauthFlow) return
      if (Date.now() >= pending.expiresAt) {
        void clearGithubDeviceAuthPending().catch(() => undefined)
        return
      }
      arm(pending)
    })
    return () => {
      cancelled = true
    }
    // Runs once per mount; `arm`/`oauthFlow` intentionally excluded so this
    // does not re-fire on every flow state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The Android fix: don't wait for a timer that may not have fired while
  // backgrounded — poll the moment the app is foreground again.
  useEffect(() => {
    if (!oauthFlow) return
    const runID = authRun.current
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void pollOnce(oauthFlow, runID)
    })
    return () => subscription.remove()
  }, [oauthFlow, pollOnce])

  const startGithubOAuth = useCallback(async () => {
    const host = clientRef.current
    if (!host) return
    try {
      setOauthBusy(true)
      onMessageRef.current("")
      const flow = await host.startGithubDeviceAuth()
      await setGithubDeviceAuthPending(flow).catch(() => undefined)
      arm(flow)
      void WebBrowser.openBrowserAsync(flow.verificationUriComplete || flow.verificationUri)
      onMessageRef.current("Approve GitHub in your browser. The app is waiting for confirmation.")
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      onMessageRef.current(
        /github oauth client id is not configured/i.test(text)
          ? "This nikcli host has no GitHub client ID. Update nikcli on the computer, or set one under OAuth client ID below."
          : text,
      )
    } finally {
      setOauthBusy(false)
    }
  }, [arm])

  const checkGithubApproval = useCallback(async () => {
    const host = clientRef.current
    if (!host || !oauthFlow) return
    try {
      setOauthBusy(true)
      const result = await host.pollGithubDeviceAuth(oauthFlow.deviceCode)
      if (result.status === "pending") {
        onMessageRef.current("Still waiting for GitHub approval.")
        return
      }
      await settle(authRun.current, result)
    } catch (error) {
      onMessageRef.current(error instanceof Error ? error.message : String(error))
    } finally {
      setOauthBusy(false)
    }
  }, [oauthFlow, settle])

  const cancelGithubOAuth = useCallback(() => {
    authRun.current = 0
    setOauthFlow(null)
    void clearGithubDeviceAuthPending().catch(() => undefined)
  }, [])

  return { oauthBusy, oauthFlow, startGithubOAuth, checkGithubApproval, cancelGithubOAuth }
}
