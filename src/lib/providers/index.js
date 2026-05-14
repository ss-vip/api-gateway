import openai from "./openai.js";
import google from "./google.js";

export const SKIP = Symbol("skip");
export const DONE = Symbol("done");

const registry = { openai, google };

export function getProvider(name) {
  return registry[name] || registry.openai;
}

export function getProviderNames() {
  return Object.keys(registry);
}

const HOST_RULES = [
  { pattern: "googleapis.com", provider: "google" },
  { pattern: "generativelanguage", provider: "google" },
];

export function detectProvider(baseUrl) {
  if (!baseUrl) return "openai";
  const lower = baseUrl.toLowerCase();
  // OpenAI-compatible endpoints (e.g. Google's /v1beta/openai)
  if (lower.includes("/openai")) return "openai";
  for (const rule of HOST_RULES) {
    if (lower.includes(rule.pattern)) return rule.provider;
  }
  return "openai";
}
