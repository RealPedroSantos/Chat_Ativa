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
```

Nunca publique `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, senhas ou a pasta
`auth_info_baileys` no GitHub. A sessão do WhatsApp deve ser guardada como
volume persistente ou em armazenamento criptografado.
