import openai from "./openai.js";
import google from "./google.js";
import anthropic from "./anthropic.js";

export const SKIP = Symbol("skip");
export const DONE = Symbol("done");

const registry = { openai, google, anthropic };

export function getProvider(name) {
  return registry[name] || registry.openai;
}

export function getProviderNames() {
  return Object.keys(registry);
}

export const PROVIDER_INFO = {
  openai: { label: "OpenAI 相容", supportsTools: true, supportsVision: true, supportsEmbeddings: true, supportsStreaming: true },
  google: { label: "Google Gemini (原生)", supportsTools: true, supportsVision: true, supportsEmbeddings: false, supportsStreaming: true },
  anthropic: { label: "Anthropic Claude", supportsTools: true, supportsVision: true, supportsEmbeddings: false, supportsStreaming: true },
};

export const KNOWN_OPENAI_COMPAT = [
  "openrouter", "ollama", "deepseek", "together", "fireworks",
  "groq", "perplexity", "mistral", "xai", "github",
  "literouter", "nvidia", "moonshot", "yi", "baichuan",
  "zhipu", "minimax", "stepfun", "inflection",
];

const HOST_RULES = [
  { pattern: "googleapis.com", provider: "google" },
  { pattern: "generativelanguage", provider: "google" },
  { pattern: "api.anthropic.com", provider: "anthropic" },
  { pattern: "api.claude.ai", provider: "anthropic" },
  { pattern: "openai.azure.com", provider: "openai" },
  { pattern: "azure.com/openai", provider: "openai" },
  { pattern: "openrouter.ai", provider: "openai" },
  { pattern: "api.together.xyz", provider: "openai" },
  { pattern: "api.fireworks.ai", provider: "openai" },
  { pattern: "api.groq.com", provider: "openai" },
  { pattern: "api.perplexity.ai", provider: "openai" },
  { pattern: "api.mistral.ai", provider: "openai" },
  { pattern: "api.x.ai", provider: "openai" },
  { pattern: "api.deepseek.com", provider: "openai" },
  { pattern: "api.moonshot.cn", provider: "openai" },
  { pattern: "api.lingyiwanwu.com", provider: "openai" },
  { pattern: "api.baichuan-ai.com", provider: "openai" },
  { pattern: "open.bigmodel.cn", provider: "openai" },
  { pattern: "api.minimax.chat", provider: "openai" },
  { pattern: "api.stepfun.com", provider: "openai" },
  { pattern: "api.nvidia.com", provider: "openai" },
  { pattern: "ollama", provider: "openai" },
  { pattern: "models.inference.ai.azure.com", provider: "openai" },
];

export function detectProvider(baseUrl) {
  if (!baseUrl) return "openai";
  const lower = baseUrl.toLowerCase();
  if (lower.includes("/openai")) return "openai";
  for (const rule of HOST_RULES) {
    if (lower.includes(rule.pattern)) return rule.provider;
  }
  return "openai";
}

export function isOpenAIStreamFormat(providerName) {
  return providerName === "openai";
}
