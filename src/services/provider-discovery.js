function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeNumber(value) {
  const parsed = Number.parseFloat(value ?? "NaN");
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function isFreePricing(pricing = {}) {
  const prompt = safeNumber(pricing.prompt);
  const completion = safeNumber(pricing.completion);
  const request = safeNumber(pricing.request);

  return [prompt, completion, request].every((value) => !Number.isNaN(value) && value === 0);
}

function supportsTextOutput(model) {
  const modalities = model?.architecture?.output_modalities;
  return Array.isArray(modalities) ? modalities.includes("text") : true;
}

function supportsTools(model) {
  return Array.isArray(model?.supported_parameters) ? model.supported_parameters.includes("tools") : false;
}

function contextLength(model) {
  return (
    model?.top_provider?.context_length ??
    model?.context_length ??
    model?.architecture?.context_length ??
    null
  );
}

function normalizeDescription(model) {
  return normalizeText(model?.description).replace(/\s+/g, " ");
}

export function detectApiProvider(apiKey) {
  const key = normalizeText(apiKey);

  if (!key) {
    return "unknown";
  }

  if (key.startsWith("sk-or-v1-")) {
    return "openrouter";
  }

  if (key.startsWith("AIza")) {
    return "gemini";
  }

  if (key.startsWith("sk-proj-") || key.startsWith("sk-")) {
    return "openai";
  }

  return "unknown";
}

function scoreCodingModel(model) {
  const id = normalizeText(model.id).toLowerCase();
  const name = normalizeText(model.name).toLowerCase();
  const description = normalizeDescription(model).toLowerCase();
  const text = `${id} ${name} ${description}`;

  let score = 0;
  if (text.includes("code")) {
    score += 4;
  }
  if (text.includes("program")) {
    score += 3;
  }
  if (text.includes("developer")) {
    score += 2;
  }
  if (text.includes("agent")) {
    score += 1;
  }
  if (supportsTools(model)) {
    score += 4;
  }
  if (isFreePricing(model.pricing)) {
    score += 5;
  }
  score += Math.min(Math.floor((contextLength(model) || 0) / 32000), 4);
  return score;
}

function normalizeModel(model) {
  return {
    id: model.id,
    name: model.name || model.id,
    description: normalizeDescription(model),
    contextLength: contextLength(model),
    supportsTools: supportsTools(model),
    pricing: model.pricing || {},
    isFree: isFreePricing(model.pricing)
  };
}

function filterCodingCapableModels(models) {
  return models
    .filter((model) => normalizeText(model.id))
    .filter((model) => supportsTextOutput(model))
    .filter((model) => isFreePricing(model.pricing))
    .filter((model) => supportsTools(model))
    .sort((left, right) => scoreCodingModel(right) - scoreCodingModel(left))
    .map(normalizeModel);
}

async function fetchOpenRouterModels(apiKey, params, fetchImpl) {
  const url = new URL("https://openrouter.ai/api/v1/models");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "ASTHRA V4"
    }
  });

  const rawText = await response.text();
  let payload;
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    payload = { rawText };
  }

  if (!response.ok) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      payload?.detail ||
      rawText ||
      `OpenRouter model lookup failed with status ${response.status}`;
    throw new Error(message);
  }

  return Array.isArray(payload?.data) ? payload.data : [];
}

export async function discoverOpenRouterCodingModels(apiKey, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const programmingModels = await fetchOpenRouterModels(
    apiKey,
    {
      category: "programming"
    },
    fetchImpl
  );

  let models = filterCodingCapableModels(programmingModels);

  if (models.length === 0) {
    const fallbackModels = await fetchOpenRouterModels(
      apiKey,
      {
        supported_parameters: "tools"
      },
      fetchImpl
    );

    models = filterCodingCapableModels(fallbackModels);
  }

  return models;
}

export async function inspectApiKey(apiKey, options = {}) {
  const provider = detectApiProvider(apiKey);

  if (provider !== "openrouter") {
    return {
      provider,
      availableModels: [],
      notes:
        provider === "unknown"
          ? ["Provider could not be identified from this key format."]
          : [`${provider} key detected.`, "Automatic model discovery is currently enabled only for OpenRouter keys."]
    };
  }

  try {
    const availableModels = await discoverOpenRouterCodingModels(apiKey, options);
    return {
      provider,
      availableModels,
      notes: [
        "OpenRouter key detected.",
        "Models were filtered to free programming-capable text models that support tools."
      ]
    };
  } catch (error) {
    return {
      provider,
      availableModels: [],
      notes: [
        "OpenRouter key detected.",
        `Model discovery failed: ${error.message}`
      ]
    };
  }
}
