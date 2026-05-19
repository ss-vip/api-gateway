import openai from "./openai.js";

export const SKIP = Symbol("skip");
export const DONE = Symbol("done");

const registry = { openai };

export function getProvider(name) {
  return registry.openai;
}

export function detectProvider(baseUrl) {
  return "openai";
}
