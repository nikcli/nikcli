/**
 * The question ADE asks when a session starts a dev server (S46 F4, D45):
 * open it in a web pane bound to that session, or not. See `dev-server.ts`.
 */

import { For, Show, type JSX } from "solid-js"
import type { DevServerOffer } from "./dev-server"
import { t } from "../i18n"

export function DevServerOffers(props: {
  offers: readonly DevServerOffer[]
  onOpen: (offer: DevServerOffer) => void
  onDismiss: (offer: DevServerOffer) => void
}): JSX.Element {
  return (
    <Show when={props.offers.length > 0}>
      <div data-component="dev-server-offers" role="region" aria-label={t("devServer.region")}>
        <For each={props.offers}>
          {(offer) => (
            <div data-slot="dev-server-offer" role="status">
              <span data-slot="dev-server-offer-text">{t("devServer.found", offer.title, offer.url)}</span>
              <div data-slot="dev-server-offer-actions">
                <button type="button" data-slot="dev-server-offer-open" onClick={() => props.onOpen(offer)}>
                  {t("devServer.open")}
                </button>
                <button type="button" data-slot="dev-server-offer-dismiss" onClick={() => props.onDismiss(offer)}>
                  {t("devServer.dismiss")}
                </button>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
