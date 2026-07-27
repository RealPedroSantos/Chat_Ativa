import 'dotenv/config'
import { createServer } from './server.js'
import { startAllWhatsApps } from './whatsapp.js'
import { startLearningScheduler } from './learning.js'
import { aiConfigured } from './ai.js'
import { countUsers, listTenants } from './db.js'
import { runWithTenant } from './tenant-context.js'
import { syncPromptKnowledge } from './prompt-knowledge.js'

import { startInactivityScheduler } from './inactivity.js'
import { startUnansweredAlertScheduler } from './unanswered-alerts.js'

const PORT = Number(process.env.PORT || 3000)

for (const tenant of listTenants().filter((item) => item.active)) {
  try {
    runWithTenant(tenant.id, () => syncPromptKnowledge())
  } catch (err) {
    console.error(`[knowledge:${tenant.id}] não foi possível sincronizar o prompt:`, err.message)
  }
}

const app = createServer()
app.listen(PORT, () => {
  console.log(`\n🤖 Robo de Atendimento`)
  console.log(`   Painel: http://localhost:${PORT}`)
  if (countUsers() === 0) console.log('   Primeiro acesso: crie o usuário Super Master no painel')
  if (!aiConfigured()) {
    console.log('   ⚠️  Chave da API xAI não configurada — configure-a no painel ou selecione a IA interna (sem custo de API) em Configuração')
  }
})

startAllWhatsApps()
startLearningScheduler()
startInactivityScheduler()
startUnansweredAlertScheduler()
