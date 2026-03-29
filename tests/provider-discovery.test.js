import test from "node:test";
import assert from "node:assert/strict";

import { detectApiProvider, discoverOpenRouterCodingModels, inspectApiKey } from "../src/services/provider-discovery.js";

test("detectApiProvider classifies the common key formats", () => {
  assert.equal(detectApiProvider("sk-or-v1-example"), "openrouter");
  assert.equal(detectApiProvider("AIzaExampleKey"), "gemini");
  assert.equal(detectApiProvider("sk-proj-example"), "openai");
  assert.equal(detectApiProvider(""), "unknown");
});

test("discoverOpenRouterCodingModels keeps only free tool-capable coding models", async () => {
  const seenUrls = [];
  const payload = {
    data: [
      {
        id: "provider/coder-free",
        name: "Coder Free",
        description: "A programming model for code generation.",
        pricing: { prompt: "0", completion: "0", request: "0" },
        supported_parameters: ["tools", "temperature"],
        architecture: { output_modalities: ["text"] },
        top_provider: { context_length: 65536 }
      },
      {
        id: "provider/not-free",
        name: "Paid Model",
        description: "Programming model but not free.",
        pricing: { prompt: "0.000001", completion: "0", request: "0" },
        supported_parameters: ["tools"],
        architecture: { output_modalities: ["text"] }
      },
      {
        id: "provider/no-tools-free",
        name: "No Tools",
        description: "Free but no tools.",
        pricing: { prompt: "0", completion: "0", request: "0" },
        supported_parameters: ["temperature"],
        architecture: { output_modalities: ["text"] }
      }
    ]
  };

  const models = await discoverOpenRouterCodingModels("sk-or-v1-example", {
    fetchImpl: async (url) => {
      seenUrls.push(String(url));
      return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload)
      };
    }
  });

  assert.equal(models.length, 1);
  assert.equal(models[0].id, "provider/coder-free");
  assert.equal(models[0].supportsTools, true);
  assert.equal(models[0].isFree, true);
  assert.match(seenUrls[0], /category=programming/);
  assert.doesNotMatch(seenUrls[0], /supported_parameters=/);
});

test("inspectApiKey still identifies OpenRouter when model discovery fails", async () => {
  const inspection = await inspectApiKey("sk-or-v1-example", {
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: "Cannot provide both category and supported_parameters" } })
    })
  });

  assert.equal(inspection.provider, "openrouter");
  assert.deepEqual(inspection.availableModels, []);
  assert.match(inspection.notes[1], /Model discovery failed/);
});
