#!/bin/sh
# SuperWagie unified PoC runner (see docs/技术可行性/技术验证执行计划.md §2).
# Usage: run-gate.sh <gate-id> --platform <platform-id> [--fixture <fixture-id>]
# Exit: 0 pass, 1 verification failed, 2 environment/args problem.
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

usage() {
  echo "usage: run-gate.sh <gate-id> --platform <macos-15-arm64|windows-11-x64> [--fixture <fixture-id>] [--candidate-root <absolute-dir>] [--evaluation-result <absolute-json>] [--collector-receipt <absolute-json>] [--superwriter-root <absolute-dir>] [--checklist-result <json>] [--review-checklist <json>] [--wps-python <absolute>] [--wpscomposer-root <absolute>] [--wps-application <absolute>] [--wps-node <absolute>] [--wps-home <absolute>] [--machine-profile <absolute>] [--scenario <id>] [--scenario-attestation <absolute>] [--baseline-results <absolute>] [--isolation-result <absolute>] [--isolation-evidence-root <absolute>] [--obsidian-vault <vault-dir>]" >&2
  exit 2
}

[ $# -ge 1 ] || usage
GATE_ID=$1
shift

PLATFORM=""
FIXTURE=""
CHECKLIST_RESULT=""
EVALUATION_RESULT=""
COLLECTOR_RECEIPT=""
SUPERWRITER_ROOT=""
CANDIDATE_ROOT=""
OBSIDIAN_VAULT=""
WPS_PYTHON=""
WPSCOMPOSER_ROOT=""
WPS_APPLICATION=""
WPS_NODE=""
WPS_HOME=""
REVIEW_CHECKLIST=""
SCENARIO=""
MACHINE_PROFILE=""
SCENARIO_ATTESTATION=""
BASELINE_RESULTS=""
ISOLATION_RESULT=""
ISOLATION_EVIDENCE_ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --platform)
      [ $# -ge 2 ] || usage
      PLATFORM=$2
      shift 2
      ;;
    --fixture)
      [ $# -ge 2 ] || usage
      FIXTURE=$2
      shift 2
      ;;
    --checklist-result)
      [ $# -ge 2 ] || usage
      CHECKLIST_RESULT=$2
      shift 2
      ;;
    --evaluation-result)
      [ $# -ge 2 ] || usage
      EVALUATION_RESULT=$2
      shift 2
      ;;
    --collector-receipt)
      [ $# -ge 2 ] || usage
      COLLECTOR_RECEIPT=$2
      shift 2
      ;;
    --superwriter-root)
      [ $# -ge 2 ] || usage
      SUPERWRITER_ROOT=$2
      shift 2
      ;;
    --candidate-root)
      [ $# -ge 2 ] || usage
      CANDIDATE_ROOT=$2
      shift 2
      ;;
    --review-checklist)
      [ $# -ge 2 ] || usage
      REVIEW_CHECKLIST=$2
      shift 2
      ;;
    --wps-python)
      [ $# -ge 2 ] || usage
      WPS_PYTHON=$2
      shift 2
      ;;
    --wpscomposer-root)
      [ $# -ge 2 ] || usage
      WPSCOMPOSER_ROOT=$2
      shift 2
      ;;
    --wps-application)
      [ $# -ge 2 ] || usage
      WPS_APPLICATION=$2
      shift 2
      ;;
    --wps-node)
      [ $# -ge 2 ] || usage
      WPS_NODE=$2
      shift 2
      ;;
    --wps-home)
      [ $# -ge 2 ] || usage
      WPS_HOME=$2
      shift 2
      ;;
    --scenario)
      [ $# -ge 2 ] || usage
      SCENARIO=$2
      shift 2
      ;;
    --machine-profile)
      [ $# -ge 2 ] || usage
      MACHINE_PROFILE=$2
      shift 2
      ;;
    --scenario-attestation)
      [ $# -ge 2 ] || usage
      SCENARIO_ATTESTATION=$2
      shift 2
      ;;
    --baseline-results)
      [ $# -ge 2 ] || usage
      BASELINE_RESULTS=$2
      shift 2
      ;;
    --isolation-result)
      [ $# -ge 2 ] || usage
      ISOLATION_RESULT=$2
      shift 2
      ;;
    --isolation-evidence-root)
      [ $# -ge 2 ] || usage
      ISOLATION_EVIDENCE_ROOT=$2
      shift 2
      ;;
    --obsidian-vault)
      [ $# -ge 2 ] || usage
      OBSIDIAN_VAULT=$2
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done
[ -n "$PLATFORM" ] || usage
[ -z "$REVIEW_CHECKLIST" ] || [ -z "$CHECKLIST_RESULT" ] || { echo "ERROR use only one checklist option" >&2; exit 2; }
[ -n "$REVIEW_CHECKLIST" ] || REVIEW_CHECKLIST=$CHECKLIST_RESULT

if [ "$GATE_ID" = "gvp-0" ]; then
  [ -z "$CHECKLIST_RESULT$EVALUATION_RESULT$COLLECTOR_RECEIPT$SUPERWRITER_ROOT$OBSIDIAN_VAULT$WPS_PYTHON$WPSCOMPOSER_ROOT$WPS_APPLICATION$WPS_NODE$WPS_HOME$REVIEW_CHECKLIST$SCENARIO$MACHINE_PROFILE$SCENARIO_ATTESTATION$BASELINE_RESULTS$ISOLATION_RESULT$ISOLATION_EVIDENCE_ROOT" ] || {
    echo "ERROR gvp-0 accepts only --platform, --fixture, and --candidate-root" >&2
    exit 2
  }
fi

require_absolute_path() {
  value=$1
  label=$2
  case "$value" in
    ""|/*|[A-Za-z]:[\\/]*) ;;
    *) echo "ERROR $label must be an absolute path" >&2; exit 2 ;;
  esac
}
require_absolute_path "$WPS_PYTHON" "--wps-python"
require_absolute_path "$WPSCOMPOSER_ROOT" "--wpscomposer-root"
require_absolute_path "$WPS_APPLICATION" "--wps-application"
require_absolute_path "$WPS_NODE" "--wps-node"
require_absolute_path "$WPS_HOME" "--wps-home"
require_absolute_path "$REVIEW_CHECKLIST" "--review-checklist"
require_absolute_path "$EVALUATION_RESULT" "--evaluation-result"
require_absolute_path "$COLLECTOR_RECEIPT" "--collector-receipt"
require_absolute_path "$SUPERWRITER_ROOT" "--superwriter-root"
require_absolute_path "$CANDIDATE_ROOT" "--candidate-root"
require_absolute_path "$MACHINE_PROFILE" "--machine-profile"
require_absolute_path "$SCENARIO_ATTESTATION" "--scenario-attestation"
require_absolute_path "$BASELINE_RESULTS" "--baseline-results"
require_absolute_path "$ISOLATION_RESULT" "--isolation-result"
require_absolute_path "$ISOLATION_EVIDENCE_ROOT" "--isolation-evidence-root"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) HOST_PLATFORM=macos-15-arm64 ;;
  Darwin-x86_64) echo "ERROR unsupported host: macos-x64" >&2; exit 2 ;;
  MINGW*|MSYS*|CYGWIN*) HOST_PLATFORM=windows-11-x64 ;;
  *) echo "ERROR unsupported host: $(uname -s)-$(uname -m)" >&2; exit 2 ;;
esac

if [ "$PLATFORM" != "$HOST_PLATFORM" ]; then
  echo "ERROR platform mismatch: requested=$PLATFORM host=$HOST_PLATFORM" >&2
  exit 2
fi

if [ "$GATE_ID" = "contract-foundation" ] && [ -z "$FIXTURE" ]; then
  FIXTURE=CF-PROTOCOL-002
fi

EV=$(node "$REPO_ROOT/scripts/poc/evidence-run-init.mjs" \
  --evidence-root "$REPO_ROOT/evidence" \
  --gate "$GATE_ID" \
  --fixture "$FIXTURE" \
  --platform "$PLATFORM" \
  --release "$(uname -r)") || exit 2
RUN_ID=${EV##*/}

node "$REPO_ROOT/scripts/poc/gate-3/runner-evidence.mjs" redact-command-file "$EV/command.txt" \
  "$GATE_ID" "$PLATFORM" "$FIXTURE" "$WPS_PYTHON" "$WPSCOMPOSER_ROOT" "$WPS_APPLICATION" "$WPS_NODE" "$WPS_HOME" "$REVIEW_CHECKLIST" "$BASELINE_RESULTS" "$MACHINE_PROFILE" "$SCENARIO_ATTESTATION" "$ISOLATION_RESULT" "$ISOLATION_EVIDENCE_ROOT" "$EVALUATION_RESULT" "$CANDIDATE_ROOT" || exit 2

RC=0
case "$GATE_ID" in
  gvp-0)
    if [ "$FIXTURE" != "GVP-0-CORE-001" ]; then
      echo "ERROR gvp-0 requires --fixture GVP-0-CORE-001" >&2
      exit 2
    fi
    if [ -z "$CANDIDATE_ROOT" ]; then
      echo "ERROR gvp-0 requires --candidate-root" >&2
      exit 2
    fi
    GVP0_DIR="$REPO_ROOT/scripts/poc/universal-viewer"
    if [ ! -f "$GVP0_DIR/gvp-0-gate.mjs" ]; then
      echo "ERROR executor missing: $GVP0_DIR/gvp-0-gate.mjs" >&2
      exit 2
    fi
    node "$GVP0_DIR/gvp-0-gate.mjs" --platform "$PLATFORM" --fixture "$FIXTURE" \
      --candidate-root "$CANDIDATE_ROOT" --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
      > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
    ;;
  gvp-1|gvp-2|gvp-3|gvp-4|gvp-5)
    echo "ERROR $GATE_ID is registered but not executable; it remains RESEARCH_REQUIRED" >&2
    exit 2
    ;;
  contract-foundation)
    CF_DIR="$REPO_ROOT/scripts/poc/contract-foundation"
    if [ ! -d "$CF_DIR/node_modules/ajv" ]; then
      echo "ERROR ajv not installed. Run: cd $CF_DIR && npm install" >&2
      exit 2
    fi
    (cd "$CF_DIR" && node validate.mjs --fixture "$FIXTURE" --results-json "$EV/results.json") \
      > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
    ;;
  gate-0)
    if [ -z "$FIXTURE" ]; then
      echo "ERROR gate-0 requires --fixture" >&2
      exit 2
    fi
    G0_DIR="$REPO_ROOT/scripts/poc/gate-0"
    case "$FIXTURE" in
      G0-DEPS-001)
        if [ ! -f "$G0_DIR/deps-gate.mjs" ]; then
          echo "ERROR executor missing: $G0_DIR/deps-gate.mjs" >&2
          exit 2
        fi
        if [ -n "$CANDIDATE_ROOT" ]; then
          node "$G0_DIR/deps-gate.mjs" --fixture "$FIXTURE" --results-json "$EV/results.json" \
            --candidate-root "$CANDIDATE_ROOT" > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        else
          node "$G0_DIR/deps-gate.mjs" --fixture "$FIXTURE" --results-json "$EV/results.json" \
            > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        fi
        ;;
      G0-ISOLATION-001)
        if [ ! -f "$G0_DIR/isolation-baseline.mjs" ]; then
          echo "ERROR executor missing: $G0_DIR/isolation-baseline.mjs" >&2
          exit 2
        fi
        node "$G0_DIR/isolation-baseline.mjs" --fixture "$FIXTURE" --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
          > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        ;;
      G0-SHELL-002)
        node "$REPO_ROOT/scripts/poc/environment-gate.mjs" --gate "$GATE_ID" \
          --fixture "$FIXTURE" --platform "$PLATFORM" --results-json "$EV/results.json" \
          > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        ;;
      *)
        echo "ERROR fixture not implemented for gate-0: $FIXTURE (see fixtures/gate-0/$FIXTURE/README.md)" >&2
        exit 2
        ;;
    esac
    ;;
  gate-1)
    if [ -z "$FIXTURE" ]; then
      echo "ERROR gate-1 requires --fixture" >&2
      exit 2
    fi
    G1_DIR="$REPO_ROOT/scripts/poc/gate-1"
    case "$FIXTURE" in
      G1-WORKSPACE-001)
        if [ ! -f "$G1_DIR/workspace-gate.mjs" ]; then
          echo "ERROR executor missing: $G1_DIR/workspace-gate.mjs" >&2
          exit 2
        fi
        node "$G1_DIR/workspace-gate.mjs" --fixture "$FIXTURE" --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
          > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        ;;
      G1-CRASH-001)
        if [ ! -f "$G1_DIR/crash-gate.mjs" ]; then
          echo "ERROR executor missing: $G1_DIR/crash-gate.mjs" >&2
          exit 2
        fi
        node "$G1_DIR/crash-gate.mjs" --fixture "$FIXTURE" --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
          > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        ;;
      G1-MARKDOWN-001)
        if [ ! -f "$G1_DIR/markdown-gate.mjs" ]; then
          echo "ERROR executor missing: $G1_DIR/markdown-gate.mjs" >&2
          exit 2
        fi
        if [ -n "$CHECKLIST_RESULT" ] && [ -n "$OBSIDIAN_VAULT" ]; then
          node "$G1_DIR/markdown-gate.mjs" --fixture "$FIXTURE" --platform "$PLATFORM" --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" --checklist-result "$CHECKLIST_RESULT" --obsidian-vault "$OBSIDIAN_VAULT" \
            > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        elif [ -n "$CHECKLIST_RESULT" ]; then
          node "$G1_DIR/markdown-gate.mjs" --fixture "$FIXTURE" --platform "$PLATFORM" --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" --checklist-result "$CHECKLIST_RESULT" \
            > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        elif [ -n "$OBSIDIAN_VAULT" ]; then
          node "$G1_DIR/markdown-gate.mjs" --fixture "$FIXTURE" --platform "$PLATFORM" --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" --obsidian-vault "$OBSIDIAN_VAULT" \
            > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        else
          node "$G1_DIR/markdown-gate.mjs" --fixture "$FIXTURE" --platform "$PLATFORM" --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
            > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        fi
        ;;
      G1-TASK-001)
        if [ ! -f "$G1_DIR/task-gate.mjs" ]; then
          echo "ERROR executor missing: $G1_DIR/task-gate.mjs" >&2
          exit 2
        fi
        node "$G1_DIR/task-gate.mjs" --fixture "$FIXTURE" --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
          > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        ;;
      G1-DIAGRAM-001)
        if [ ! -f "$G1_DIR/diagram-gate.mjs" ]; then
          echo "ERROR executor missing: $G1_DIR/diagram-gate.mjs" >&2
          exit 2
        fi
        node "$G1_DIR/diagram-gate.mjs" --fixture "$FIXTURE" --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
          > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        ;;
      *)
        echo "ERROR fixture not implemented for gate-1: $FIXTURE (see fixtures/gate-1/$FIXTURE/README.md)" >&2
        exit 2
        ;;
    esac
    ;;
  gate-2)
    if [ -z "$FIXTURE" ]; then
      echo "ERROR gate-2 requires --fixture" >&2
      exit 2
    fi
    G2_DIR="$REPO_ROOT/scripts/poc/gate-2"
    case "$FIXTURE" in
      G2-THREAD-001)
        if [ ! -f "$G2_DIR/thread-gate.mjs" ]; then
          echo "ERROR executor missing: $G2_DIR/thread-gate.mjs" >&2
          exit 2
        fi
        node "$G2_DIR/thread-gate.mjs" --fixture "$FIXTURE" --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
          > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        ;;
      G2-AGENT-001)
        if [ ! -f "$G2_DIR/agent-gate.mjs" ]; then
          echo "ERROR executor missing: $G2_DIR/agent-gate.mjs" >&2
          exit 2
        fi
        if [ -n "$REVIEW_CHECKLIST" ]; then
          node "$G2_DIR/agent-gate.mjs" --fixture "$FIXTURE" --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" --evaluation-result "$REVIEW_CHECKLIST" \
            > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        else
          node "$G2_DIR/agent-gate.mjs" --fixture "$FIXTURE" --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
            > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        fi
        ;;
      G2-WORKFLOW-001)
        if [ ! -f "$G2_DIR/workflow-gate.mjs" ]; then
          echo "ERROR executor missing: $G2_DIR/workflow-gate.mjs" >&2
          exit 2
        fi
        node "$G2_DIR/workflow-gate.mjs" --fixture "$FIXTURE" --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
          > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        ;;
      G2-HOST-001)
        if [ ! -f "$G2_DIR/host-gate.mjs" ]; then
          echo "ERROR executor missing: $G2_DIR/host-gate.mjs" >&2
          exit 2
        fi
        node "$G2_DIR/host-gate.mjs" --fixture "$FIXTURE" --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
          > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        ;;
      G2-CONTINUITY-001)
        if [ ! -f "$G2_DIR/continuity-gate.mjs" ]; then
          echo "ERROR executor missing: $G2_DIR/continuity-gate.mjs" >&2
          exit 2
        fi
        node "$G2_DIR/continuity-gate.mjs" --fixture "$FIXTURE" --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
          > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        ;;
      *)
        echo "ERROR fixture not implemented for gate-2: $FIXTURE (see fixtures/gate-2/$FIXTURE/README.md)" >&2
        exit 2
        ;;
    esac
    ;;
  gate-3)
    if [ -z "$FIXTURE" ]; then
      echo "ERROR gate-3 requires --fixture" >&2
      exit 2
    fi
    G3_DIR="$REPO_ROOT/scripts/poc/gate-3"
    case "$FIXTURE" in
      G3-PPT-001)
        if [ ! -f "$G3_DIR/ppt-gate.mjs" ]; then
          echo "ERROR executor missing: $G3_DIR/ppt-gate.mjs" >&2
          exit 2
        fi
        node "$G3_DIR/ppt-gate.mjs" --fixture "$FIXTURE" --platform "$PLATFORM" \
          --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
          --candidate-root "$CANDIDATE_ROOT" \
          > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        ;;
      G3-PPT-WPS-MACOS-SMOKE-001)
        if [ ! -f "$G3_DIR/ppt-wps-smoke-gate.mjs" ]; then
          echo "ERROR executor missing: $G3_DIR/ppt-wps-smoke-gate.mjs" >&2
          exit 2
        fi
        if [ -z "$EVALUATION_RESULT" ]; then
          echo "ERROR $FIXTURE requires --evaluation-result" > "$EV/stderr.log"
          node -e "const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({schema_version:1,gate:'gate-3-subprobe',parent_gate:'gate-3',fixture:process.argv[2],pass:false,status:'blocked',decision_hint:'BLOCKED_ENVIRONMENT',reasons:['REAL_WPS_EVALUATION_REQUIRED']},null,2)+'\n')" "$EV/results.json" "$FIXTURE"
          RC=2
        else
          node "$G3_DIR/ppt-wps-smoke-gate.mjs" --fixture "$FIXTURE" --platform "$PLATFORM" \
            --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
            --evaluation-result "$EVALUATION_RESULT" \
            > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        fi
        ;;
      G3-WRITER-001)
        if [ ! -f "$G3_DIR/writer-gate.mjs" ]; then
          echo "ERROR executor missing: $G3_DIR/writer-gate.mjs" >&2
          exit 2
        fi
        if [ -n "$EVALUATION_RESULT" ]; then
          if [ -n "$COLLECTOR_RECEIPT" ] && [ -n "$SUPERWRITER_ROOT" ] && [ -n "$WPSCOMPOSER_ROOT" ]; then
            node "$G3_DIR/writer-gate.mjs" --fixture "$FIXTURE" --platform "$PLATFORM" \
              --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
              --evaluation-result "$EVALUATION_RESULT" --collector-receipt "$COLLECTOR_RECEIPT" \
              --superwriter-root "$SUPERWRITER_ROOT" --wpscomposer-root "$WPSCOMPOSER_ROOT" \
              > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
          else
            node "$G3_DIR/writer-gate.mjs" --fixture "$FIXTURE" --platform "$PLATFORM" \
              --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
              --evaluation-result "$EVALUATION_RESULT" \
              > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
          fi
        else
          node "$G3_DIR/writer-gate.mjs" --fixture "$FIXTURE" --platform "$PLATFORM" \
            --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
            > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        fi
        ;;
      G3-HTML-001)
        if [ ! -f "$G3_DIR/html-gate.mjs" ]; then
          echo "ERROR executor missing: $G3_DIR/html-gate.mjs" >&2
          exit 2
        fi
        if [ -n "$EVALUATION_RESULT" ]; then
          node "$G3_DIR/html-gate.mjs" --fixture "$FIXTURE" --platform "$PLATFORM" \
            --fixture-root "$REPO_ROOT/fixtures/gate-3/$FIXTURE" \
            --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
            --evaluation-result "$EVALUATION_RESULT" \
            > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        else
          node "$G3_DIR/html-gate.mjs" --fixture "$FIXTURE" --platform "$PLATFORM" \
            --fixture-root "$REPO_ROOT/fixtures/gate-3/$FIXTURE" \
            --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
            > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        fi
        ;;
      G3-REVIEW-001)
        node "$REPO_ROOT/scripts/poc/environment-gate.mjs" --gate "$GATE_ID" \
          --fixture "$FIXTURE" --platform "$PLATFORM" --results-json "$EV/results.json" \
          > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        ;;
      G3-REVIEW-002)
        node "$REPO_ROOT/scripts/poc/environment-gate.mjs" --gate "$GATE_ID" \
          --fixture "$FIXTURE" --platform "$PLATFORM" --results-json "$EV/results.json" \
          > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        ;;
      *)
        echo "ERROR fixture not implemented for gate-3: $FIXTURE" > "$EV/stderr.log"
        node -e "const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({schema_version:1,gate:'gate-3',fixture:process.argv[2],pass:false,status:'blocked',decision_hint:'BLOCKED_ENVIRONMENT',reasons:['UNKNOWN_FIXTURE']},null,2)+'\n')" "$EV/results.json" "$FIXTURE"
        RC=2
        ;;
    esac
    ;;
  gate-4)
    if [ -z "$FIXTURE" ]; then
      echo "ERROR gate-4 requires --fixture" >&2
      exit 2
    fi
    G4_DIR="$REPO_ROOT/scripts/poc/gate-4"
    case "$FIXTURE" in
      G4-VIDEO-001|G4-VIDEO-002|G4-VIDEO-003|G4-VIDEO-004|G4-VIDEO-005)
        if [ ! -f "$G4_DIR/video-gate.mjs" ]; then
          echo "ERROR executor missing: $G4_DIR/video-gate.mjs" >&2
          exit 2
        fi
        if [ -n "$EVALUATION_RESULT" ]; then
          node "$G4_DIR/video-gate.mjs" --fixture "$FIXTURE" --platform "$PLATFORM" \
            --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
            --evaluation-result "$EVALUATION_RESULT" \
            > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        else
          node "$G4_DIR/video-gate.mjs" --fixture "$FIXTURE" --platform "$PLATFORM" \
            --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
            > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        fi
        ;;
      *)
        echo "ERROR fixture not implemented for gate-4: $FIXTURE" >&2
        exit 2
        ;;
    esac
    ;;
  gate-5)
    if [ -z "$FIXTURE" ]; then
      echo "ERROR gate-5 requires --fixture" >&2
      exit 2
    fi
    G5_DIR="$REPO_ROOT/scripts/poc/gate-5"
    case "$FIXTURE" in
      G5-EXT-001)
        if [ ! -f "$G5_DIR/ext-gate.mjs" ]; then
          echo "ERROR executor missing: $G5_DIR/ext-gate.mjs" >&2
          exit 2
        fi
        node "$G5_DIR/ext-gate.mjs" --fixture "$FIXTURE" --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
          > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        ;;
      G5-ATTACK-001)
        if [ ! -f "$G5_DIR/attack-gate.mjs" ]; then
          echo "ERROR executor missing: $G5_DIR/attack-gate.mjs" >&2
          exit 2
        fi
        node "$G5_DIR/attack-gate.mjs" --fixture "$FIXTURE" --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
          > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        ;;
      G5-FACADE-001)
        if [ ! -f "$G5_DIR/facade-gate.mjs" ]; then
          echo "ERROR executor missing: $G5_DIR/facade-gate.mjs" >&2
          exit 2
        fi
        node "$G5_DIR/facade-gate.mjs" --fixture "$FIXTURE" --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
          > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        ;;
      G5-MEMORY-001)
        if [ ! -f "$G5_DIR/memory-gate.mjs" ]; then
          echo "ERROR executor missing: $G5_DIR/memory-gate.mjs" >&2
          exit 2
        fi
        node "$G5_DIR/memory-gate.mjs" --fixture "$FIXTURE" --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
          > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        ;;
      G5-CONNECTOR-001)
        node "$REPO_ROOT/scripts/poc/environment-gate.mjs" --gate "$GATE_ID" \
          --fixture "$FIXTURE" --platform "$PLATFORM" --results-json "$EV/results.json" \
          > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        ;;
      *)
        echo "ERROR fixture not implemented for gate-5: $FIXTURE (see fixtures/gate-5/$FIXTURE/README.md)" >&2
        exit 2
        ;;
    esac
    ;;
  gate-6)
    if [ -z "$FIXTURE" ]; then
      echo "ERROR gate-6 requires --fixture" >&2
      exit 2
    fi
    case "$FIXTURE" in
      G6-BILLING-001|G6-PACKAGE-001)
        node "$REPO_ROOT/scripts/poc/environment-gate.mjs" --gate "$GATE_ID" \
          --fixture "$FIXTURE" --platform "$PLATFORM" --results-json "$EV/results.json" \
          > "$EV/stdout.log" 2> "$EV/stderr.log" || RC=$?
        ;;
      *)
        echo "ERROR fixture not implemented for gate-6: $FIXTURE" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    echo "ERROR unknown gate-id: $GATE_ID" >&2
    exit 2
    ;;
esac

node -e "
const fs = require('fs');
const ev = process.argv[1];
const m = JSON.parse(fs.readFileSync(ev + '/manifest.json', 'utf8'));
m.finished_at = new Date().toISOString();
let pass = process.argv[2] === '0';
let decision = pass ? 'GO' : 'NO_GO';
let limitation = null;
let evidenceSha256 = null;
let reportedGate = m.gate;
let parentGate = null;
let admissionEffect = null;
if (fs.existsSync(ev + '/results.json')) {
  evidenceSha256 = 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(ev + '/results.json')).digest('hex');
  const r = JSON.parse(fs.readFileSync(ev + '/results.json', 'utf8'));
  if (typeof r.gate_id === 'string' && r.gate_id) reportedGate = r.gate_id;
  if (typeof r.verdict === 'string' && ['GO', 'CONDITIONAL_GO', 'NO_GO', 'BLOCKED_ENVIRONMENT'].includes(r.verdict)) {
    decision = r.verdict;
    pass = r.verdict === 'GO';
  }
  if (typeof r.gate === 'string' && r.gate) reportedGate = r.gate;
  if (typeof r.parent_gate === 'string' && r.parent_gate) parentGate = r.parent_gate;
  if (typeof r.admission_effect === 'string' && r.admission_effect) admissionEffect = r.admission_effect;
  if (typeof r.pass === 'boolean') pass = r.pass;
  if (['GO', 'CONDITIONAL_GO', 'NO_GO', 'BLOCKED_ENVIRONMENT'].includes(r.decision_hint)) decision = r.decision_hint;
  if (Array.isArray(r.limitations) && r.limitations.length > 0) limitation = r.limitations.join('; ');
  else if (r.limitation) limitation = r.limitation;
}
const bodyLines = [
  '# Decision (draft)',
  '',
  '- gate: ' + reportedGate,
  ...(parentGate ? ['- parent_gate: ' + parentGate] : []),
  ...(admissionEffect ? ['- admission_effect: ' + admissionEffect] : []),
  '- fixture: ' + m.fixture,
  '- platform: ' + m.platform,
  '- evidence_sha256: ' + (evidenceSha256 || 'unavailable'),
  '- outcome: ' + (pass ? 'all checks passed' : 'verification failed'),
  '- draft decision: ' + decision + ' (待所有者角色签署后生效)'
];
if (limitation) bodyLines.push('- limitation: ' + limitation);
bodyLines.push('', '签署规则见 docs/技术可行性/技术验证执行计划.md §7。', '');
const body = bodyLines.join(String.fromCharCode(10));
fs.writeFileSync(ev + '/decision.md', body);
fs.writeFileSync(ev + '/manifest.json', JSON.stringify(m, null, 2) + String.fromCharCode(10));
" "$EV" "$RC"

echo "---- stdout (tail) ----"
tail -n 40 "$EV/stdout.log" 2>/dev/null || true
if [ -s "$EV/stderr.log" ]; then
  echo "---- stderr (tail) ----"
  tail -n 20 "$EV/stderr.log" 2>/dev/null || true
fi
echo "evidence: $EV"
exit $RC
