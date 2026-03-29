import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ensureDir, isProbablyBinary, resolveWorkspacePath, truncateText } from "../lib/fs-utils.js";

const execFileAsync = promisify(execFile);
const IGNORED_NAMES = new Set([".git", "node_modules", "dist", "build", ".next"]);

async function walkTextFiles(rootPath, maxFiles = 200) {
  const queue = [rootPath];
  const files = [];

  while (queue.length > 0 && files.length < maxFiles) {
    const current = queue.shift();
    const entries = await fs.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
        if (files.length >= maxFiles) {
          break;
        }
      }
    }
  }

  return files;
}

function serialize(value) {
  return JSON.stringify(value, null, 2);
}

export class ToolService {
  constructor(store) {
    this.store = store;
    this.automationService = null;
  }

  setAutomationService(automationService) {
    this.automationService = automationService;
  }

  async getWorkspaceRoot() {
    const state = await this.store.getState();
    return state.config.workspaceRoot;
  }

  async browseWorkspace(relativePath = ".") {
    const workspaceRoot = await this.getWorkspaceRoot();
    const targetPath = resolveWorkspacePath(workspaceRoot, relativePath);
    const stats = await fs.stat(targetPath);
    const normalizedPath = path.relative(workspaceRoot, targetPath) || ".";

    if (stats.isFile()) {
      return {
        path: normalizedPath,
        type: "file",
        parentPath: path.dirname(normalizedPath) === "." ? "." : path.dirname(normalizedPath),
        entries: []
      };
    }

    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    const items = [];

    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(targetPath, entry.name);
      let entryStats = null;
      try {
        entryStats = await fs.stat(fullPath);
      } catch {
        entryStats = null;
      }

      items.push({
        name: entry.name,
        path: path.relative(workspaceRoot, fullPath) || ".",
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        size: entryStats?.size ?? null,
        modifiedAt: entryStats?.mtime?.toISOString?.() ?? null
      });
    }

    items.sort((left, right) => Number(right.type === "directory") - Number(left.type === "directory") || left.name.localeCompare(right.name));

    const parentPath =
      normalizedPath === "."
        ? null
        : path.dirname(normalizedPath) === "."
          ? "."
          : path.dirname(normalizedPath);

    return {
      path: normalizedPath,
      type: "directory",
      parentPath,
      entries: items
    };
  }

  getToolDefinitions() {
    return [
      {
        type: "function",
        function: {
          name: "list_workspace",
          description: "List files and folders inside the workspace. Use this before writing code so you understand the existing project structure.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path relative to the workspace root." },
              depth: { type: "integer", description: "Directory depth to inspect.", minimum: 0, maximum: 5 }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "inspect_path",
          description: "Check whether a workspace path exists and whether it is a file or directory before editing.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path relative to the workspace root." }
            },
            required: ["path"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a UTF-8 text file from the workspace. Use this to inspect existing code before changing it.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path relative to the workspace root." },
              maxChars: { type: "integer", description: "Maximum characters to return.", minimum: 200, maximum: 50000 }
            },
            required: ["path"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "make_directory",
          description: "Create a directory in the workspace if it does not already exist.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Directory path relative to the workspace root." }
            },
            required: ["path"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "write_file",
          description: "Create or overwrite a text file in the workspace. Parent directories are created automatically.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path relative to the workspace root." },
              content: { type: "string", description: "File contents." }
            },
            required: ["path", "content"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "replace_in_file",
          description: "Replace text inside an existing UTF-8 text file. Use this for targeted edits after reading the file first.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path relative to the workspace root." },
              find: { type: "string", description: "Exact text to find." },
              replace: { type: "string", description: "Replacement text." },
              replaceAll: { type: "boolean", description: "Whether to replace every occurrence instead of just the first one." }
            },
            required: ["path", "find", "replace"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "append_file",
          description: "Append text to a file in the workspace.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path relative to the workspace root." },
              content: { type: "string", description: "Text to append." }
            },
            required: ["path", "content"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "search_workspace",
          description: "Search text files in the workspace for a string.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Literal text to search for." },
              path: { type: "string", description: "Optional relative subdirectory." },
              maxResults: { type: "integer", description: "Maximum number of matches.", minimum: 1, maximum: 100 }
            },
            required: ["query"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "run_command",
          description: "Run a PowerShell command inside the workspace.",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "PowerShell command to execute." },
              cwd: { type: "string", description: "Working directory relative to the workspace root." },
              timeoutSeconds: { type: "integer", description: "Timeout in seconds.", minimum: 1, maximum: 120 }
            },
            required: ["command"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "get_time",
          description: "Get the current local time on the ASTHRA V4 host.",
          parameters: {
            type: "object",
            properties: {}
          }
        }
      },
      {
        type: "function",
        function: {
          name: "list_automations",
          description: "List the currently configured automations.",
          parameters: {
            type: "object",
            properties: {}
          }
        }
      },
      {
        type: "function",
        function: {
          name: "create_automation",
          description: "Create a new automation with a cron schedule.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string" },
              prompt: { type: "string" },
              schedule: { type: "string", description: "Cron expression: minute hour day month weekday" },
              enabled: { type: "boolean" },
              model: { type: "string" }
            },
            required: ["name", "prompt", "schedule"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "update_automation",
          description: "Update an existing automation.",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              prompt: { type: "string" },
              schedule: { type: "string" },
              enabled: { type: "boolean" },
              model: { type: "string" }
            },
            required: ["id"]
          }
        }
      }
    ];
  }

  async executeToolCall(name, args = {}) {
    switch (name) {
      case "list_workspace":
        return this.listWorkspace(args);
      case "inspect_path":
        return this.inspectPath(args);
      case "read_file":
        return this.readFile(args);
      case "make_directory":
        return this.makeDirectory(args);
      case "write_file":
        return this.writeFile(args);
      case "replace_in_file":
        return this.replaceInFile(args);
      case "append_file":
        return this.appendFile(args);
      case "search_workspace":
        return this.searchWorkspace(args);
      case "run_command":
        return this.runCommand(args);
      case "get_time":
        return serialize({ now: new Date().toString(), iso: new Date().toISOString() });
      case "list_automations":
        return this.listAutomations();
      case "create_automation":
        return this.createAutomation(args);
      case "update_automation":
        return this.updateAutomation(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  async listWorkspace({ path: relativePath = ".", depth = 2 } = {}) {
    const workspaceRoot = await this.getWorkspaceRoot();
    const targetPath = resolveWorkspacePath(workspaceRoot, relativePath);
    const lines = [];

    const visit = async (currentPath, currentDepth) => {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });
      entries.sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name));

      for (const entry of entries) {
        if (IGNORED_NAMES.has(entry.name)) {
          continue;
        }

        const fullPath = path.join(currentPath, entry.name);
        const rel = path.relative(workspaceRoot, fullPath) || ".";
        const indent = "  ".repeat(currentDepth);
        lines.push(`${indent}${entry.isDirectory() ? "[dir]" : "[file]"} ${rel}`);

        if (entry.isDirectory() && currentDepth < depth) {
          await visit(fullPath, currentDepth + 1);
        }
      }
    };

    await visit(targetPath, 0);
    return truncateText(lines.join("\n") || "[empty]", 12000);
  }

  async readFile({ path: relativePath, maxChars = 12000 } = {}) {
    const workspaceRoot = await this.getWorkspaceRoot();
    const targetPath = resolveWorkspacePath(workspaceRoot, relativePath);
    const buffer = await fs.readFile(targetPath);

    if (isProbablyBinary(buffer)) {
      throw new Error(`File appears to be binary: ${relativePath}`);
    }

    return truncateText(buffer.toString("utf8"), maxChars);
  }

  async inspectPath({ path: relativePath } = {}) {
    const workspaceRoot = await this.getWorkspaceRoot();
    const targetPath = resolveWorkspacePath(workspaceRoot, relativePath);

    try {
      const stats = await fs.stat(targetPath);
      const summary = {
        path: path.relative(workspaceRoot, targetPath),
        exists: true,
        type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
        size: stats.size,
        modifiedAt: stats.mtime.toISOString()
      };

      if (stats.isDirectory()) {
        const entries = await fs.readdir(targetPath, { withFileTypes: true });
        summary.children = entries
          .slice(0, 40)
          .map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
          }));
      }

      return serialize(summary);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return serialize({
          path: relativePath,
          exists: false
        });
      }

      throw error;
    }
  }

  async makeDirectory({ path: relativePath } = {}) {
    const workspaceRoot = await this.getWorkspaceRoot();
    const targetPath = resolveWorkspacePath(workspaceRoot, relativePath);
    await ensureDir(targetPath);
    return serialize({
      ok: true,
      path: path.relative(workspaceRoot, targetPath)
    });
  }

  async writeFile({ path: relativePath, content } = {}) {
    const workspaceRoot = await this.getWorkspaceRoot();
    const targetPath = resolveWorkspacePath(workspaceRoot, relativePath);
    await ensureDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, content ?? "", "utf8");
    return serialize({ ok: true, path: path.relative(workspaceRoot, targetPath) });
  }

  async replaceInFile({ path: relativePath, find, replace, replaceAll = false } = {}) {
    const workspaceRoot = await this.getWorkspaceRoot();
    const targetPath = resolveWorkspacePath(workspaceRoot, relativePath);
    const buffer = await fs.readFile(targetPath);

    if (isProbablyBinary(buffer)) {
      throw new Error(`File appears to be binary: ${relativePath}`);
    }

    const content = buffer.toString("utf8");
    if (!content.includes(find)) {
      throw new Error(`Text to replace was not found in ${relativePath}`);
    }

    const nextContent = replaceAll ? content.split(find).join(replace) : content.replace(find, replace);
    await fs.writeFile(targetPath, nextContent, "utf8");

    return serialize({
      ok: true,
      path: path.relative(workspaceRoot, targetPath),
      replaced: replaceAll ? content.split(find).length - 1 : 1
    });
  }

  async appendFile({ path: relativePath, content } = {}) {
    const workspaceRoot = await this.getWorkspaceRoot();
    const targetPath = resolveWorkspacePath(workspaceRoot, relativePath);
    await ensureDir(path.dirname(targetPath));
    await fs.appendFile(targetPath, content ?? "", "utf8");
    return serialize({ ok: true, path: path.relative(workspaceRoot, targetPath) });
  }

  async searchWorkspace({ query, path: relativePath = ".", maxResults = 20 } = {}) {
    const workspaceRoot = await this.getWorkspaceRoot();
    const startPath = resolveWorkspacePath(workspaceRoot, relativePath);
    const files = await walkTextFiles(startPath);
    const matches = [];

    for (const filePath of files) {
      if (matches.length >= maxResults) {
        break;
      }

      let buffer;
      try {
        buffer = await fs.readFile(filePath);
      } catch {
        continue;
      }

      if (isProbablyBinary(buffer)) {
        continue;
      }

      const content = buffer.toString("utf8");
      const lines = content.split(/\r?\n/);

      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].includes(query)) {
          matches.push({
            path: path.relative(workspaceRoot, filePath),
            line: index + 1,
            content: truncateText(lines[index], 300)
          });
          if (matches.length >= maxResults) {
            break;
          }
        }
      }
    }

    return serialize({
      query,
      matches
    });
  }

  async runCommand({ command, cwd = ".", timeoutSeconds = 60 } = {}) {
    const workspaceRoot = await this.getWorkspaceRoot();
    const workingDirectory = resolveWorkspacePath(workspaceRoot, cwd);

    try {
      const result = await execFileAsync(
        "powershell",
        ["-NoLogo", "-NoProfile", "-Command", command],
        {
          cwd: workingDirectory,
          timeout: Math.max(1, Math.min(timeoutSeconds, 120)) * 1000,
          maxBuffer: 1024 * 1024
        }
      );

      return serialize({
        ok: true,
        cwd: workingDirectory,
        command,
        stdout: truncateText(result.stdout, 12000),
        stderr: truncateText(result.stderr, 12000)
      });
    } catch (error) {
      return serialize({
        ok: false,
        cwd: workingDirectory,
        command,
        code: error.code ?? null,
        stdout: truncateText(error.stdout ?? "", 12000),
        stderr: truncateText(error.stderr ?? String(error.message ?? error), 12000)
      });
    }
  }

  async listAutomations() {
    if (!this.automationService) {
      throw new Error("Automation service is not attached");
    }

    return serialize(await this.automationService.listAutomations());
  }

  async createAutomation(input) {
    if (!this.automationService) {
      throw new Error("Automation service is not attached");
    }

    const automation = await this.automationService.createAutomation(input);
    return serialize(automation);
  }

  async updateAutomation({ id, ...patch }) {
    if (!this.automationService) {
      throw new Error("Automation service is not attached");
    }

    const automation = await this.automationService.updateAutomation(id, patch);
    return serialize(automation);
  }
}
