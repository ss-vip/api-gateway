// ============================================================
// Provider Registry
// Maps provider name → adapter module
// ============================================================
import openai from "./openai.js";
import google from "./google.js";

// Shared sentinel symbols for stream processing
export const SKIP = Symbol("skip");
export const DONE = Symbol("done");

const registry = {
  openai,
  google,
};

export function getProvider(name) {
  return registry[name] || registry.openai;
}

export function getProviderNames() {
  return Object.keys(registry);
}

export default registry;
