# Implantação do Chat Ativa

O sistema possui três partes:

1. **Supabase**: banco PostgreSQL e armazenamento privado de mídias.
2. **Vercel**: painel web e rotas HTTP de curta duração.
3. **Worker WhatsApp permanente**: processo Node.js que mantém a sessão Baileys
   conectada continuamente.

O worker não deve ser executado como uma Vercel Function. Ele mantém uma
conexão WebSocket permanente, executa agendadores e precisa preservar a sessão
do WhatsApp. Use um serviço de processo contínuo (VPS, Railway, Render, Fly.io
ou equivalente) com o comando:

```sh
npm run start:production
```

## Variáveis de ambiente do backend

```text
DATABASE_URL=
SUPABASE_URL=https://bjoxvfqszypvylcadwxd.supabase.co
SUPABASE_SERVICE_ROLE_KEY=
DASHBOARD_PASSWORD=
XAI_API_KEY=
GEMINI_API_KEY=
GROQ_API_KEY=
MISTRAL_API_KEY=
OPENROUTER_API_KEY=
PORT=3000
WHATSAPP_CHANNEL=cloud_api
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_DISPLAY_PHONE_NUMBER=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_GRAPH_API_VERSION=v26.0
WHATSAPP_TENANT_ID=1
CHAT_ATIVA_INTEGRATION_KEY=
CHAT_ATIVA_BACKEND_URL=https://seu-backend.example.com
N8N_WEBHOOK_URL=https://seu-n8n.example.com/webhook/chat-ativa
N8N_WEBHOOK_SECRET=
```

Nunca publique `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, senhas ou a pasta
`auth_info_baileys` no GitHub. A sessão do WhatsApp deve ser guardada como
volume persistente ou em armazenamento criptografado.

## Fluxo oficial

1. A Meta chama `https://chat-ativa.vercel.app/api/integrations/whatsapp/webhook`.
2. A função valida `X-Hub-Signature-256` antes de aceitar o evento.
3. O evento é entregue ao backend Chat Ativa e ao webhook do n8n.
4. O n8n pode responder no próprio webhook ou chamar `/api/integrations/whatsapp/send` com `Authorization: Bearer <CHAT_ATIVA_INTEGRATION_KEY>`.

Faça primeiro um deploy de preview e teste `/api/integrations/status`. Depois promova o mesmo artefato para produção. Os valores secretos devem ser cadastrados diretamente no ambiente da Vercel e nunca enviados ao Git.
