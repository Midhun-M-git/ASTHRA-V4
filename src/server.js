import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AsthraStore } from "./storage/store.js";
import { OpenRouterClient, syncOpenRouterConfig } from "./services/openrouter.js";
import { inspectApiKey } from "./services/provider-discovery.js";
import { ToolService } from "./services/tools.js";
import { AgentRunner } from "./services/agent-runner.js";
import { AutomationService } from "./services/automation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = process.cwd();
const publicDir = path.join(path.dirname(__dirname), "public");
const store = new AsthraStore(path.join(workspaceRoot, "data", "asthra-v4.json"), workspaceRoot);
const openRouterClient = new OpenRouterClient(store);
const toolService = new ToolService(store);
const agentRunner = new AgentRunner(store, openRouterClient, toolService);
const automationService = new AutomationService(store, agentRunner);

toolService.setAutomationService(automationService);
await store.update((state) => {
  state.config = syncOpenRouterConfig(state.config);
  return state;
});
await automationService.start();

function normalizeSelection(value) {
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

function pickSelectedModels(selectedModels, availableModels) {
  const validIds = new Set(availableModels.map((model) => model.id));
  const requested = normalizeSelection(selectedModels).filter((modelId) => validIds.has(modelId));
  return requested.length > 0 ? requested : availableModels.map((model) => model.id);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendText(response, statusCode, payload, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "Content-Type": contentType
  });
  response.end(payload);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function buildClientState(state) {
  const config = syncOpenRouterConfig(state.config);
  const conversations = [...state.conversations]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messageCount: conversation.messages.length,
      lastMessagePreview: conversation.messages.at(-1)?.content?.slice(0, 120) || ""
    }));

  const automations = [...state.automations].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const runs = [...state.runs]
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, 30);

  return {
    meta: state.meta,
    config: {
      ...config,
      activeModel: config.modelStates[config.activeModelIndex]?.model ?? config.currentModel ?? null
    },
    conversations,
    automations,
    runs
  };
}

function parseIdFromPath(pathname, prefix, suffix = "") {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null;
  }

  const start = prefix.length;
  const end = suffix ? pathname.length - suffix.length : pathname.length;
  const value = pathname.slice(start, end);
  return value || null;
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

async function serveStatic(request, response, pathname) {
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  const sanitized = requestPath.replace(/^\/+/, "");
  const filePath = path.resolve(publicDir, sanitized);
  const resolvedPublicDir = path.resolve(publicDir);

  if (filePath !== resolvedPublicDir && !filePath.startsWith(`${resolvedPublicDir}${path.sep}`)) {
    return false;
  }

  try {
    const file = await fs.readFile(filePath);
    sendText(response, 200, file, getContentType(filePath));
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost:3000");
    const { pathname } = url;

    if (request.method === "GET" && pathname === "/api/health") {
      return sendJson(response, 200, { ok: true, app: "ASTHRA V4" });
    }

    if (request.method === "GET" && pathname === "/api/state") {
      const state = await store.getState();
      return sendJson(response, 200, buildClientState(state));
    }

    if (request.method === "GET" && pathname === "/api/workspace") {
      const relativePath = url.searchParams.get("path") || ".";
      const workspace = await toolService.browseWorkspace(relativePath);
      return sendJson(response, 200, workspace);
    }

    if (request.method === "POST" && pathname === "/api/workspace/directory") {
      const body = await readBody(request);
      const relativePath = typeof body.path === "string" ? body.path.trim() : "";
      if (!relativePath) {
        return sendJson(response, 400, { error: "path is required" });
      }

      const result = await toolService.makeDirectory({ path: relativePath });
      return sendJson(response, 201, JSON.parse(result));
    }

    if (request.method === "POST" && pathname === "/api/conversations") {
      const body = await readBody(request);
      const conversation = await agentRunner.createConversation(body.title || "New conversation");
      return sendJson(response, 201, { conversation });
    }

    if (request.method === "GET" && pathname.startsWith("/api/conversations/")) {
      const conversationId = parseIdFromPath(pathname, "/api/conversations/");
      const conversation = await agentRunner.getConversation(conversationId);
      if (!conversation) {
        return sendJson(response, 404, { error: "Conversation not found" });
      }
      return sendJson(response, 200, { conversation });
    }

    if (request.method === "POST" && pathname === "/api/chat") {
      const body = await readBody(request);
      if (!body.message || typeof body.message !== "string") {
        return sendJson(response, 400, { error: "message is required" });
      }

      const result = await agentRunner.runChatTurn({
        conversationId: body.conversationId || null,
        message: body.message,
        targetPath: typeof body.targetPath === "string" ? body.targetPath.trim() : ""
      });

      return sendJson(response, 200, result);
    }

    if (request.method === "POST" && pathname === "/api/config") {
      const body = await readBody(request);

      const apiKey = typeof body.apiKey === "string" ? body.apiKey : body.openRouterApiKey;
      let inspection = null;
      if (typeof apiKey === "string" && apiKey.trim()) {
        inspection = await inspectApiKey(apiKey.trim());
      }

      await store.update((state) => {
        const availableModels = inspection?.provider === "openrouter" ? inspection.availableModels : [];
        const selectedModels =
          inspection?.provider === "openrouter"
            ? pickSelectedModels(body.selectedModels ?? body.modelPool, availableModels)
            : [];

        state.config = syncOpenRouterConfig({
          ...state.config,
          ...(apiKey !== undefined ? { apiKey } : {}),
          ...(inspection?.provider ? { apiProvider: inspection.provider } : {}),
          ...(body.openRouterApiKey !== undefined ? { openRouterApiKey: body.openRouterApiKey } : {}),
          ...(body.openRouterKeys !== undefined ? { openRouterApiKey: body.openRouterKeys } : {}),
          ...(inspection ? { availableModels } : {}),
          ...(inspection ? { modelPool: selectedModels } : body.modelPool !== undefined ? { modelPool: body.modelPool } : {}),
          ...(body.currentModel !== undefined && body.modelPool === undefined && !inspection ? { modelPool: body.currentModel } : {}),
          ...(body.modelCooldownSeconds !== undefined
            ? { modelCooldownSeconds: Number(body.modelCooldownSeconds) || state.config.modelCooldownSeconds }
            : {}),
          ...(body.keyCooldownSeconds !== undefined && body.modelCooldownSeconds === undefined
            ? { modelCooldownSeconds: Number(body.keyCooldownSeconds) || state.config.modelCooldownSeconds }
            : {}),
          ...(body.systemPrompt !== undefined ? { systemPrompt: String(body.systemPrompt) } : {})
        });
        return state;
      });

      const nextState = await store.getState();
      return sendJson(response, 200, buildClientState(nextState));
    }

    if (request.method === "POST" && pathname === "/api/provider/discover") {
      const body = await readBody(request);
      const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
      if (!apiKey) {
        return sendJson(response, 200, {
          provider: "unknown",
          availableModels: [],
          notes: ["Paste an API key to detect the provider."]
        });
      }

      const inspection = await inspectApiKey(apiKey);
      return sendJson(response, 200, inspection);
    }

    if (request.method === "POST" && pathname === "/api/automations") {
      const body = await readBody(request);
      const automation = await automationService.createAutomation({
        name: String(body.name || "").trim(),
        prompt: String(body.prompt || "").trim(),
        schedule: String(body.schedule || "").trim(),
        enabled: body.enabled !== false,
        model: body.model ? String(body.model).trim() : null
      });
      return sendJson(response, 201, { automation });
    }

    if (request.method === "PATCH" && pathname.startsWith("/api/automations/")) {
      const automationId = parseIdFromPath(pathname, "/api/automations/");
      const body = await readBody(request);
      const automation = await automationService.updateAutomation(automationId, {
        ...(body.name !== undefined ? { name: String(body.name).trim() } : {}),
        ...(body.prompt !== undefined ? { prompt: String(body.prompt) } : {}),
        ...(body.schedule !== undefined ? { schedule: String(body.schedule).trim() } : {}),
        ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
        ...(body.model !== undefined ? { model: body.model ? String(body.model).trim() : null } : {})
      });
      return sendJson(response, 200, { automation });
    }

    if (request.method === "DELETE" && pathname.startsWith("/api/automations/")) {
      const automationId = parseIdFromPath(pathname, "/api/automations/");
      await automationService.deleteAutomation(automationId);
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === "POST" && pathname.startsWith("/api/automations/") && pathname.endsWith("/run")) {
      const automationId = parseIdFromPath(pathname, "/api/automations/", "/run");
      const result = await automationService.runAutomationNow(automationId);
      return sendJson(response, 202, result);
    }

    if (await serveStatic(request, response, pathname)) {
      return undefined;
    }

    return sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    return sendJson(response, 500, {
      error: error.message || "Unknown server error"
    });
  }
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  console.log(`ASTHRA V4 is running at http://localhost:${port}`);
});

function shutdown() {
  automationService.stop();
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
