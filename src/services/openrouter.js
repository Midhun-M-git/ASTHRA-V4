import { detectApiProvider } from "./provider-discovery.js";

function maskKey(key) {
  if (!key) {
    return "empty";
  }
  if (key.length <= 12) {
    return `${key.slice(0, 4)}...${key.slice(-2)}`;
  }
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function splitLines(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function unique(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item)) {
      return false;
    }
    seen.add(item);
    return true;
  });
}

export function normalizeOpenRouterApiKey(rawValue) {
  if (typeof rawValue === "string") {
    return rawValue.trim();
  }

  if (Array.isArray(rawValue)) {
    return splitLines(rawValue)[0] ?? "";
  }

  return "";
}

export function normalizeModelPool(rawValue, fallbackModel = "") {
  const models = splitLines(rawValue);

  if (models.length > 0) {
    return unique(models);
  }

  if (typeof fallbackModel === "string" && fallbackModel.trim()) {
    return [fallbackModel.trim()];
  }

  return [];
}

function normalizeAvailableModels(rawValue) {
  if (!Array.isArray(rawValue)) {
    return [];
  }

  return rawValue
    .filter((item) => item && typeof item.id === "string")
    .map((item) => ({
      id: item.id.trim(),
      name: typeof item.name === "string" ? item.name.trim() || item.id.trim() : item.id.trim(),
      description: typeof item.description === "string" ? item.description.trim() : "",
      contextLength: Number.isFinite(Number(item.contextLength)) ? Number(item.contextLength) : null,
      supportsTools: Boolean(item.supportsTools),
      isFree: item.isFree !== false
    }))
    .filter((item) => item.id);
}

export function syncOpenRouterConfig(config) {
  const apiKey = normalizeOpenRouterApiKey(config.apiKey ?? config.openRouterApiKey ?? config.openRouterKeys);
  const availableModels = normalizeAvailableModels(config.availableModels);
  const preferredPool = normalizeModelPool(config.modelPool ?? config.selectedModels ?? config.freeModels);
  const validModelIds = new Set(availableModels.map((model) => model.id));
  const modelPool =
    availableModels.length > 0
      ? unique(preferredPool.filter((model) => validModelIds.has(model)))
      : unique(preferredPool);
  const previousStates = Array.isArray(config.modelStates) ? config.modelStates : [];

  const modelStates = modelPool.map((model) => {
    const existing = previousStates.find((state) => state.model === model);
    return {
      model,
      cooldownUntil: existing?.cooldownUntil ?? null,
      failures: existing?.failures ?? 0,
      lastError: existing?.lastError ?? null,
      lastUsedAt: existing?.lastUsedAt ?? null,
      lastSuccessAt: existing?.lastSuccessAt ?? null
    };
  });

  const activeModelIndex =
    Number.isInteger(config.activeModelIndex) && config.activeModelIndex >= 0 && config.activeModelIndex < modelStates.length
      ? config.activeModelIndex
      : 0;

  return {
    ...config,
    apiProvider:
      typeof config.apiProvider === "string" && config.apiProvider !== "unknown"
        ? config.apiProvider
        : detectApiProvider(apiKey),
    apiKey,
    apiKeyPreview: maskKey(apiKey),
    openRouterKeys: undefined,
    freeModels: undefined,
    keyStates: undefined,
    activeKeyIndex: undefined,
    keyCooldownSeconds: undefined,
    openRouterApiKey: apiKey,
    openRouterApiKeyPreview: maskKey(apiKey),
    availableModels,
    modelPool,
    modelStates,
    activeModelIndex,
    currentModel: modelStates[activeModelIndex]?.model ?? modelPool[0] ?? "",
    modelCooldownSeconds: Number(config.modelCooldownSeconds || config.keyCooldownSeconds) || 90
  };
}

function buildModelOrder(modelStates, activeModelIndex) {
  if (!modelStates.length) {
    return [];
  }

  const now = Date.now();
  const ordered = Array.from({ length: modelStates.length }, (_, index) => (activeModelIndex + index) % modelStates.length);
  const available = ordered.filter((index) => {
    const cooldownUntil = modelStates[index].cooldownUntil ? Date.parse(modelStates[index].cooldownUntil) : 0;
    return !cooldownUntil || cooldownUntil <= now;
  });

  if (available.length > 0) {
    return available;
  }

  return [...ordered].sort((left, right) => {
    const leftTime = modelStates[left].cooldownUntil ? Date.parse(modelStates[left].cooldownUntil) : 0;
    const rightTime = modelStates[right].cooldownUntil ? Date.parse(modelStates[right].cooldownUntil) : 0;
    return leftTime - rightTime;
  });
}

function buildModelCandidates(config, requestedModel) {
  const candidates = [];
  const seen = new Set();

  if (typeof requestedModel === "string" && requestedModel.trim()) {
    const model = requestedModel.trim();
    candidates.push({
      model,
      stateIndex: config.modelStates.findIndex((state) => state.model === model)
    });
    seen.add(model);
  }

  for (const index of buildModelOrder(config.modelStates, config.activeModelIndex ?? 0)) {
    const model = config.modelStates[index].model;
    if (seen.has(model)) {
      continue;
    }

    candidates.push({
      model,
      stateIndex: index
    });
    seen.add(model);
  }

  return candidates;
}

function extractErrorMessage(status, payload, rawText) {
  const payloadMessage =
    payload?.error?.message ||
    payload?.message ||
    payload?.detail ||
    (typeof payload?.error === "string" ? payload.error : null);

  return payloadMessage || rawText || `OpenRouter request failed with status ${status}`;
}

function isRateLimited(status, payload, message) {
  const text = JSON.stringify(payload || {}).toLowerCase() + ` ${String(message || "").toLowerCase()}`;
  return status === 429 || status === 402 || text.includes("rate limit") || text.includes("quota") || text.includes("credits");
}

export class OpenRouterClient {
  constructor(store, options = {}) {
    this.store = store;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async sendChat({ messages, tools = [], model }) {
    const state = await this.store.getState();
    const config = syncOpenRouterConfig(state.config);

    if (config.apiProvider !== "openrouter") {
      throw new Error(
        config.apiProvider && config.apiProvider !== "unknown"
          ? `Detected provider is ${config.apiProvider}. ASTHRA V4 chat routing is currently wired for OpenRouter.`
          : "No supported provider configured. Paste an OpenRouter API key in Settings."
      );
    }

    if (!config.apiKey) {
      throw new Error("No OpenRouter API key configured. Add your key in Settings.");
    }

    if (JSON.stringify(config.modelStates) !== JSON.stringify(state.config.modelStates) || config.activeModelIndex !== state.config.activeModelIndex) {
      await this.store.update((nextState) => {
        nextState.config = config;
        return nextState;
      });
    }

    const candidates = buildModelCandidates(config, model);
    if (!candidates.length) {
      throw new Error("No OpenRouter fallback models configured. Add one or more free models in Settings.");
    }

    const errors = [];

    for (const candidate of candidates) {
      const startedAt = new Date().toISOString();
      const response = await this.fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
          "HTTP-Referer": "http://localhost:3000",
          "X-Title": "ASTHRA V4"
        },
        body: JSON.stringify({
          model: candidate.model,
          messages,
          tools,
          tool_choice: tools.length > 0 ? "auto" : undefined,
          temperature: 0.2
        })
      });

      const rawText = await response.text();
      let payload;
      try {
        payload = rawText ? JSON.parse(rawText) : {};
      } catch {
        payload = { rawText };
      }

      if (response.ok) {
        await this.store.update((nextState) => {
          const nextConfig = syncOpenRouterConfig(nextState.config);
          if (candidate.stateIndex >= 0) {
            const modelState = nextConfig.modelStates[candidate.stateIndex];
            if (modelState) {
              modelState.lastUsedAt = startedAt;
              modelState.lastSuccessAt = new Date().toISOString();
              modelState.lastError = null;
              modelState.cooldownUntil = null;
            }
            nextConfig.activeModelIndex = candidate.stateIndex;
          }
          nextConfig.currentModel = candidate.model;
          nextState.config = nextConfig;
          return nextState;
        });

        return {
          ...payload,
          _meta: {
            model: candidate.model,
            keyPreview: config.apiKeyPreview
          }
        };
      }

      const message = extractErrorMessage(response.status, payload, rawText);
      const shouldRotate = isRateLimited(response.status, payload, message);
      errors.push(`[${candidate.model}] ${message}`);

      await this.store.update((nextState) => {
        const nextConfig = syncOpenRouterConfig(nextState.config);
        if (candidate.stateIndex >= 0) {
          const modelState = nextConfig.modelStates[candidate.stateIndex];
          if (modelState) {
            modelState.failures = (modelState.failures ?? 0) + 1;
            modelState.lastError = message;
            modelState.lastUsedAt = startedAt;
            if (shouldRotate) {
              const cooldownSeconds = Number(nextConfig.modelCooldownSeconds) || 90;
              modelState.cooldownUntil = new Date(Date.now() + cooldownSeconds * 1000).toISOString();
            }
          }

          if (shouldRotate && nextConfig.modelStates.length > 1) {
            nextConfig.activeModelIndex = (candidate.stateIndex + 1) % nextConfig.modelStates.length;
          }
        }

        nextState.config = nextConfig;
        return nextState;
      });

      if (!shouldRotate || candidates.length === 1) {
        throw new Error(message);
      }
    }

    throw new Error(`All OpenRouter models failed.\n${errors.join("\n")}`);
  }
}
