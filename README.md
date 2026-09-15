# Chat Ativa — Atendimento WhatsApp com IA

Sistema de atendimento ao cliente com **WhatsApp, IA, automações n8n e painel web**, desenvolvido para centralizar conversas, permitir atendimento humano e automatizado e manter uma base de conhecimento aprovada pela equipe.

Este repositório faz parte do meu portfólio profissional e demonstra integração entre canais de mensageria, APIs, automação, inteligência artificial, banco local e aplicações web em Node.js.

## Destaques do projeto

- Integração com **WhatsApp Business Platform (Cloud API)**, incluindo webhook e validação de assinatura.
- Canal alternativo via **WhatsApp Web/Baileys** com autenticação por QR Code.
- Integração com **n8n** para automações externas e workflows.
- Painel web para acompanhamento de conversas e configuração do atendimento.
- Pipeline de respostas com regras, respostas rápidas, IA e transferência para atendente humano.
- Base de conhecimento com fluxo de aprovação antes de ser utilizada pela IA.
- Atendimento humano com atribuição, transferência, resolução e notas internas.
- Chat interno entre membros da equipe.
- Importação manual de históricos exportados do WhatsApp.
- Detecção de solicitações importantes como agendamento, cadastro, pedidos e retorno.
- Persistência local com SQLite.
- Suporte a múltiplos provedores de IA.

## Stack

- **Node.js 20+**
- **JavaScript / ES Modules**
- **Express**
- **SQLite / better-sqlite3**
- **WhatsApp Business Platform / Meta Cloud API**
- **Baileys**
- **n8n**
- **OpenAI SDK**
- **Pino**
- **QR Code**
- **Vercel** para endpoints compatíveis com ambiente serverless

## Arquitetura de atendimento

O processamento de mensagens segue uma ordem de prioridade:

1. **Regras** — padrões configuráveis podem responder automaticamente ou transferir para atendimento humano.
2. **Respostas rápidas** — respostas pré-cadastradas disparadas por palavras-chave.
3. **IA** — gera respostas usando o comportamento configurado, informações da empresa, histórico da conversa e conhecimento aprovado.
4. **Atendimento humano** — o bot pode ser pausado por conversa para permitir intervenção manual.

O aprendizado não é aplicado automaticamente: sugestões extraídas das conversas ficam pendentes até aprovação no painel.

## Segurança

- Chaves e tokens não são versionados no repositório.
- `.env`, bancos SQLite, sessões WhatsApp, logs e arquivos locais estão bloqueados pelo `.gitignore`.
- Chaves informadas pelo painel não são devolvidas ao navegador.
- Integrações externas podem usar chave dedicada de autenticação.
- Webhooks oficiais da Meta podem ser validados por assinatura.
- A configuração pública usa apenas `.env.example` sem valores sensíveis.

## Instalação

Requisitos: **Node.js 20 ou superior**.

```bash
git clone https://github.com/RealPedroSantos/Chat_Ativa.git
cd Chat_Ativa
npm install
cp .env.example .env
npm start
```

Depois, abra:

```text
http://localhost:3000
```

Para desenvolvimento com reload automático:

```bash
npm run dev
```

## Variáveis de ambiente

O arquivo `.env.example` documenta as variáveis disponíveis. Entre elas:

```text
XAI_API_KEY
GEMINI_API_KEY
GROQ_API_KEY
MISTRAL_API_KEY
OPENROUTER_API_KEY
WHATSAPP_ACCESS_TOKEN
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_VERIFY_TOKEN
WHATSAPP_APP_SECRET
CHAT_ATIVA_INTEGRATION_KEY
CHAT_ATIVA_BACKEND_URL
N8N_WEBHOOK_URL
N8N_WEBHOOK_SECRET
DASHBOARD_PASSWORD
```

Nenhuma dessas variáveis deve conter valores reais no Git.

## WhatsApp oficial + n8n

A aplicação suporta endpoints para integração entre WhatsApp Cloud API, backend persistente e workflows do n8n.

Principais endpoints:

```text
GET/POST /api/integrations/whatsapp/webhook
POST     /api/integrations/whatsapp/send
POST     /api/integrations/n8n
GET      /api/integrations/status
```

O envio autenticado pode utilizar:

```text
Authorization: Bearer <integration-key>
```

## Provedores de IA

O projeto possui suporte para diferentes provedores configuráveis, incluindo:

- OpenAI-compatible APIs
- Grok/xAI
- Gemini
- Groq
- Mistral
- OpenRouter

As regras e respostas prontas continuam funcionando mesmo sem um provedor externo de IA configurado.

## Estrutura principal

```text
src/
  index.js
  server.js
  whatsapp.js
  whatsapp-cloud.js
  pipeline.js
  ai.js
  learning.js
  db.js
  integration-core.js
  n8n-tenant.js

public/
  painel web

api/
  integrações compatíveis com Vercel

supabase/
  recursos de persistência/integração

test/
  testes automatizados
```

## Deployment

O modo com conexão persistente do WhatsApp precisa de um processo Node.js de longa duração e armazenamento persistente. Pode ser executado em VPS ou serviços como Railway, Render ou Fly.io.

Os endpoints de integração compatíveis com execução serverless podem ser hospedados separadamente, inclusive na Vercel.

## Boas práticas de uso

O canal via Baileys utiliza o protocolo do WhatsApp Web e é indicado principalmente para desenvolvimento e cenários controlados. Para produção, o projeto também oferece integração com a **WhatsApp Business Platform oficial da Meta**, que deve ser preferida respeitando políticas de consentimento, templates e janelas de atendimento.

## Autor

**Pedro Santos — RealPedroSantos**

Projeto desenvolvido como solução de automação de atendimento e integração de sistemas, com foco em mensageria, IA e operações de suporte.

GitHub: https://github.com/RealPedroSantos
