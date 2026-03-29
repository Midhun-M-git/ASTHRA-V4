import { createId } from "../lib/ids.js";
import { findNextRun, validateCron } from "../lib/cron.js";
import { truncateText } from "../lib/fs-utils.js";

function sortByDateDescending(items, field) {
  return [...items].sort((left, right) => Date.parse(right[field] || 0) - Date.parse(left[field] || 0));
}

export class AutomationService {
  constructor(store, agentRunner) {
    this.store = store;
    this.agentRunner = agentRunner;
    this.runningAutomations = new Set();
    this.interval = null;
  }

  async start() {
    await this.recalculateSchedules();
    this.interval = setInterval(() => {
      this.tick().catch((error) => {
        console.error("Automation tick failed:", error);
      });
    }, 15000);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async recalculateSchedules() {
    await this.store.update((state) => {
      for (const automation of state.automations) {
        if (automation.enabled && !automation.nextRunAt) {
          automation.nextRunAt = findNextRun(automation.schedule, new Date());
        }
      }
      return state;
    });
  }

  async listAutomations() {
    const state = await this.store.getState();
    return sortByDateDescending(state.automations, "updatedAt");
  }

  async createAutomation(input) {
    validateCron(input.schedule);
    const now = new Date().toISOString();
    const automation = {
      id: createId("auto"),
      name: input.name,
      prompt: input.prompt,
      schedule: input.schedule,
      enabled: input.enabled !== false,
      model: input.model || null,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      nextRunAt: input.enabled === false ? null : findNextRun(input.schedule, new Date()),
      conversationId: null
    };

    await this.store.update((state) => {
      state.automations.unshift(automation);
      return state;
    });

    return automation;
  }

  async updateAutomation(automationId, patch) {
    let updatedAutomation = null;

    await this.store.update((state) => {
      const automation = state.automations.find((item) => item.id === automationId);
      if (!automation) {
        throw new Error(`Automation not found: ${automationId}`);
      }

      if (patch.schedule) {
        validateCron(patch.schedule);
      }

      Object.assign(automation, {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
        ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.model !== undefined ? { model: patch.model || null } : {}),
        updatedAt: new Date().toISOString()
      });

      automation.nextRunAt = automation.enabled ? findNextRun(automation.schedule, new Date()) : null;
      updatedAutomation = { ...automation };
      return state;
    });

    return updatedAutomation;
  }

  async deleteAutomation(automationId) {
    await this.store.update((state) => {
      state.automations = state.automations.filter((item) => item.id !== automationId);
      return state;
    });
  }

  async runAutomationNow(automationId) {
    const state = await this.store.getState();
    const automation = state.automations.find((item) => item.id === automationId);
    if (!automation) {
      throw new Error(`Automation not found: ${automationId}`);
    }

    void this.executeAutomation(automation, "manual");
    return { started: true };
  }

  async tick() {
    const state = await this.store.getState();
    const now = Date.now();

    for (const automation of state.automations) {
      if (!automation.enabled || !automation.nextRunAt || this.runningAutomations.has(automation.id)) {
        continue;
      }

      if (Date.parse(automation.nextRunAt) <= now) {
        void this.executeAutomation(automation, "schedule");
      }
    }
  }

  async executeAutomation(automation, trigger) {
    if (this.runningAutomations.has(automation.id)) {
      return;
    }

    this.runningAutomations.add(automation.id);
    const runId = createId("run");
    const startedAt = new Date().toISOString();

    await this.store.update((state) => {
      state.runs.unshift({
        id: runId,
        automationId: automation.id,
        automationName: automation.name,
        status: "running",
        trigger,
        startedAt,
        endedAt: null,
        summary: null,
        error: null
      });
      return state;
    });

    try {
      const result = await this.agentRunner.runAutomation({ automation, trigger });
      const endedAt = new Date().toISOString();

      await this.store.update((state) => {
        const targetAutomation = state.automations.find((item) => item.id === automation.id);
        if (targetAutomation) {
          targetAutomation.lastRunAt = endedAt;
          targetAutomation.updatedAt = endedAt;
          targetAutomation.conversationId = result.conversationId;
          targetAutomation.nextRunAt = targetAutomation.enabled ? findNextRun(targetAutomation.schedule, new Date()) : null;
        }

        const run = state.runs.find((item) => item.id === runId);
        if (run) {
          run.status = "completed";
          run.endedAt = endedAt;
          run.summary = truncateText(result.assistantMessage.content || "", 4000);
          run.error = null;
          run.toolEvents = result.toolEvents;
        }

        state.runs = state.runs.slice(0, 100);
        return state;
      });
    } catch (error) {
      const endedAt = new Date().toISOString();
      await this.store.update((state) => {
        const targetAutomation = state.automations.find((item) => item.id === automation.id);
        if (targetAutomation) {
          targetAutomation.updatedAt = endedAt;
          targetAutomation.nextRunAt = targetAutomation.enabled ? findNextRun(targetAutomation.schedule, new Date()) : null;
        }

        const run = state.runs.find((item) => item.id === runId);
        if (run) {
          run.status = "failed";
          run.endedAt = endedAt;
          run.error = String(error.message || error);
        }
        return state;
      });
    } finally {
      this.runningAutomations.delete(automation.id);
    }
  }
}
