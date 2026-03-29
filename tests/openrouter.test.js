import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { AsthraStore } from "../src/storage/store.js";
import { OpenRouterClient, syncOpenRouterConfig } from "../src/services/openrouter.js";

test("syncOpenRouterConfig keeps the fallback pool explicit", () => {
  const config = syncOpenRouterConfig({
    currentModel: "openai/gpt-4o-mini",
    apiProvider: "openrouter",
    apiKey: "test-key"
  });

  assert.deepEqual(config.modelPool, []);
  assert.equal(config.currentModel, "");
});

test("OpenRouterClient rotates to the next model after rate limiting", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "asthra-v4-"));
  const store = new AsthraStore(path.join(tempDir, "state.json"), tempDir);
  await store.init();

  await store.update((state) => {
    state.config = syncOpenRouterConfig({
      ...state.config,
      apiProvider: "openrouter",
      apiKey: "test-key",
      modelPool: ["provider/model-a:free", "provider/model-b:free"]
    });
    return state;
  });

  const responses = [
    {
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ error: { message: "Rate limit reached" } })
    },
    {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Fallback model worked." } }]
        })
    }
  ];

  const client = new OpenRouterClient(store, {
    fetchImpl: async () => responses.shift()
  });

  const result = await client.sendChat({
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(result.choices[0].message.content, "Fallback model worked.");
  assert.equal(result._meta.model, "provider/model-b:free");

  const nextState = await store.getState();
  assert.equal(nextState.config.activeModelIndex, 1);
  assert.equal(Boolean(nextState.config.modelStates[0].cooldownUntil), true);
});
