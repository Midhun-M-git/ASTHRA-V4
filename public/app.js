const state = {
  app: null,
  currentTab: "chat",
  currentConversationId: null,
  currentConversation: null,
  editingAutomationId: null,
  settingsDirty: false,
  automationDirty: false,
  loading: false
};

const refs = {
  tabs: document.querySelectorAll(".nav-tab"),
  panels: {
    chat: document.getElementById("chatTab"),
    automations: document.getElementById("automationsTab"),
    settings: document.getElementById("settingsTab")
  },
  conversationList: document.getElementById("conversationList"),
  conversationTitle: document.getElementById("conversationTitle"),
  chatMessages: document.getElementById("chatMessages"),
  chatForm: document.getElementById("chatForm"),
  chatInput: document.getElementById("chatInput"),
  chatStatus: document.getElementById("chatStatus"),
  newConversationButton: document.getElementById("newConversationButton"),
  activeModelPill: document.getElementById("activeModelPill"),
  activeKeyPill: document.getElementById("activeKeyPill"),
  automationForm: document.getElementById("automationForm"),
  automationFormTitle: document.getElementById("automationFormTitle"),
  automationResetButton: document.getElementById("automationResetButton"),
  automationName: document.getElementById("automationName"),
  automationSchedule: document.getElementById("automationSchedule"),
  automationModel: document.getElementById("automationModel"),
  automationPrompt: document.getElementById("automationPrompt"),
  automationEnabled: document.getElementById("automationEnabled"),
  automationList: document.getElementById("automationList"),
  runList: document.getElementById("runList"),
  settingsForm: document.getElementById("settingsForm"),
  settingsKeys: document.getElementById("settingsKeys"),
  settingsModel: document.getElementById("settingsModel"),
  settingsCooldown: document.getElementById("settingsCooldown"),
  settingsPrompt: document.getElementById("settingsPrompt"),
  settingsWorkspace: document.getElementById("settingsWorkspace"),
  keyStateList: document.getElementById("keyStateList")
};

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }
  return payload;
}

function formatDate(value) {
  if (!value) {
    return "Never";
  }
  return new Date(value).toLocaleString();
}

function setChatStatus(message) {
  refs.chatStatus.textContent = message;
}

function renderTabs() {
  refs.tabs.forEach((tab) => {
    const isActive = tab.dataset.tab === state.currentTab;
    tab.classList.toggle("active", isActive);
    refs.panels[tab.dataset.tab].classList.toggle("active", isActive);
  });
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function renderConversations() {
  refs.conversationList.innerHTML = "";

  const conversations = state.app?.conversations || [];
  if (conversations.length === 0) {
    refs.conversationList.append(createElement("div", "empty-state", "No conversations yet. Start with a prompt in Chat."));
    return;
  }

  for (const conversation of conversations) {
    const button = createElement("button", "conversation-item");
    button.type = "button";
    button.dataset.conversationId = conversation.id;
    button.classList.toggle("active", conversation.id === state.currentConversationId);

    const title = createElement("h3", "item-title", conversation.title);
    const meta = createElement("p", "item-meta", `${conversation.messageCount} messages`);
    const preview = createElement("p", "item-meta", conversation.lastMessagePreview || "No messages yet");

    button.append(title, meta, preview);
    refs.conversationList.append(button);
  }
}

function renderChat() {
  refs.chatMessages.innerHTML = "";

  const config = state.app?.config;
  refs.activeModelPill.textContent = config?.currentModel || "No model";
  refs.activeKeyPill.textContent = config?.activeKeyPreview ? `Active key: ${config.activeKeyPreview}` : "No keys loaded";
  refs.conversationTitle.textContent = state.currentConversation?.title || "New conversation";

  if (!state.currentConversation) {
    refs.chatMessages.append(createElement("div", "empty-state", "Create a new conversation or send a message to begin."));
    return;
  }

  for (const message of state.currentConversation.messages) {
    const card = createElement("article", `message ${message.role}`);
    const metaText = message.role === "tool" ? `Tool: ${message.toolName}` : message.role;
    const meta = createElement("span", "message-meta", `${metaText} · ${formatDate(message.createdAt)}`);
    const body = createElement("div", "", message.content || "");
    card.append(meta, body);
    refs.chatMessages.append(card);
  }

  refs.chatMessages.scrollTop = refs.chatMessages.scrollHeight;
}

function renderAutomationForm() {
  refs.automationFormTitle.textContent = state.editingAutomationId ? "Edit Automation" : "Create Automation";

  if (!state.automationDirty) {
    if (state.editingAutomationId) {
      const automation = state.app?.automations.find((item) => item.id === state.editingAutomationId);
      if (automation) {
        refs.automationName.value = automation.name;
        refs.automationSchedule.value = automation.schedule;
        refs.automationModel.value = automation.model || "";
        refs.automationPrompt.value = automation.prompt;
        refs.automationEnabled.checked = automation.enabled;
      }
    } else {
      refs.automationForm.reset();
      refs.automationEnabled.checked = true;
    }
  }
}

function renderAutomations() {
  renderAutomationForm();
  refs.automationList.innerHTML = "";
  refs.runList.innerHTML = "";

  const automations = state.app?.automations || [];
  if (automations.length === 0) {
    refs.automationList.append(createElement("div", "empty-state", "No automations configured yet."));
  } else {
    for (const automation of automations) {
      const card = createElement("div", "automation-item");
      const title = createElement("h3", "item-title", automation.name);
      const meta = createElement(
        "p",
        "item-meta",
        `${automation.enabled ? "Enabled" : "Paused"} · ${automation.schedule} · Next: ${automation.nextRunAt ? formatDate(automation.nextRunAt) : "None"}`
      );
      const secondary = createElement("p", "item-meta", `Last run: ${formatDate(automation.lastRunAt)}${automation.model ? ` · Model: ${automation.model}` : ""}`);
      const actions = createElement("div", "item-actions");

      const editButton = createElement("button", "mini-button", "Edit");
      editButton.type = "button";
      editButton.dataset.action = "edit";
      editButton.dataset.id = automation.id;

      const runButton = createElement("button", "mini-button", "Run Now");
      runButton.type = "button";
      runButton.dataset.action = "run";
      runButton.dataset.id = automation.id;

      const toggleButton = createElement("button", "mini-button", automation.enabled ? "Pause" : "Enable");
      toggleButton.type = "button";
      toggleButton.dataset.action = "toggle";
      toggleButton.dataset.id = automation.id;

      const deleteButton = createElement("button", "mini-button danger", "Delete");
      deleteButton.type = "button";
      deleteButton.dataset.action = "delete";
      deleteButton.dataset.id = automation.id;

      actions.append(editButton, runButton, toggleButton, deleteButton);
      card.append(title, meta, secondary, actions);
      refs.automationList.append(card);
    }
  }

  const runs = state.app?.runs || [];
  if (runs.length === 0) {
    refs.runList.append(createElement("div", "empty-state", "Runs will appear here once an automation fires."));
  } else {
    for (const run of runs) {
      const card = createElement("div", `run-item ${run.status}`);
      const title = createElement("h3", "item-title", `${run.automationName} · ${run.status}`);
      const meta = createElement("p", "item-meta", `${run.trigger} · Started ${formatDate(run.startedAt)}`);
      const summary = createElement("p", "item-meta", run.error || run.summary || "Run in progress...");
      card.append(title, meta, summary);
      refs.runList.append(card);
    }
  }
}

function renderSettings() {
  const config = state.app?.config;
  if (!config) {
    return;
  }

  if (!state.settingsDirty) {
    refs.settingsKeys.value = (config.openRouterKeys || []).join("\n");
    refs.settingsModel.value = config.currentModel || "";
    refs.settingsCooldown.value = config.keyCooldownSeconds || 90;
    refs.settingsPrompt.value = config.systemPrompt || "";
    refs.settingsWorkspace.value = config.workspaceRoot || "";
  }

  refs.keyStateList.innerHTML = "";
  if (!config.keyStates || config.keyStates.length === 0) {
    refs.keyStateList.append(createElement("div", "empty-state", "No keys configured yet."));
    return;
  }

  for (const keyState of config.keyStates) {
    const item = createElement("div", "key-state-item");
    const title = createElement("h3", "item-title", keyState.keyPreview);
    const meta = createElement("p", "item-meta", `Last success: ${formatDate(keyState.lastSuccessAt)} · Failures: ${keyState.failures || 0}`);
    const detail = createElement(
      "p",
      "item-meta",
      `Cooldown until: ${keyState.cooldownUntil ? formatDate(keyState.cooldownUntil) : "Ready"}${keyState.lastError ? ` · Last error: ${keyState.lastError}` : ""}`
    );
    item.append(title, meta, detail);
    refs.keyStateList.append(item);
  }
}

function render() {
  renderTabs();
  renderConversations();
  renderChat();
  renderAutomations();
  renderSettings();
}

async function loadConversation(conversationId) {
  if (!conversationId) {
    state.currentConversation = null;
    state.currentConversationId = null;
    renderChat();
    return;
  }

  const payload = await fetchJson(`/api/conversations/${conversationId}`);
  state.currentConversation = payload.conversation;
  state.currentConversationId = payload.conversation.id;
  renderChat();
}

async function loadState() {
  state.app = await fetchJson("/api/state");

  if (!state.currentConversationId && state.app.conversations.length > 0) {
    state.currentConversationId = state.app.conversations[0].id;
  }

  render();

  if (state.currentConversationId) {
    const exists = state.app.conversations.some((conversation) => conversation.id === state.currentConversationId);
    if (exists) {
      await loadConversation(state.currentConversationId);
    } else {
      state.currentConversation = null;
      state.currentConversationId = null;
      renderChat();
    }
  }
}

function resetAutomationForm() {
  state.editingAutomationId = null;
  state.automationDirty = false;
  refs.automationForm.reset();
  refs.automationEnabled.checked = true;
  renderAutomationForm();
}

refs.tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    state.currentTab = tab.dataset.tab;
    renderTabs();
  });
});

refs.newConversationButton.addEventListener("click", async () => {
  const payload = await fetchJson("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ title: "New conversation" })
  });
  state.currentConversationId = payload.conversation.id;
  state.currentConversation = payload.conversation;
  await loadState();
});

refs.conversationList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-conversation-id]");
  if (!button) {
    return;
  }
  await loadConversation(button.dataset.conversationId);
  renderConversations();
});

refs.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = refs.chatInput.value.trim();
  if (!message || state.loading) {
    return;
  }

  state.loading = true;
  setChatStatus("Working...");

  try {
    const payload = await fetchJson("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        conversationId: state.currentConversationId,
        message
      })
    });

    refs.chatInput.value = "";
    state.currentConversationId = payload.conversationId;
    state.currentConversation = payload.conversation;
    await loadState();
    setChatStatus("Completed");
  } catch (error) {
    setChatStatus(error.message);
  } finally {
    state.loading = false;
  }
});

refs.automationForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const payload = {
    name: refs.automationName.value.trim(),
    schedule: refs.automationSchedule.value.trim(),
    model: refs.automationModel.value.trim() || null,
    prompt: refs.automationPrompt.value.trim(),
    enabled: refs.automationEnabled.checked
  };

  try {
    if (state.editingAutomationId) {
      await fetchJson(`/api/automations/${state.editingAutomationId}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
    } else {
      await fetchJson("/api/automations", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    }

    resetAutomationForm();
    await loadState();
  } catch (error) {
    window.alert(error.message);
  }
});

refs.automationResetButton.addEventListener("click", () => {
  resetAutomationForm();
});

refs.automationList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) {
    return;
  }

  const automationId = button.dataset.id;
  const automation = state.app?.automations.find((item) => item.id === automationId);
  if (!automation) {
    return;
  }

  try {
    if (button.dataset.action === "edit") {
      state.editingAutomationId = automationId;
      state.automationDirty = false;
      renderAutomationForm();
      refs.automationName.focus();
      return;
    }

    if (button.dataset.action === "run") {
      await fetchJson(`/api/automations/${automationId}/run`, { method: "POST" });
    }

    if (button.dataset.action === "toggle") {
      await fetchJson(`/api/automations/${automationId}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !automation.enabled })
      });
    }

    if (button.dataset.action === "delete") {
      const confirmed = window.confirm(`Delete automation "${automation.name}"?`);
      if (!confirmed) {
        return;
      }
      await fetchJson(`/api/automations/${automationId}`, { method: "DELETE" });
      if (state.editingAutomationId === automationId) {
        resetAutomationForm();
      }
    }

    await loadState();
  } catch (error) {
    window.alert(error.message);
  }
});

refs.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    state.app = await fetchJson("/api/config", {
      method: "POST",
      body: JSON.stringify({
        openRouterKeys: refs.settingsKeys.value,
        currentModel: refs.settingsModel.value.trim(),
        keyCooldownSeconds: Number(refs.settingsCooldown.value),
        systemPrompt: refs.settingsPrompt.value
      })
    });
    state.settingsDirty = false;
    render();
  } catch (error) {
    window.alert(error.message);
  }
});

[refs.settingsKeys, refs.settingsModel, refs.settingsCooldown, refs.settingsPrompt].forEach((element) => {
  element.addEventListener("input", () => {
    state.settingsDirty = true;
  });
});

[refs.automationName, refs.automationSchedule, refs.automationModel, refs.automationPrompt, refs.automationEnabled].forEach((element) => {
  element.addEventListener("input", () => {
    state.automationDirty = true;
  });
  element.addEventListener("change", () => {
    state.automationDirty = true;
  });
});

await loadState();
setInterval(() => {
  loadState().catch(() => {
    setChatStatus("Refresh failed");
  });
}, 15000);
