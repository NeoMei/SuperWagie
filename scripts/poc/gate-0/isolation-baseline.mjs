#!/usr/bin/env node
// SuperWagie Gate 0 / G0-ISOLATION-001 host interference-source baseline collector.
// Scope: fixture fixed input 1 only (read-only inventory of host Codex Servers,
// global Skills/MCP/config presence). Fixture steps 2-4 (SuperWagie Runtime
// three-scenario zero-diff comparison) require the product Runtime and are
// deferred; results carry decision_hint=CONDITIONAL_GO until then.
// Read-only guarantees:
// - every external command must be in READONLY_ALLOWLIST;
// - config/global paths are probed as metadata only (exists/type/entry-count/mtime),
//   never contents;
// - env vars are recorded as names only, never values;
// - process list records pid+comm only, never arguments.
// Exit codes: 0 = all checks pass, 1 = verification failure, 2 = environment problem.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const fixtureId = argValue("--fixture", "G0-ISOLATION-001");
const evidenceRevision = "solution-b-v1";
const resultsPath = argValue("--results-json", null);
const artifactsDir = argValue("--artifacts-dir", null);

if (process.platform !== "darwin") {
  console.error("ENV-ERROR windows-11-x64 collector variant not implemented yet");
  process.exit(2);
}

const READONLY_ALLOWLIST = ["/bin/ps", "/usr/sbin/lsof"];
const commandsUsed = [];

const startedAt = new Date().toISOString();
const checks = [];
function check(id, passed, detail) {
  checks.push({ id, passed: !!passed, detail: detail || null });
  console.log((passed ? "PASS" : "FAIL") + "  " + id + (passed ? "" : "  -- " + (detail || "")));
  return passed;
}

function runReadonly(argv) {
  commandsUsed.push(argv[0]);
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 20000 });
  return {
    status: r.status,
    stdout: String(r.stdout || ""),
    stderr: String(r.stderr || ""),
    error: r.error ? String(r.error) : null
  };
}

try {
  const snapshot = {
    schema_version: 1,
    kind: "host-interference-baseline",
    captured_at: startedAt,
    platform: { os: process.platform, arch: process.arch, release: os.release() },
    processes: [],
    listeners: [],
    global_paths: [],
    env: { var_names: [], sensitive_names: [] },
    runtime: {
      present: false,
      reason: "SuperWagie Runtime 尚未实现；fixture 步骤2-4（三场景 zero-diff 对比）待 Runtime 实现后执行",
      expected_topology: ["electron_main", "rust_product_core", "private_app_server", "isolated_workers"],
      protected_inputs: ["system_codex_server", "global_skills", "global_mcp", "global_agent_config"],
      signed_runtime_identity_required: true
    }
  };

  // 1. Processes: pid + comm only (no argv, so no secret exposure).
  const ps = runReadonly(["/bin/ps", "-axo", "pid=,comm="]);
  if (ps.status === 0) {
    for (const line of ps.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const sp = trimmed.indexOf(" ");
      if (sp < 0) continue;
      const pid = parseInt(trimmed.slice(0, sp), 10);
      const comm = trimmed.slice(sp + 1).trim();
      if (!Number.isFinite(pid) || !comm) continue;
      snapshot.processes.push({ pid, comm, codex_related: /codex|opencode|superwagie|agentsoul/i.test(comm) });
    }
  }

  // 2. Listening TCP ports.
  const lsof = runReadonly(["/usr/sbin/lsof", "-nP", "-iTCP", "-sTCP:LISTEN"]);
  if (lsof.status === 0) {
    for (const line of lsof.stdout.split("\n")) {
      const t = line.trim().split(/\s+/);
      if (t.length < 2 || t[0] === "COMMAND") continue;
      const addrToken = t.filter(x => /:\d+$/.test(x)).pop();
      if (!addrToken) continue;
      const port = parseInt(addrToken.slice(addrToken.lastIndexOf(":") + 1), 10);
      snapshot.listeners.push({ command: t[0], pid: parseInt(t[1], 10), address: addrToken, port });
    }
  }

  // 3. Global config/skill/MCP paths: metadata only, never contents.
  const home = process.env.HOME || "";
  const candidates = [];
  if (process.env.CODEX_HOME) candidates.push(process.env.CODEX_HOME);
  for (const rel of [".codex", ".codex/skills", ".codex/plugins", ".agents", ".agents/skills", ".claude"]) {
    if (home) candidates.push(path.join(home, rel));
  }
  for (const p of candidates) {
    const entry = { path: p, exists: false };
    try {
      const st = fs.statSync(p);
      entry.exists = true;
      entry.type = st.isDirectory() ? "dir" : "file";
      entry.mtime = st.mtime.toISOString();
      if (st.isDirectory()) {
        entry.top_level_entries = fs.readdirSync(p).length;
      }
    } catch (e) { entry.exists = false; }
    snapshot.global_paths.push(entry);
  }

  // 4. Env variable names only (values never recorded).
  snapshot.env.var_names = Object.keys(process.env).sort();
  snapshot.env.sensitive_names = snapshot.env.var_names.filter(n =>
    /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|CODEX|OPENAI|ANTHROPIC)/i.test(n));

  console.log("INFO processes total=" + snapshot.processes.length +
    " codex_related=" + snapshot.processes.filter(p => p.codex_related).length);
  console.log("INFO listeners=" + snapshot.listeners.length);
  console.log("INFO global_paths existing=" + snapshot.global_paths.filter(p => p.exists).length +
    "/" + snapshot.global_paths.length);
  console.log("INFO env_var_names=" + snapshot.env.var_names.length +
    " sensitive_names=" + snapshot.env.sensitive_names.length);
  console.log("INFO commands_used=" + commandsUsed.length);

  // Checks.
  const sectionsComplete = Array.isArray(snapshot.processes) && snapshot.processes.length > 0 &&
    Array.isArray(snapshot.listeners) &&
    Array.isArray(snapshot.global_paths) && snapshot.global_paths.length > 0 &&
    Array.isArray(snapshot.env.var_names) &&
    snapshot.runtime && typeof snapshot.runtime.present === "boolean";
  check("iso:sections-complete", sectionsComplete,
    sectionsComplete ? null : "one or more inventory sections missing or empty");

  const readOnlyOk = commandsUsed.length > 0 && commandsUsed.every(c => READONLY_ALLOWLIST.includes(c));
  check("iso:read-only-commands", readOnlyOk,
    readOnlyOk ? null : "commands outside allowlist: " +
      commandsUsed.filter(c => !READONLY_ALLOWLIST.includes(c)).join(","));

  const serialized = JSON.stringify(snapshot);
  const SECRET_PATTERNS = [
    /sk-[A-Za-z0-9_-]{8,}/g,
    /ghp_[A-Za-z0-9]{20,}/g,
    /github_pat_[A-Za-z0-9_]{20,}/g,
    /xox[baprs]-[A-Za-z0-9-]{10,}/g,
    /AKIA[0-9A-Z]{16}/g,
    /BEGIN [A-Z ]*PRIVATE KEY/g
  ];
  const hits = [];
  for (const re of SECRET_PATTERNS) {
    const m = serialized.match(re);
    if (m) hits.push(m[0].slice(0, 6) + "...");
  }
  check("iso:no-secrets", hits.length === 0, hits.length === 0 ? null : "secret-like patterns found: " + hits.join(","));

  check("iso:runtime-deferral-recorded",
    snapshot.runtime.present === false && snapshot.runtime.reason.length > 0,
    "scope limitation must be recorded in evidence while Runtime is absent");

  const topologyOk = snapshot.runtime.expected_topology.join(",") ===
    "electron_main,rust_product_core,private_app_server,isolated_workers" &&
    snapshot.runtime.signed_runtime_identity_required === true;
  check("iso:solution-b-topology", topologyOk, snapshot.runtime.expected_topology.join(","));

  const finishedAt = new Date().toISOString();
  const failed = checks.filter(x => !x.passed);
  const results = {
    gate: "gate-0",
    fixture: fixtureId,
    evidence_revision: evidenceRevision,
    scope: "baseline-capture",
    decision_hint: "CONDITIONAL_GO",
    limitation: "已采集固定输入1（主机干扰源只读清单）；fixture 步骤2-4（SuperWagie Runtime 三场景 zero-diff 对比）待 Runtime 实现后执行",
    started_at: startedAt,
    finished_at: finishedAt,
    thresholds: { all_checks_pass: true, zero_diff_comparison: "deferred_until_runtime" },
    pass: failed.length === 0,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    inventory: {
      processes_total: snapshot.processes.length,
      codex_related: snapshot.processes.filter(p => p.codex_related).length,
      listeners: snapshot.listeners.length,
      global_paths_existing: snapshot.global_paths.filter(p => p.exists).length,
      env_var_names: snapshot.env.var_names.length
    },
    checks
  };
  console.log("SUMMARY total=" + results.summary.total + " passed=" + results.summary.passed + " failed=" + results.summary.failed);
  if (hits.length === 0 && artifactsDir) {
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(path.join(artifactsDir, "host-snapshot.json"), JSON.stringify(snapshot, null, 2) + "\n");
  }
  if (resultsPath) {
    fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2) + "\n");
  }
  process.exit(results.pass ? 0 : 1);
} catch (e) {
  console.error("ENV-ERROR " + (e && e.stack ? e.stack : String(e)));
  process.exit(2);
}
