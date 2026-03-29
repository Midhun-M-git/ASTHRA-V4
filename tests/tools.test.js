import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { AsthraStore } from "../src/storage/store.js";
import { ToolService } from "../src/services/tools.js";

async function createToolService() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "asthra-tools-"));
  const store = new AsthraStore(path.join(tempDir, "state.json"), tempDir);
  await store.init();
  return {
    tempDir,
    toolService: new ToolService(store)
  };
}

test("write_file creates nested folders and inspect_path sees the result", async () => {
  const { toolService } = await createToolService();

  await toolService.writeFile({
    path: "src/features/demo/index.js",
    content: "export const value = 1;\n"
  });

  const inspection = JSON.parse(
    await toolService.inspectPath({
      path: "src/features/demo/index.js"
    })
  );

  assert.equal(inspection.exists, true);
  assert.equal(inspection.type, "file");
});

test("replace_in_file updates an existing text file", async () => {
  const { toolService } = await createToolService();

  await toolService.writeFile({
    path: "src/app.js",
    content: "const mode = 'draft';\n"
  });

  const result = JSON.parse(
    await toolService.replaceInFile({
      path: "src/app.js",
      find: "'draft'",
      replace: "'ready'"
    })
  );

  assert.equal(result.ok, true);

  const content = await toolService.readFile({
    path: "src/app.js"
  });

  assert.match(content, /'ready'/);
});

test("make_directory and browseWorkspace expose new folders for the explorer", async () => {
  const { toolService } = await createToolService();

  await toolService.makeDirectory({
    path: "src/components/forms"
  });

  const workspace = await toolService.browseWorkspace("src/components");

  assert.equal(workspace.type, "directory");
  assert.equal(workspace.path.replaceAll("\\", "/"), "src/components");
  assert.deepEqual(
    workspace.entries.map((entry) => ({
      name: entry.name,
      path: entry.path.replaceAll("\\", "/"),
      type: entry.type
    })),
    [
      {
        name: "forms",
        path: "src/components/forms",
        type: "directory"
      }
    ]
  );
});
