# Guida Completa: Installare nikcli su Slack

Questa guida ti accompagnerà passo dopo passo per collegare nikcli al tuo workspace Slack.

---

## Prerequisiti

Prima di iniziare, assicurati di avere:

- Un account [Cloudflare](https://cloudflare.com/) (gratuito)
- [Bun](https://bun.sh/) 1.1+ installato
- Un workspace Slack dove puoi creare app
- Un server nikcli in esecuzione (o pronto da avviare)

---

## Indice

1. [Creare la Slack App](#1-creare-la-slack-app)
2. [Configurare il Server nikcli](#2-configurare-il-server-nikcli)
3. [Esponi il Server a Internet](#3-esponi-il-server-a-internet)
4. [Deploy del Worker su Cloudflare](#4-deploy-del-worker-su-cloudflare)
5. [Collegare il Worker a Slack](#5-collegare-il-worker-a-slack)
6. [Testare l'Integrazione](#6-testare-lintegrazione)
7. [Risoluzione Problemi](#7-risoluzione-problemi)

---

## 1. Creare la Slack App

### 1.1 Accedi a Slack API

1. Apri [api.slack.com/apps](https://api.slack.com/apps)
2. Clicca **"Create New App"**
3. Seleziona **"From an app manifest"**

### 1.2 Seleziona il Workspace

1. Scegli il workspace Slack dove vuoi installare nikcli
2. Clicca **"Next"**

### 1.3 Inserisci il Manifest

Copia e incolla questo manifest YAML:

```yaml
_metadata:
  major_version: 1
  minor_version: 1
display_information:
  name: nikcli
  description: AI coding assistant for Slack
  background_color: "#1a1a2e"
features:
  bot_user:
    display_name: nikcli
    always_online: true
  assistant_view:
    assistant_description: AI coding assistant
    suggested_prompts: []
  slash_commands:
    - command: /nikcli-tools
      description: Manage per-channel tool policy (admins)
      usage_hint: "[list | allow <tool> | deny <tool> | reset]"
      should_escape: false
  event_subscriptions:
    enabled: true
    request_url: https://slack.nikcli.store/slack/events
  interactivity:
    enabled: true
    request_url: https://slack.nikcli.store/slack/interactive
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - assistant:write
      - chat:write
      - commands
      - channels:history
      - groups:history
      - im:history
      - mpim:history
      - files:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - assistant_thread_started
      - assistant_thread_context_changed
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    placeholder_text: Ask nikcli...
  org_deploy_enabled: false
  socket_mode_enabled: false
```

> **Nota:** L'URL `https://slack.nikcli.store` sarà disponibile dopo il deployment.
>
> **Socket Mode (consigliato, `bun run dev`):** imposta `socket_mode_enabled: true`,
> rimuovi i due `request_url`, e in **Basic Information → App-Level Tokens** crea un
> token con scope `connections:write` (è il tuo `SLACK_APP_TOKEN`, `xapp-…`).
>
> **AI Assistant panel:** dopo aver incollato il manifest, abilita anche
> **Features → Agents & AI Apps** (Agent/Assistant) per far comparire il pannello laterale.
> Lo scope `assistant:write` e gli eventi `assistant_thread_*` sono già nel manifest.

### 1.4 Clicca **"Next"** poi **"Create"**

### 1.5 Installa l'App

1. Nel menu di sinistra, vai su **"Install app"**
2. Clicca **"Install to Workspace"**
3. Concedi i permessi richiesti

### 1.6 Salva le Credenziali

Dopo l'installazione, avrai accesso a:

| Credenziale        | Dove trovarla                                             |
| ------------------ | --------------------------------------------------------- |
| **Bot Token**      | Install app → "Bot User OAuth Token" (inizia con `xoxb-`) |
| **Signing Secret** | Basic Information → App Credentials → "Signing Secret"    |

**Importante:** Salva queste credenziali in un luogo sicuro!

---

## 2. Configurare il Server nikcli

### 2.1 Crea il File di Configurazione

Crea o modifica `~/.config/nikcli/nikcli.jsonc` (oppure `nikcli.json`/`config.json` nella stessa cartella):

```json
{
  "$schema": "https://nikcli.store/config.json",
  "server": {
    "port": 4096,
    "hostname": "0.0.0.0",
    "mdns": true,
    "cors": ["https://*.slack.com", "https://api.slack.com"]
  },
  "share": "manual",
  "compaction": {
    "auto": true,
    "prune": true
  }
}
```

### 2.2 Imposta le Variabili d'Ambiente

```bash
# Nel tuo terminale
export NIKCLI_SERVER_PASSWORD="una-password-sicura-qui"
# Facoltativo: se omesso, il default è "nikcli"
export NIKCLI_SERVER_USERNAME="slackbot"
```

### 2.3 Avvia il Server

```bash
# Avvia nikcli in modalità server
nikcli serve --port 4096 --hostname 0.0.0.0 --mdns
```

Dovresti vedere un output simile:

```
✓ Server avviato su http://localhost:4096
✓ Server disponibile su rete locale
✓ mDNS pubblicato come nikcli-4096.local
```

**Lascia questo terminale aperto!**

---

## 3. Esponi il Server a Internet

Il worker Cloudflare deve poter raggiungere il tuo server nikcli. Usa cloudflared:

### 3.1 Installa cloudflared

**macOS:**

```bash
brew install cloudflare/cloudflare/cloudflared
```

**Altre piattaforme:** Scarica da [cloudflare.com](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation)

### 3.2 Avvia il Tunnel

Apri un **nuovo terminale** ed esegui:

```bash
cloudflared tunnel --url http://localhost:4096
```

Dopo pochi secondi, vedrai:

```
2024-01-01T00:00:00Z INF Starting tunnel
...
2024-01-01T00:00:00Z INF Tunnel credentials...
2024-01-01T00:00:00Z INF Proxy tunnel now available
2024-01-01T00:00:00Z INF https://random-name.trycloudflare.com
```

**Copia questo URL!** Sarà il tuo `NIKCLI_URL`.

### 3.3 Aggiorna i Secrets

```bash
bunx wrangler secret put NIKCLI_URL --name nikcli-slack
# Inserisci: https://random-name.trycloudflare.com

bunx wrangler secret put NIKCLI_PASSWORD --name nikcli-slack
# Inserisci: la tua password del server

bunx wrangler secret put NIKCLI_USERNAME --name nikcli-slack
# Inserisci: slackbot (o il tuo username). Se non l'hai impostato sul server, puoi ometterlo.
```

---

## 4. Deploy del Worker su Cloudflare

### 4.1 Accedi a Wrangler

Se non sei già loggato:

```bash
bunx wrangler login
```

Questo aprirà il browser per l'autenticazione.

### 4.2 Crea il KV Namespace (SESSIONS)

Il worker usa KV per salvare le sessioni Slack. Crea il namespace e aggiorna `wrangler.toml` con gli ID:

```bash
bunx wrangler kv:namespace create "SESSIONS" --preview=false
```

Copia l'`id` restituito e mettilo in `packages/slack/wrangler.toml` sotto `[[kv_namespaces]]` (sia `id` che `preview_id`).

### 4.3 Verifica i Secrets

```bash
bunx wrangler secret list --name nikcli-slack
```

Dovresti vedere:

```
SLACK_BOT_TOKEN
SLACK_SIGNING_SECRET
SLACK_CLIENT_ID
SLACK_CLIENT_SECRET
NIKCLI_URL
NIKCLI_USERNAME
NIKCLI_PASSWORD
OPENAI_API_KEY
```

Se manca qualcosa, aggiungilo con `wrangler secret put`.

### 4.4 Deploy

```bash
cd packages/slack

# Deploy con dominio personalizzato
bunx wrangler deploy src/worker.ts --name nikcli-slack --routes 'slack.nikcli.store/*'
```

Output atteso:

```
✓ Worker uploaded successfully
✓ Deployed nikcli-slack triggers
  https://slack.nikcli.store/*
```

### 4.5 Verifica il Deployment

```bash
curl https://slack.nikcli.store/health
```

Risposta:

```json
{ "status": "healthy", "timestamp": 1234567890, "nikcliUrl": "https://..." }
```

---

## 5. Collegare il Worker a Slack

### 5.1 Aggiorna gli URLs nell'App Slack

Torna su [api.slack.com/apps](https://api.slack.com/apps):

1. **Event Subscriptions:**
   - Vai su "Event Subscriptions"
   - Abilita "Enable Events"
   - Inserisci: `https://slack.nikcli.store/slack/events`
   - Clicca "Save Changes"

2. **Interactivity:**
   - Vai su "Interactivity & Shortcuts"
   - Abilita "Interactivity"
   - Inserisci: `https://slack.nikcli.store/slack/interactive`
   - Clicca "Save Changes"

### 5.2 Reinstalla l'App

Dopo aver cambiato gli URLs, l'app deve essere reinstallata:

1. Vai su "Install app" nel menu di sinistra
2. Clicca **"Reinstall to Workspace"**
3. Concedi i permessi

### 5.3 Aggiungi il Bot al Canale

1. Apri Slack
2. Vai nel canale dove vuoi usare nikcli
3. Scrivi: `/invite @nikcli`

---

## 6. Testare l'Integrazione

### 6.1 Verifica i Log

```bash
bunx wrangler tail --name nikcli-slack
```

### 6.2 Primo Messaggio

In un canale dove hai invitato nikcli, scrivi:

```
@nikcli Ciao! Come funzioni?
```

Dovresti vedere una risposta e un link alla sessione nikcli.

### 6.3 Test Voice (se hai configurato OPENAI_API_KEY)

Invia un messaggio vocale nel canale. nikcli dovrebbe:

1. Scaricare l'audio
2. Trascriverlo con Whisper
3. Rispondere al contenuto

---

## 7. Risoluzione Problemi

### Il worker non riceve eventi

**Sintomo:** Nessuna risposta da nikcli

**Soluzioni:**

1. Verifica che Event Subscriptions sia abilitato
2. Controlla che l'URL sia `https://slack.nikcli.store/slack/events`
3. Reinstalla l'app dopo aver modificato gli scopes
4. Controlla i log: `bunx wrangler tail --name nikcli-slack`

### 401 Unauthorized

**Sintomo:** Errori "Unauthorized" nei log

**Soluzioni:**

1. Verifica `NIKCLI_USERNAME` e `NIKCLI_PASSWORD`
2. Assicurati che le password coincidano con quelle del server
3. Il server nikcli deve essere in esecuzione
4. Se non hai impostato `NIKCLI_SERVER_USERNAME`, usa il default `nikcli`

### Le sessioni non si salvano

**Sintomo:** Ogni messaggio crea una nuova sessione

**Soluzioni:**

1. Verifica che il KV namespace sia configurato:
   ```bash
   bunx wrangler kv:namespace list
   ```
2. Controlla i log per errori KV

### Voice transcription non funziona

**Sintomo:** I messaggi vocali non vengono trascritti

**Soluzioni:**

1. Verifica che `OPENAI_API_KEY` sia impostato:
   ```bash
   bunx wrangler secret list --name nikcli-slack
   ```
2. Controlla che l'audio sia in formato supportato (mp3, ogg, wav, m4a)

### Il dominio non funziona

**Sintomo:** `slack.nikcli.store` non risponde

**Soluzioni:**

1. Verifica la configurazione DNS su Cloudflare
2. Controlla che il route sia corretto in `wrangler.toml` (es. `slack.nikcli.store/*`)
3. Prova l'URL diretto: `https://slack.nikcli.store/health`

---

## Comandi Quick Reference

```bash
# Avviare il server nikcli
nikcli serve --port 4096 --hostname 0.0.0.0 --mdns

# Avviare il tunnel cloudflared (nuovo terminale)
cloudflared tunnel --url http://localhost:4096

# Vedere i log del worker
bunx wrangler tail --name nikcli-slack

# Creare KV namespace
bunx wrangler kv:namespace create "SESSIONS" --preview=false

# Aggiornare un secret
bunx wrangler secret put NIKCLI_URL --name nikcli-slack

# Redeploy del worker
cd packages/slack && bunx wrangler deploy src/worker.ts --name nikcli-slack --routes 'slack.nikcli.store/*'

# Verificare health
curl https://slack.nikcli.store/health

# Lista secrets
bunx wrangler secret list --name nikcli-slack
```

---

## Struttura del Progetto

```
packages/slack/
├── src/
│   ├── index.ts      # Socket Mode (locale)
│   └── worker.ts     # Cloudflare Workers
├── wrangler.toml     # Configurazione Workers
├── Dockerfile        # Container Docker
└── README.md         # Questa guida
```

---

## Supporto

Se hai problemi:

1. Controlla i log: `bunx wrangler tail --name nikcli-slack`
2. Verifica i passaggi in questa guida
3. Apri una [Issue su GitHub](https://github.com/nikcli/nikcli/issues)

---

**Buon coding con nikcli su Slack! 🚀**
