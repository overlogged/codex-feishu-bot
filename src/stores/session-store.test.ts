import assert from "node:assert/strict";
import test from "node:test";

import { SessionStore } from "./session-store.js";

test("SessionStore only updates the currently bound run", () => {
  const store = new SessionStore();

  store.save({
    chatId: "oc_group_1",
    threadId: "thread_old",
    cli: "codex",
    workspaceId: "/home/overlogged/Quant",
    activeRunId: "run_old",
    activeTurnId: "turn_old",
    updatedAt: new Date().toISOString()
  });

  store.bindTurn("oc_group_1", "turn_should_ignore", "run_other");
  store.updateBoundRun("oc_group_1", "run_other", {
    threadId: "thread_should_ignore"
  });
  store.releaseRun("oc_group_1", "run_other");

  assert.equal(store.get("oc_group_1")?.threadId, "thread_old");
  assert.equal(store.get("oc_group_1")?.activeRunId, "run_old");
  assert.equal(store.get("oc_group_1")?.activeTurnId, "turn_old");

  store.updateBoundRun("oc_group_1", "run_old", {
    threadId: "thread_updated"
  });
  store.bindTurn("oc_group_1", "turn_updated", "run_old");
  store.releaseRun("oc_group_1", "run_old");

  assert.equal(store.get("oc_group_1")?.threadId, "thread_updated");
  assert.equal(store.get("oc_group_1")?.activeRunId, undefined);
  assert.equal(store.get("oc_group_1")?.activeTurnId, undefined);
});
