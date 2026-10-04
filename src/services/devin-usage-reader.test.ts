import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { aggregateDevinUsage, parseDevinPrices, LocalDevinUsageReader, type DevinUsageRow } from "./devin-usage-reader.js";

const catalog = JSON.stringify({ families: [{ variants: [
  { model_uid: "claude-opus-5-5-medium", cost_summary: "$4 / 1M Input · $0.2 / 1M Cached input · $20 / 1M Output" },
  { model_uid: "swe-2-high", cost_tier: "Free" },
  { model_uid: "missing", cost_tier: "High cost" }
] }] });
function row(request: string, model = "claude-opus-5-5-medium", date = new Date(2026,8,29,12).toISOString()): DevinUsageRow {
  return { session_id: "session", node_id: 1, created_at: Date.parse(date)/1000,
    metadata: JSON.stringify({ request_id: request, generation_model: model, created_at: date,
      metrics: { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 3000, cache_creation_tokens: 4000 } }) };
}
test("Devin deduplicates saved copies across sessions and prices input/output/cache separately", () => {
  const a = row("request-1");
  const result = aggregateDevinUsage([a, { ...a, node_id: 2 }, { ...a, session_id: "fork" }, row("request-2")], parseDevinPrices(catalog));
  assert.equal(result.length, 1);
  assert.equal(result[0]?.totalTokens, 16400);
  assert.ok(Math.abs(result[0]!.totalCost! - 0.0572) < 1e-10);
});
test("Devin keeps different calls/days and distinguishes free from unknown pricing", () => {
  const result = aggregateDevinUsage([row("a", "swe-2-high"), row("b", "missing", new Date(2026,8,30,0,1).toISOString())], parseDevinPrices(catalog));
  assert.equal(result[0]?.date, "2026-09-29");
  assert.equal(result[0]?.totalCost, 0);
  assert.equal(result[1]?.date, "2026-09-30");
  assert.equal(result[1]?.totalCost, null);
  assert.equal(result[1]?.totalTokens, 8200);
});
test("Devin missing prices preserve tokens and mixed totals remain explicitly unknown", () => {
  const result = aggregateDevinUsage([row("a"), row("b", "unpriced"), { ...row("broken"), metadata: "invalid" }], parseDevinPrices(catalog));
  assert.equal(result[0]?.totalTokens, 16400);
  assert.equal(result[0]?.totalCost, null);
  assert.ok(result[0]?.topModels.some(m => m.cost !== null));
});
test("Devin opens real SQLite read-only and returns usage even if CLI price lookup fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "devin-usage-"));
  const path = join(root, "sessions.db");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE message_nodes (row_id INTEGER, session_id TEXT, node_id INTEGER, created_at INTEGER, chat_message TEXT)");
  const entry = row("a");
  const insert = db.prepare("INSERT INTO message_nodes VALUES (?, ?, ?, ?, ?)");
  insert.run(1, entry.session_id, entry.node_id, entry.created_at, JSON.stringify({role:"assistant", metadata:JSON.parse(entry.metadata)}));
  insert.run(2, entry.session_id, 2, entry.created_at, JSON.stringify({role:"user", metadata:JSON.parse(entry.metadata)}));
  db.close();
  try {
    const reader = new LocalDevinUsageReader({ database:path, command:"/missing-devin", cacheMs:1000 });
    const result = await reader.readDaily();
    assert.equal(result?.[0]?.totalTokens, 8200);
    assert.equal(result?.[0]?.totalCost, null);
    assert.equal(await reader.readDaily(), result);
    const missing = new LocalDevinUsageReader({ database:join(root,"missing.db"), command:"/missing-devin", cacheMs:1000 });
    assert.equal(await missing.readDaily(), null);
  } finally { await rm(root, {recursive:true, force:true}); }
});
