import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export function truncateText(value, maxChars = 12000) {
  if (typeof value !== "string") {
    return "";
  }

  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n\n...[truncated ${value.length - maxChars} chars]`;
}

export function isPathInside(basePath, targetPath) {
  const relative = path.relative(basePath, targetPath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function resolveWorkspacePath(workspaceRoot, requestedPath = ".") {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedTarget = path.resolve(resolvedRoot, requestedPath);

  if (resolvedTarget === resolvedRoot) {
    return resolvedTarget;
  }

  if (!isPathInside(resolvedRoot, resolvedTarget)) {
    throw new Error(`Path escapes workspace: ${requestedPath}`);
  }

  return resolvedTarget;
}

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function isProbablyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}
