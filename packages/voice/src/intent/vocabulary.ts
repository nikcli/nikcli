/**
 * Static catalog of voice intents for ADE in Italian.
 *
 * This file contains pure declarative intent specifications: trigger phrases,
 * required/optional slots, destructiveness flags, and spoken readback replies.
 */

export type VoiceSlotName = "paneIndex" | "paneTitle" | "text" | "path" | "url" | "columns"

export interface VoiceIntentSpec {
  /** Stable unique identifier for the intent. */
  intent: string
  /** Trigger utterances in Italian, covering imperative, infinitive, and common variations. */
  phrases: string[]
  /** Slot names accepted or extracted by this intent. */
  slots: VoiceSlotName[]
  /** If true, the action requires explicit user confirmation before dispatch. */
  destructive: boolean
  /** Readback reply spoken by the assistant to confirm execution in Italian. */
  readback: string
  /**
   * What the assistant asks before running a destructive intent, in Italian.
   *
   * Written out instead of derived from `readback`: that field is a first-person
   * statement ("Chiudo il pannello") and splicing it into a question produces
   * "confermi di voler chiudo il pannello?". The one moment the assistant must
   * be unmistakable is the moment it asks permission to destroy something.
   */
  confirmPrompt?: string
}

export const VOCABULARY: readonly VoiceIntentSpec[] = [
  // 1. Session and command palette
  {
    intent: "session.new",
    phrases: [
      "nuova sessione",
      "crea nuova sessione",
      "apri nuova sessione",
      "avvia sessione",
      "lancia sessione",
      "nuovo agente",
      "avvia nuovo agente",
      "crea sessione",
    ],
    slots: [],
    destructive: false,
    readback: "Creo una nuova sessione",
  },
  {
    intent: "palette.open",
    phrases: [
      "apri tavolozza",
      "apri la tavolozza",
      "apri palette",
      "mostra comandi",
      "elenco comandi",
      "tavolozza dei comandi",
      "tavolozza",
      "palette",
    ],
    slots: [],
    destructive: false,
    readback: "Apro la tavolozza dei comandi",
  },
  {
    intent: "project.open",
    phrases: [
      "apri progetto",
      "aprire progetto",
      "cambia progetto",
      "apri cartella",
      "seleziona progetto",
      "carica progetto",
    ],
    slots: [],
    destructive: false,
    readback: "Apro la selezione del progetto",
  },
  {
    intent: "project.recent",
    phrases: ["apri progetto recente", "progetto recente", "apri recente", "carica recente"],
    slots: ["path"],
    destructive: false,
    readback: "Apro il progetto recente",
  },

  // 2. Pane operations
  {
    intent: "pane.close",
    phrases: [
      "chiudi pannello",
      "chiudere pannello",
      "chiudi sessione",
      "chiudi la sessione",
      "elimina pannello",
      "chiudi scheda",
    ],
    slots: ["paneIndex", "paneTitle"],
    destructive: true,
    readback: "Chiudo il pannello",
    confirmPrompt: "Chiudo il pannello, va bene?",
  },
  {
    intent: "pane.expand",
    phrases: [
      "espandi pannello",
      "ingrandisci pannello",
      "riduci pannello",
      "schermo intero pannello",
      "massimizza pannello",
      "ripristina dimensione pannello",
    ],
    slots: ["paneIndex", "paneTitle"],
    destructive: false,
    readback: "Modifico la dimensione del pannello",
  },
  {
    intent: "pane.list",
    phrases: [
      "elenca pannelli",
      "elenco pannelli",
      "lista pannelli",
      "quali pannelli ci sono",
      "mostra pannelli",
      "mostra sessioni attive",
      "quali sessioni ci sono",
    ],
    slots: [],
    destructive: false,
    readback: "Ecco i pannelli attivi",
  },
  {
    intent: "pane.focus",
    phrases: [
      "vai al pannello",
      "passa al pannello",
      "seleziona pannello",
      "fuoco su pannello",
      "vai su",
      "passa su",
      "seleziona",
      "pannello",
    ],
    slots: ["paneIndex", "paneTitle"],
    destructive: false,
    readback: "Porto il fuoco sul pannello richiesto",
  },
  {
    intent: "pane.view.set",
    phrases: [
      "mostra trascrizione",
      "mostra diff",
      "passa a trascrizione",
      "passa a diff",
      "vista trascrizione",
      "vista diff",
      "apri diff",
      "apri trascrizione",
    ],
    slots: ["paneIndex", "paneTitle", "text"],
    destructive: false,
    readback: "Imposto la visualizzazione del pannello",
  },

  // 3. Views and layout
  {
    intent: "view.toggle",
    phrases: ["cambia vista", "inverti vista", "alterna vista", "passa ad altra vista"],
    slots: [],
    destructive: false,
    readback: "Cambio la vista del workbench",
  },
  {
    intent: "view.set",
    /*
     * Four sections, and the phrasings that reach each of them. "plancia"
     * stays in the list deliberately: it named the grid for the whole life of
     * the app, and `parse.ts` maps it to `code` rather than leaving someone
     * who says it unheard.
     */
    phrases: [
      "passa ad agent",
      "passa a code",
      "passa a chat",
      "passa agli alberi",
      "passa alla plancia",
      "mostra agent",
      "mostra code",
      "mostra chat",
      "mostra alberi",
      "vai ad agent",
      "vai a code",
      "vai a chat",
      "vai agli alberi",
      "apri la chat",
      "apri i terminali",
      "imposta vista agent",
      "imposta vista code",
      "imposta vista chat",
      "imposta vista alberi",
    ],
    slots: ["text"],
    destructive: false,
    readback: "Imposto la vista richiesta",
  },
  {
    intent: "grid.columns.set",
    phrases: [
      "imposta colonne",
      "metti colonne",
      "disponi a colonne",
      "disponi su colonne",
      "numero colonne",
      "colonne",
    ],
    slots: ["columns"],
    destructive: false,
    readback: "Dispongo la griglia sulle colonne richieste",
  },
  {
    intent: "theme.toggle",
    phrases: [
      "cambia tema",
      "tema chiaro",
      "tema scuro",
      "inverti tema",
      "alterna tema",
      "modalita scura",
      "modalita chiara",
    ],
    slots: [],
    destructive: false,
    readback: "Cambio il tema visivo",
  },

  // 4. Browser, process, git worktrees
  {
    intent: "browser.new",
    phrases: [
      "apri browser",
      "aprire il browser",
      "apri il browser",
      "nuovo browser",
      "anteprima browser",
      "apri anteprima",
      "browser",
    ],
    slots: [],
    destructive: false,
    readback: "Apro un nuovo pannello browser",
  },
  /*
   * The other panels of the «+» menu. The agent behind the voice cannot open
   * a panel — it has no tool for it, and an `@ade` line in its answer is read
   * aloud, not run — so without these, «apri il simulatore» had no way in.
   */
  {
    intent: "video.new",
    phrases: ["apri il video", "apri un video", "nuovo video", "apri il lettore video", "mostra un video"],
    slots: [],
    destructive: false,
    readback: "Apro il pannello video",
  },
  {
    intent: "model.new",
    phrases: [
      "apri il modello 3d",
      "nuovo modello 3d",
      "apri il visore 3d",
      "mostra il modello 3d",
      "apri un modello 3d",
    ],
    slots: [],
    destructive: false,
    readback: "Apro il pannello del modello 3D",
  },
  {
    intent: "app.new",
    phrases: [
      "apri il simulatore",
      "apri il simulatore app",
      "nuovo simulatore",
      "apri l'emulatore",
      "apri il telefono simulato",
    ],
    slots: [],
    destructive: false,
    readback: "Apro il simulatore",
  },
  {
    intent: "decisions.open",
    phrases: [
      "apri le decisioni",
      "mostra le decisioni",
      "decisioni da prendere",
      "cosa devo decidere",
      "apri la finestra delle decisioni",
    ],
    slots: [],
    destructive: false,
    readback: "Apro le decisioni",
  },
  {
    intent: "browser.navigate",
    phrases: ["vai all'indirizzo", "naviga a", "apri indirizzo", "apri url", "vai al sito", "naviga su"],
    slots: ["paneIndex", "paneTitle", "url"],
    destructive: false,
    readback: "Navigo all'indirizzo nel browser",
  },
  {
    intent: "process.kill",
    phrases: [
      "uccidi processo",
      "termina processo",
      "ferma processo",
      "interrompi processo",
      "stop processo",
      "arresta processo",
      "blocca processo",
    ],
    slots: ["paneIndex", "paneTitle"],
    destructive: true,
    readback: "Termino il processo attivo",
    confirmPrompt: "Fermo il processo, va bene?",
  },

  // 5. Files, search, prompt, transcript scroll
  {
    intent: "file.open",
    phrases: ["apri file", "aprire file", "mostra file", "modifica file", "visualizza file"],
    slots: ["path"],
    destructive: false,
    readback: "Apro il file specificato",
  },
  {
    intent: "project.search",
    phrases: ["cerca nel progetto", "trova nel progetto", "cerca file", "ricerca nel progetto", "trova simbolo"],
    slots: ["text"],
    destructive: false,
    readback: "Eseguo la ricerca nel progetto",
  },
  {
    intent: "prompt.send",
    phrases: [
      "invia prompt",
      "invia messaggio",
      "detta compito",
      "invia all'agente",
      "scrivi al pannello",
      "manda compito",
      "invia istruzione",
    ],
    slots: ["paneIndex", "paneTitle", "text"],
    destructive: false,
    readback: "Invio l'istruzione all'agente",
  },
  {
    intent: "transcript.scroll",
    phrases: [
      "scorri trascrizione",
      "scorri in alto",
      "scorri in basso",
      "scorri su",
      "scorri giu",
      "vai in alto",
      "vai in basso",
    ],
    slots: ["paneIndex", "paneTitle", "text"],
    destructive: false,
    readback: "Scorro la trascrizione",
  },

  // 6. Permissions
  {
    intent: "permission.allow",
    phrases: [
      "consenti permesso",
      "concedi permesso",
      "autorizza",
      "permetti azione",
      "approva richiesta",
      "consenti azione",
      "consenti",
    ],
    slots: ["paneIndex", "paneTitle"],
    destructive: false,
    readback: "Permesso accordato",
  },
  {
    intent: "permission.deny",
    phrases: ["nega permesso", "rifiuta permesso", "blocca azione", "nega richiesta", "rifiuta richiesta", "nega"],
    slots: ["paneIndex", "paneTitle"],
    destructive: true,
    readback: "Permesso negato",
    confirmPrompt: "Nego il permesso all'agente, va bene?",
  },

  // 7. System state and assistance
  {
    intent: "state.describe",
    phrases: [
      "cosa sta succedendo",
      "a che punto siamo",
      "quante sessioni ci sono",
      "stato attuale",
      "situazione corrente",
      "descrivi stato",
      "cosa succede",
    ],
    slots: [],
    destructive: false,
    readback: "Ecco la situazione attuale",
  },
  {
    intent: "help.list",
    phrases: [
      "cosa posso dire",
      "aiuto",
      "quali sono i comandi",
      "comandi vocali",
      "cosa puoi fare",
      "istruzioni vocali",
    ],
    slots: [],
    destructive: false,
    readback: "Ecco cosa puoi chiedermi con la voce",
  },

  // 8. Listening and dictation controls
  {
    intent: "voice.sleep",
    phrases: ["vai a dormire", "sospendi ascolto", "silenzio", "riposa", "stop ascolto", "disattiva voce"],
    slots: [],
    destructive: false,
    readback: "Vado a dormire",
  },
  {
    intent: "voice.wake",
    phrases: ["svegliati", "ascolta", "ehi ade", "torna attivo", "riprendi ascolto", "attiva voce"],
    slots: [],
    destructive: false,
    readback: "Sono sveglio e in ascolto",
  },
  {
    intent: "dictation.start",
    phrases: ["inizia dettatura", "avvia dettatura", "comincia a dettare", "modalita dettatura", "detta"],
    slots: ["paneIndex", "paneTitle"],
    destructive: false,
    readback: "Dettatura avviata. Parla liberamente, di' fine dettatura o invia per terminare.",
  },
  {
    intent: "dictation.finish",
    phrases: ["fine dettatura", "termina dettatura", "invia dettatura", "concludi dettatura", "invia"],
    slots: [],
    destructive: false,
    readback: "Dettatura completata e inviata all'agente",
  },

  // 9. Dialog confirmations and controls
  {
    intent: "dialog.confirm",
    phrases: ["si", "conferma", "confermo", "procedi", "va bene", "esegui"],
    slots: [],
    destructive: false,
    readback: "Confermato",
  },
  {
    intent: "dialog.cancel",
    phrases: ["no", "annulla", "lascia stare", "fermati", "annulla tutto", "lascia"],
    slots: [],
    destructive: false,
    readback: "Annullato",
  },
  {
    intent: "dialog.repeat",
    phrases: ["ripeti", "cosa hai detto", "puoi ripetere", "non ho capito", "ripeti messaggio"],
    slots: [],
    destructive: false,
    readback: "Ripeto l'ultimo messaggio",
  },
]
