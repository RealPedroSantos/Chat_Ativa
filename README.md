# 🤖 Robô de Atendimento — WhatsApp AI Customer Service Bot

A self-hosted WhatsApp customer-service bot with a web dashboard. Connect by scanning a QR code (WhatsApp Web protocol), configure the assistant's behavior, and let it answer customers automatically — with rules, canned responses, and AI replies that **learn from real conversations over time** (with your approval).

## Features

- **QR code login** — connects through the WhatsApp Web protocol ([Baileys](https://github.com/WhiskeySockets/Baileys)); scan the code from the dashboard.
- **Web dashboard** (pt-BR) — connection status, live conversations, configuration, canned responses, rules, and knowledge base.
- **Reply pipeline** (in priority order):
  1. **Rules** — pattern matching (contains / exact / starts with / regex) that can reply or **pause the bot** and hand off to a human.
  2. **Canned responses** — keyword-triggered ready-made answers.
  3. **AI (Internal, Grok, Gemini, Groq, Mistral, or OpenRouter)** — answers using your behavior prompt, business info, conversation history, and the approved knowledge base. Never invents facts (guardrails baked in).
- **Learning loop** — hourly (and on demand), the selected AI reviews recent conversations and extracts generalizable Q&A pairs. They land as **pending** knowledge; the AI only uses them after you approve them in the dashboard.
- **Human takeover** — pause the bot per conversation and reply manually from the dashboard.
- **Auditable service cycles** — attendant identification, assignment, transfer and resolution events while the customer's permanent message history is preserved.
- **Shared internal notes** — the whole team can coordinate privately inside each customer conversation.
- **Internal team chat** — direct messaging between attendants and administrators with text, emoji, audio, GIFs, stickers and files.
- **Manual history import** — import a WhatsApp-exported `.txt` conversation when the initial device sync does not provide older messages.
- **Operational sounds** — distinct supplied sounds for received, sent and customer messages awaiting a response for five minutes.
- **Smart notes** — automatically detects scheduling, registration, order, callback, and human-attendance requests; groups follow-up details and shows the customer's name and phone in a dedicated dashboard area.
- **Configurable limits** — the behavior prompt you write is always enforced alongside fixed guardrails (no topic drift, no invented prices/policies, no prompt disclosure).

## Setup

Requirements: Node.js 20+.

```bash
npm install
cp .env.example .env
# edit .env:
#   DASHBOARD_PASSWORD=choose-a-password
npm start
```

Open **http://localhost:3000**, choose an AI provider and add its key under **Configuração → API da inteligência artificial**, then go to **Conexão** and scan the QR code with WhatsApp (phone → Aparelhos conectados → Conectar aparelho).

Keys entered in the dashboard are stored locally in the SQLite database and are never returned to the browser. `XAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, and `OPENROUTER_API_KEY` are supported as environment-variable fallbacks. Without a key for the selected external provider, rules and canned responses still work — only external AI replies are disabled.

## Configuration tips

- **Configuração → API da inteligência artificial**: choose the provider and add or replace its API key without editing server files.
- **Configuração → Prompt de comportamento**: the assistant's persona, tone, and limits.
- **Configuração → Informações do negócio**: hours, address, prices, policies — the AI only states facts found here or in the approved knowledge base.
- **Regras**: the seeded example transfers to a human when the customer asks for "atendente/humano". Rules always win over canned responses and AI.
- **Conhecimento**: approve/reject what the bot learned; add entries manually too.

## Deployment

This app needs a **long-running Node.js process** (persistent WebSocket to WhatsApp + local SQLite/session files), so serverless platforms (e.g. Vercel functions) won't work. Good options:

- A VPS (any $5 box) with `pm2` or a systemd service
- Railway / Render / Fly.io (persistent service + volume for the `data/` directory)

Keep the `data/` directory persistent — it holds the WhatsApp session (so you don't re-scan the QR) and the SQLite database.

## ⚠️ Important notice

This bot uses the unofficial WhatsApp Web protocol. WhatsApp's terms of service prohibit automated/bulk messaging, and numbers can be **banned** for abuse. Use a dedicated number, reply only to customers who message you first, and avoid mass sending. For mission-critical operations consider the official WhatsApp Business Platform (Cloud API) — it doesn't use QR login but is ToS-safe.

## Project structure

```
src/
  index.js      # entry point (server + WhatsApp + learning scheduler)
  whatsapp.js   # Baileys connection, QR code, send/receive
  pipeline.js   # message pipeline: rules → canned → AI
  ai.js         # External AI APIs: replies + knowledge extraction
  learning.js   # scheduled learning from conversations
  server.js     # Express API + SSE for the dashboard
  db.js         # SQLite schema and queries
public/         # dashboard (HTML/CSS/JS)
data/           # WhatsApp session + SQLite DB (gitignored)
```
