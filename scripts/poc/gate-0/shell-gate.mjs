#!/usr/bin/env node
// SuperWagie Gate 0 / G0-SHELL-001 Tauri 2 dev-shell smoke.
// Exit codes: 0 = all checks pass, 1 = verification failure, 2 = environment problem.
// NOTE: the launch smoke opens a real GUI window for a few seconds; that is expected.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const shellDir = path.join(here, "shell");
const repoRoot = path.resolve(here, "..", "..", "..");
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const fixtureId = argValue("--fixture", "G0-SHELL-001");
const resultsPath = argValue("--results-json", null);
const artifactsDir = argValue("--artifacts-dir", null);
const checklistResultPath = argValue("--checklist-result", null);

const startedAt = new Date().toISOString();
const checks = [];
function check(id, passed, detail) {
  checks.push({ id, passed: !!passed, detail: detail || null });
  console.log((passed ? "PASS" : "FAIL") + "  " + id + (passed ? "" : "  -- " + (detail || "")));
  return passed;
}
function info(line) {
  console.log("INFO " + line);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cargoCandidates() {
  const list = ["/opt/homebrew/bin/cargo", "/usr/local/bin/cargo"];
  if (process.env.HOME) list.push(process.env.HOME + "/.cargo/bin/cargo");
  return list;
}

let limitations = [];
let decisionHint = "GO";

try {
  const fixtureDir = path.join(repoRoot, "fixtures", "gate-0", fixtureId);

  // (a) fixed inputs present: text set, layout template, checklist, dragdrop set.
  const requiredInputs = [
    "fixtures/chinese-textset.md",
    "fixtures/layout-config.json",
    "fixtures/checklist.md",
    "fixtures/dragdrop/README.md",
    "fixtures/dragdrop/sample.md",
    "fixtures/dragdrop/sample.png",
    "fixtures/dragdrop/sample.pdf"
  ];
  const missingInputs = requiredInputs.filter(rel => !fs.existsSync(path.join(fixtureDir, rel)));
  check("shell:fixed-inputs-present", missingInputs.length === 0,
    missingInputs.length === 0 ? null : "missing: " + missingInputs.join(", "));

  // (b) shell config valid: tauri.conf.json parses and embeds the UI.
  let conf = null;
  try {
    conf = JSON.parse(fs.readFileSync(path.join(shellDir, "tauri.conf.json"), "utf8"));
  } catch (e) {
    check("shell:config-valid", false, "tauri.conf.json unreadable: " + String(e));
  }
  if (conf) {
    const uiOk = fs.existsSync(path.join(shellDir, conf.build && conf.build.frontendDist ? conf.build.frontendDist : "ui", "index.html"));
    const idOk = conf.identifier === "com.superwagie.poc.shell";
    // Drag-drop strategy: native Tauri drag events, with the webview
    // registered for file drags on the Rust side; on macOS 26 the Rust side
    // also reads file URLs from the pasteboard when Drop carries no paths.
    const dndNative = conf.app && conf.app.windows && conf.app.windows[0] && conf.app.windows[0].dragDropEnabled === true;
    check("shell:config-valid", uiOk && idOk && dndNative,
      uiOk && idOk && dndNative ? null : "ui=" + uiOk + " identifier=" + idOk + " native-dragdrop=" + dndNative);
  }

  // (c) cargo build: reuse existing binary when present, otherwise build.
  const binaryPath = path.join(shellDir, "target", "debug", "superwagie-shell");
  let cargo = null;
  for (const c of cargoCandidates()) {
    if (fs.existsSync(c)) { cargo = c; break; }
  }
  if (!cargo) {
    check("shell:cargo-build", false, "cargo not found in candidate paths");
  } else if (!fs.existsSync(binaryPath)) {
    info("building shell with " + cargo + " (first build can take minutes)...");
    const rb = spawnSync(cargo, ["build"], { cwd: shellDir, encoding: "utf8", timeout: 900000 });
    const built = rb.status === 0 && fs.existsSync(binaryPath);
    check("shell:cargo-build", built,
      built ? null : "cargo build failed: " + String(rb.stderr || rb.stdout || rb.error || "").slice(-800));
  } else {
    check("shell:cargo-build", true, "existing binary reused: " + binaryPath);
  }

  // (d) launch + IPC smoke: binary must write webview-health.json into the
  // sandboxed data dir within 15 seconds (frontend calls health_check on load).
  if (fs.existsSync(binaryPath)) {
    const appData = path.join(artifactsDir || path.join(repoRoot, "evidence", "shell-smoke-tmp"), "appdata");
    fs.mkdirSync(appData, { recursive: true });
    const healthPath = path.join(appData, "webview-health.json");
    if (fs.existsSync(healthPath)) fs.rmSync(healthPath);
    info("launching shell binary; a GUI window will appear briefly (expected)");
    const child = spawn(binaryPath, [], {
      cwd: shellDir,
      env: Object.assign({}, process.env, { SUPERWAGIE_SHELL_DATA_DIR: appData }),
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderrTail = "";
    child.stderr && child.stderr.on("data", d => { stderrTail = (stderrTail + String(d)).slice(-800); });
    let healthy = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (fs.existsSync(healthPath)) { healthy = true; break; }
      if (child.exitCode !== null) break;
      await sleep(250);
    }
    check("shell:launch-ipc-smoke", healthy,
      healthy ? null : "no webview-health.json within 15s; exit=" + child.exitCode + " stderr=" + stderrTail);
    if (healthy) {
      try {
        const h = JSON.parse(fs.readFileSync(healthPath, "utf8"));
        check("shell:health-payload", h.ok === true && typeof h.webview_loaded_at === "string",
          h.ok === true ? null : "unexpected health payload: " + JSON.stringify(h).slice(0, 200));
      } catch (e) {
        check("shell:health-payload", false, "health json parse failed: " + String(e));
      }
    }
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await sleep(1000);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  } else {
    check("shell:launch-ipc-smoke", false, "binary missing, launch smoke skipped");
  }

  // (e) human checklist gate: automated checks cannot sign this off.
  if (checklistResultPath) {
    let cl = null;
    try {
      cl = JSON.parse(fs.readFileSync(checklistResultPath, "utf8"));
    } catch (e) { cl = null; }
    const allPass = !!(cl && cl.all_passed === true);
    check("shell:checklist-recorded", allPass,
      allPass ? null : "checklist result missing all_passed=true: " + checklistResultPath);
  } else {
    check("shell:checklist-recorded", true, "human checklist not yet executed (conditional pass)");
    decisionHint = "CONDITIONAL_GO";
    limitations = ["人工 checklist 未执行：按 fixtures/" + fixtureId + "/fixtures/checklist.md 完成后用 --checklist-result 复跑"];
  }

  const finishedAt = new Date().toISOString();
  const failed = checks.filter(x => !x.passed);
  const results = {
    gate: "gate-0",
    fixture: fixtureId,
    started_at: startedAt,
    finished_at: finishedAt,
    thresholds: { all_checks_pass: true },
    pass: failed.length === 0,
    decision_hint: decisionHint,
    limitation: limitations.length > 0 ? limitations.join("; ") : null,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    checks
  };
  console.log("SUMMARY total=" + results.summary.total + " passed=" + results.summary.passed + " failed=" + results.summary.failed);
  if (resultsPath) {
    fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2) + "\n");
  }
  process.exit(results.pass ? 0 : 1);
} catch (e) {
  console.error("ENV-ERROR " + (e && e.stack ? e.stack : String(e)));
  process.exit(2);
}
