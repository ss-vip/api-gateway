const ENDPOINT_PATHS = {
  chat: "/v1/chat/completions",
  image_gen: "/v1/images/generations",
  image_edit: "/v1/images/edits",
  audio_stt: "/v1/audio/transcriptions",
  audio_tts: "/v1/audio/speech",
};

export function buildUrl(baseUrl, _model, _isStream) {
  let base = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) return null;
  if (base.endsWith("/chat/completions")) return base;
  if (/\/v[\w]+\//.test(base + "/")) return `${base}/chat/completions`;
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

export function buildEndpointUrl(baseUrl, endpointType) {
  let base = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) return null;
  const suffix = ENDPOINT_PATHS[endpointType];
  if (!suffix) return null;
  if (base.endsWith(suffix)) return base;
  const stripped = base.replace(/\/(?:v[\w]+\/)?(?:chat\/completions|images\/generations|images\/edits|audio\/speech|audio\/transcriptions)$/, "");
  if (stripped !== base) return stripped + suffix;
  const cleanSuffix = suffix.replace(/^\/v[\w]+/, "");
  if (/\/v[\w]+\//.test(base + "/")) return `${base}${cleanSuffix}`;
  if (/\/v\d+$/.test(base)) return `${base}/${cleanSuffix}`;
  return `${base}${suffix}`;
}
