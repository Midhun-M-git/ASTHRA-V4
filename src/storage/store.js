import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, pathExists } from "../lib/fs-utils.js";

function buildDefaultSystemPrompt(workspaceRoot) {
  return [
    "You are ASTHRA V4, a local coding and automation copilot.",
    `The workspace root is: ${workspaceRoot}`,
    "Prefer using tools for concrete facts about the workspace.",
    "For coding tasks, inspect the relevant files before editing them and write code directly into the workspace.",
    "Create missing directories when needed and verify code changes with a relevant command whenever practical.",
    "Be concise, practical, and explicit about what you changed or discovered.",
    "When automations run, behave as a reliable background operator that can inspect files and execute commands when needed."
  ].join("\n");
}

function buildDefaultState(workspaceRoot) {
  const now = new Date().toISOString();
  return {
    meta: {
      appName: "ASTHRA V4",
      version: "0.1.0",
      createdAt: now,
      updatedAt: now
    },
    config: {
      workspaceRoot,
      apiProvider: "unknown",
      apiKey: "",
      apiKeyPreview: "empty",
      openRouterApiKey: "",
      availableModels: [],
      modelPool: [],
      modelStates: [],
      activeModelIndex: 0,
      currentModel: "",
      modelCooldownSeconds: 90,
      maxToolIterations: 8,
      systemPrompt: buildDefaultSystemPrompt(workspaceRoot)
    },
    conversations: [],
    automations: [],
    runs: []
  };
}

export class AsthraStore {
  constructor(filePath, workspaceRoot) {
    this.filePath = filePath;
    this.workspaceRoot = workspaceRoot;
    this.queue = Promise.resolve();
  }

  async init() {
    await ensureDir(path.dirname(this.filePath));

    if (!(await pathExists(this.filePath))) {
      const initial = buildDefaultState(this.workspaceRoot);
      await fs.writeFile(this.filePath, JSON.stringify(initial, null, 2), "utf8");
    }
  }

  async readState() {
    await this.init();
    const raw = await fs.readFile(this.filePath, "utf8");
    return JSON.parse(raw);
  }

  async writeState(state) {
    const nextState = {
      ...state,
      meta: {
        ...state.meta,
        updatedAt: new Date().toISOString()
      }
    };
    await fs.writeFile(this.filePath, JSON.stringify(nextState, null, 2), "utf8");
    return nextState;
  }

  enqueue(task) {
    const next = this.queue.then(task, task);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async getState() {
    return this.enqueue(async () => this.readState());
  }

  async update(mutator) {
    return this.enqueue(async () => {
      const state = await this.readState();
      const maybeState = await mutator(state);
      const nextState = maybeState ?? state;
      return this.writeState(nextState);
    });
  }
}
