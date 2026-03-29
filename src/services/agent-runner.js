import { createId } from "../lib/ids.js";
import { truncateText } from "../lib/fs-utils.js";

function normalizeContent(content) {
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item?.type === "text") {
          return item.text || "";
        }
        return JSON.stringify(item);
      })
      .join("\n");
  }

  if (content == null) {
    return "";
  }

  return String(content);
}

function buildConversationTitle(text) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 48 ? `${compact.slice(0, 48)}...` : compact || "New conversation";
}

function toApiMessage(message) {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content
    };
  }

  if (message.toolCalls) {
    return {
      role: "assistant",
      content: message.content || "",
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments
        }
      }))
    };
  }

  return {
    role: message.role,
    content: message.content
  };
}

function getConversationById(state, conversationId) {
  return state.conversations.find((conversation) => conversation.id === conversationId);
}

function buildWorkStylePrompt({ mode, automation, targetPath }) {
  const lines = [
    mode === "automation"
      ? `You are executing automation "${automation?.name}". Act like a dependable background operator.`
      : "You are assisting the user interactively in the ASTHRA V4 workspace.",
    "When the user asks to create, update, fix, or refactor code, behave like a coding agent rather than a plain chatbot.",
    "For code tasks, inspect the relevant workspace area first before writing. Use list_workspace, inspect_path, search_workspace, and read_file to understand existing files.",
    "If you change an existing file, read it first unless the user explicitly asked for a blind overwrite.",
    "If directories are missing, create them or write files into them deliberately.",
    "After making code changes, run a relevant verification command when practical, such as a test, build, lint, or file listing check.",
    "In your final assistant message, state what files you changed and whether verification ran."
  ];

  if (targetPath) {
    lines.push(`Preferred save target from the user: ${targetPath}`);
    lines.push("If that target is a file path, save the primary output there unless the user asks otherwise.");
    lines.push("If that target is a directory path, treat it as the preferred location for new or updated files.");
  }

  return lines.join("\n");
}

export class AgentRunner {
  constructor(store, openRouterClient, toolService) {
    this.store = store;
    this.openRouterClient = openRouterClient;
    this.toolService = toolService;
  }

  async createConversation(seedMessage = "New conversation") {
    const now = new Date().toISOString();
    const conversation = {
      id: createId("conv"),
      title: buildConversationTitle(seedMessage),
      createdAt: now,
      updatedAt: now,
      messages: []
    };

    await this.store.update((state) => {
      state.conversations.unshift(conversation);
      return state;
    });

    return conversation;
  }

  async getConversation(conversationId) {
    const state = await this.store.getState();
    return getConversationById(state, conversationId);
  }

  async appendMessage(conversationId, message) {
    await this.store.update((state) => {
      const conversation = getConversationById(state, conversationId);
      if (!conversation) {
        throw new Error(`Conversation not found: ${conversationId}`);
      }

      conversation.messages.push(message);
      conversation.updatedAt = new Date().toISOString();
      if (conversation.messages.length === 1 && message.role === "user") {
        conversation.title = buildConversationTitle(message.content);
      }
      return state;
    });
  }

  async runChatTurn({ conversationId, message, targetPath = "" }) {
    const conversation = conversationId ? await this.getConversation(conversationId) : await this.createConversation(message);

    if (!conversation) {
      throw new Error("Conversation could not be created");
    }

    const userMessage = {
      id: createId("msg"),
      role: "user",
      content: message,
      createdAt: new Date().toISOString(),
      targetPath: targetPath || null
    };

    await this.appendMessage(conversation.id, userMessage);
    return this.runAgentLoop({
      conversationId: conversation.id,
      mode: "chat",
      targetPath: targetPath || null
    });
  }

  async runAutomation({ automation, trigger = "schedule" }) {
    let conversationId = automation.conversationId;
    if (!conversationId) {
      const conversation = await this.createConversation(automation.name);
      conversationId = conversation.id;

      await this.store.update((state) => {
        const targetAutomation = state.automations.find((item) => item.id === automation.id);
        if (targetAutomation) {
          targetAutomation.conversationId = conversationId;
        }
        return state;
      });
    }

    const automationMessage = {
      id: createId("msg"),
      role: "user",
      content: [
        `Automation "${automation.name}" fired via ${trigger}.`,
        `Timestamp: ${new Date().toISOString()}`,
        "",
        automation.prompt
      ].join("\n"),
      createdAt: new Date().toISOString(),
      automationId: automation.id
    };

    await this.appendMessage(conversationId, automationMessage);

    return this.runAgentLoop({
      conversationId,
      mode: "automation",
      automation,
      targetPath: automation.targetPath || null
    });
  }

  async runAgentLoop({ conversationId, mode, automation, targetPath = null }) {
    const toolEvents = [];

    const initialState = await this.store.getState();
    const maxIterations = Number(initialState.config.maxToolIterations) || 8;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const state = await this.store.getState();
      const conversation = getConversationById(state, conversationId);

      if (!conversation) {
        throw new Error(`Conversation not found: ${conversationId}`);
      }

      const systemPrompt = [
        state.config.systemPrompt,
        buildWorkStylePrompt({ mode, automation, targetPath })
      ].join("\n\n");

      const messages = [{ role: "system", content: systemPrompt }, ...conversation.messages.map(toApiMessage)];
      const response = await this.openRouterClient.sendChat({
        messages,
        tools: this.toolService.getToolDefinitions(),
        model: automation?.model || state.config.currentModel
      });

      const choice = response?.choices?.[0]?.message;
      if (!choice) {
        throw new Error("OpenRouter returned no assistant message");
      }

      const content = normalizeContent(choice.content);
      const toolCalls = Array.isArray(choice.tool_calls)
        ? choice.tool_calls.map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.function?.name,
            arguments: toolCall.function?.arguments ?? "{}"
          }))
        : [];

      const assistantMessage = {
        id: createId("msg"),
        role: "assistant",
        content: content || (toolCalls.length > 0 ? `Using ${toolCalls.length} tool(s)...` : ""),
        createdAt: new Date().toISOString(),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined
      };

      await this.appendMessage(conversationId, assistantMessage);

      if (toolCalls.length === 0) {
        const finalConversation = await this.getConversation(conversationId);
        return {
          conversationId,
          conversation: finalConversation,
          assistantMessage,
          toolEvents
        };
      }

      for (const toolCall of toolCalls) {
        let parsedArgs = {};
        try {
          parsedArgs = toolCall.arguments ? JSON.parse(toolCall.arguments) : {};
        } catch {
          parsedArgs = {};
        }

        let result;
        try {
          result = await this.toolService.executeToolCall(toolCall.name, parsedArgs);
        } catch (error) {
          result = `Tool execution failed: ${error.message}`;
        }

        const toolMessage = {
          id: createId("msg"),
          role: "tool",
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          content: truncateText(result, 20000),
          createdAt: new Date().toISOString()
        };

        toolEvents.push({
          name: toolCall.name,
          arguments: parsedArgs,
          result: truncateText(result, 3000)
        });

        await this.appendMessage(conversationId, toolMessage);
      }
    }

    throw new Error(`Agent loop reached the maximum tool iterations (${maxIterations})`);
  }
}
