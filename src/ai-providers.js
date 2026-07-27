export const AI_PROVIDERS = {
  grok: {
    name: 'Grok',
    baseURL: 'https://api.x.ai/v1',
    apiKeySetting: 'xai_api_key',
    environmentKey: 'XAI_API_KEY',
    defaultModel: 'grok-4.5',
  },
  gemini: {
    name: 'Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKeySetting: 'gemini_api_key',
    environmentKey: 'GEMINI_API_KEY',
    defaultModel: 'gemini-3.6-flash',
  },
  groq: {
    name: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    apiKeySetting: 'groq_api_key',
    environmentKey: 'GROQ_API_KEY',
    defaultModel: 'openai/gpt-oss-120b',
  },
  mistral: {
    name: 'Mistral',
    baseURL: 'https://api.mistral.ai/v1',
    apiKeySetting: 'mistral_api_key',
    environmentKey: 'MISTRAL_API_KEY',
    defaultModel: 'mistral-small-latest',
  },
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeySetting: 'openrouter_api_key',
    environmentKey: 'OPENROUTER_API_KEY',
    defaultModel: 'openrouter/free',
  },
}

export const EXTERNAL_AI_PROVIDERS = Object.keys(AI_PROVIDERS)

export function aiProvider(provider) {
  return AI_PROVIDERS[provider] || AI_PROVIDERS.grok
}
