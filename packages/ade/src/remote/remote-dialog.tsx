/**
 * Adding a remote Space: the hosts this machine already knows, or one typed in.
 *
 * Opens on the list `discover.ts` found — `~/.ssh/config` first, then the
 * hosts in `known_hosts` — filtered by what is typed. Whatever is typed that
 * matches no host is itself a destination (`utente@host:porta`), so a machine
 * nobody configured is one Enter away too.
 */
import { createMemo, createResource, createSignal, For, onMount, Show } from "solid-js"
import { getHost } from "../host/shell"
import { discoverSshHosts, type SshDiscovery } from "./discover"
import { checkRemoteDir, parseTargetInput, targetOf, type RemoteTarget, type SshHost } from "./ssh"
import { Badge, Overlay, Row, Scroll, Stack, Surface } from "../ui/layout"
import "./remote.css"
import { t } from "../i18n"

export function RemoteSpaceDialog(props: {
  open: boolean
  onClose: () => void
  onConnect: (target: RemoteTarget) => void
}) {
  return (
    <Show when={props.open}>
      <Dialog onClose={props.onClose} onConnect={props.onConnect} />
    </Show>
  )
}

function Dialog(props: { onClose: () => void; onConnect: (target: RemoteTarget) => void }) {
  const [query, setQuery] = createSignal("")
  const [folder, setFolder] = createSignal("")
  const [problem, setProblem] = createSignal<string>()
  const [found] = createResource(async (): Promise<SshDiscovery> => {
    const host = await getHost()
    return host ? discoverSshHosts(host) : { hosts: [] }
  })
  let input: HTMLInputElement | undefined
  onMount(() => input?.focus())

  const hosts = createMemo(() => {
    const q = query().trim().toLowerCase()
    const list = found()?.hosts ?? []
    if (!q) return list
    return list.filter((host) =>
      [host.alias, host.hostName, host.user].some((field) => field?.toLowerCase().includes(q)),
    )
  })

  const connect = (host?: SshHost) => {
    const dir = checkRemoteDir(folder())
    if ("error" in dir) {
      setProblem(dir.error)
      return
    }
    if (host) {
      props.onConnect(targetOf(host, dir.dir))
      return
    }
    const typed = parseTargetInput(query())
    if ("error" in typed) {
      setProblem(typed.error)
      return
    }
    props.onConnect(dir.dir ? { ...typed, dir: dir.dir } : typed)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      props.onClose()
    } else if (event.key === "Enter") {
      event.preventDefault()
      const exact = hosts().find((host) => host.alias.toLowerCase() === query().trim().toLowerCase())
      connect(exact ?? (hosts().length === 1 && query().trim() ? hosts()[0] : undefined))
    }
  }

  return (
    <Overlay data-component="remote-space" onClose={props.onClose}>
      <Surface size="md" role="dialog" aria-modal="true" aria-label={t("remote.label")}>
        <Row as="header" justify="between" gap={4} padX={6} padY={5} border="bottom">
          <strong>{t("remote.title")}</strong>
          <Show when={found() && !found()!.client}>
            <Badge tone="error">{t("remote.noSsh")}</Badge>
          </Show>
        </Row>
        <Stack gap={3} padX={6} padY={5}>
          <input
            ref={input}
            data-slot="input"
            value={query()}
            placeholder={t("remote.target")}
            onInput={(event) => {
              setQuery(event.currentTarget.value)
              setProblem(undefined)
            }}
            onKeyDown={onKeyDown}
          />
          <input
            data-slot="input"
            value={folder()}
            placeholder={t("remote.folder")}
            onInput={(event) => {
              setFolder(event.currentTarget.value)
              setProblem(undefined)
            }}
            onKeyDown={onKeyDown}
          />
          <Show when={problem()}>
            <p data-slot="problem">{problem()}</p>
          </Show>
        </Stack>
        <Scroll max="320px" data-slot="list" role="listbox">
          <Show when={!found.loading} fallback={<p data-slot="empty">{t("remote.searching")}</p>}>
            <Show
              when={hosts().length > 0}
              fallback={<p data-slot="empty">{query().trim() ? t("remote.noKnownHost") : t("remote.noHosts")}</p>}
            >
              <For each={hosts()}>
                {(host) => (
                  <button type="button" data-slot="host" role="option" onClick={() => connect(host)}>
                    <span data-slot="alias">{host.alias}</span>
                    <span data-slot="detail">
                      {[
                        host.user && `${host.user}@`,
                        host.hostName && host.hostName !== host.alias ? host.hostName : "",
                        host.port ? `:${host.port}` : "",
                      ]
                        .filter(Boolean)
                        .join("")}
                    </span>
                    <Badge tone={host.source === "config" ? "accent" : "neutral"}>{host.source}</Badge>
                  </button>
                )}
              </For>
            </Show>
          </Show>
        </Scroll>
        <Row as="footer" justify="end" gap={3} wrap padX={6} padY={4} border="top">
          <button type="button" data-slot="secondary" onClick={() => props.onClose()}>
            {t("new.cancel")}
          </button>
          <button type="button" data-slot="primary" disabled={!query().trim()} onClick={() => connect()}>
            {t("remote.connect", query().trim() || "…")}
          </button>
        </Row>
      </Surface>
    </Overlay>
  )
}
