import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY_PATH = path.join(HERE, 'fixtures', 'source-policy-forbidden.json');
const DEFAULT_PLAN_PATH = path.join(HERE, 'chunk-plan.json');

class InputError extends Error {}

function input(message) {
  throw new InputError(`Source policy input unavailable: ${message}`);
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) input(`${label} must be an explicit absolute path`);
  try {
    if (!statSync(value).isDirectory() && label === 'candidate root') input(`${label} is not a directory`);
  } catch {
    input(`${label} does not exist`);
  }
  return path.resolve(value);
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    input(`${label} is missing or invalid JSON: ${error.message}`);
  }
}

function posixRelative(value) {
  return value.split(path.sep).join('/');
}

function selectedSourcesFromPlan(plan) {
  if (!plan?.chunks || !Array.isArray(plan.chunks)) input('chunk plan has no chunks');
  return [...new Set(plan.chunks
    .filter((chunk) => chunk.status === 'poc_built')
    .flatMap((chunk) => chunk.entry_exports ?? [])
    .map((entry) => entry.source))].sort();
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function stripTypeOnlyDeclarations(source) {
  let output = source.replace(/^\s*import\s+type\b[^;]*;?/gm, '');
  output = output.replace(/^\s*export\s+type\s+\{[^}]*\}\s+from\s+['"][^'"]+['"]\s*;?/gm, '');
  output = output.replace(/^\s*(?:export\s+)?type\s+[A-Za-z_$][\w$]*(?:<[^;{=]+>)?\s*=\s*[\s\S]*?;\s*$/gm, '');
  const interfaceStart = /\b(?:export\s+)?interface\s+[A-Za-z_$][\w$]*(?:<[^>{]+>)?\s*(?:extends\s+[^\{]+)?\{/g;
  for (;;) {
    const match = interfaceStart.exec(output);
    if (!match) break;
    let depth = 1;
    let index = match.index + match[0].length;
    while (index < output.length && depth > 0) {
      if (output[index] === '{') depth += 1;
      else if (output[index] === '}') depth -= 1;
      index += 1;
    }
    output = `${output.slice(0, match.index)}${output.slice(index)}`;
    interfaceStart.lastIndex = 0;
  }
  return output;
}

function importSpecifiers(source) {
  const values = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"](?:\s+as\s+[A-Za-z_$][\w$]*)?\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) values.push(match[1]);
  }
  return [...new Set(values)].sort();
}

function exceptionMatches(policy, sourceName, evidence) {
  return (policy.audited_literal_exceptions ?? []).find((item) => (
    item.source === sourceName && item.literal === evidence && typeof item.reason === 'string' && item.reason.length > 0
  ));
}

function runtimeExceptionMatches(policy, sourceName, evidence, matchIndex, source) {
  return (policy.audited_runtime_exceptions ?? []).find((item) => {
    if (item.source !== sourceName || item.evidence !== evidence || typeof item.reason !== 'string' || !item.reason) return false;
    for (const literal of source.matchAll(/(['"])([^'"\r\n]*)\1/g)) {
      const start = literal.index + 1;
      const end = start + literal[2].length;
      if (literal[2] === item.containing_literal && matchIndex >= start && matchIndex < end) return true;
    }
    for (const literal of source.matchAll(/\/([^/\r\n]*)\/[dgimsuvy]*/g)) {
      const start = literal.index + 1;
      const end = start + literal[1].length;
      if (literal[1] === item.containing_regex && matchIndex >= start && matchIndex < end) return true;
    }
    return false;
  });
}

function urlLiterals(source) {
  return [...source.matchAll(/(['"])(https?:\/\/[^'"\s]+)\1/g)].map((match) => match[2]);
}

export function auditSourcePolicy({ candidateRoot, selectedSources, policy } = {}) {
  const root = requireAbsolute(candidateRoot, 'candidate root');
  policy ??= readJson(DEFAULT_POLICY_PATH, 'source policy');
  selectedSources ??= selectedSourcesFromPlan(readJson(DEFAULT_PLAN_PATH, 'chunk plan'));
  if (!Array.isArray(selectedSources) || selectedSources.length === 0) input('selected source list is empty');

  const violations = [];
  const exceptionsUsed = [];
  const audited = [];
  for (const sourceName of [...new Set(selectedSources)].sort()) {
    if (path.posix.isAbsolute(sourceName) || sourceName.split('/').includes('..')) input(`unsafe selected source path: ${sourceName}`);
    const fullPath = path.join(root, sourceName);
    let source;
    try {
      source = readFileSync(fullPath, 'utf8');
    } catch (error) {
      input(`selected source ${sourceName} cannot be read: ${error.message}`);
    }
    audited.push(posixRelative(sourceName));
    const uncommented = stripComments(source);
    for (const specifier of importSpecifiers(uncommented)) {
      const fragment = (policy.forbidden_import_fragments ?? []).find((item) => specifier.toLowerCase().includes(item.toLowerCase()));
      const shellWrapper = new RegExp(policy.shell_wrapper_import_pattern, 'i').test(specifier);
      if (fragment || shellWrapper) {
        violations.push({ source: sourceName, rule: 'forbidden_import', evidence: specifier });
      }
    }

    const runtime = stripTypeOnlyDeclarations(uncommented);
    for (const expression of policy.forbidden_runtime_patterns ?? []) {
      const pattern = new RegExp(expression, 'giu');
      for (const match of runtime.matchAll(pattern)) {
        const exception = runtimeExceptionMatches(policy, sourceName, match[0], match.index, runtime);
        if (exception) exceptionsUsed.push({ source: sourceName, literal: exception.containing_literal ?? `/${exception.containing_regex}/`, reason: exception.reason });
        else violations.push({ source: sourceName, rule: 'forbidden_runtime', evidence: match[0] });
      }
    }
    for (const literal of urlLiterals(runtime)) {
      const exception = exceptionMatches(policy, sourceName, literal);
      if (exception) {
        exceptionsUsed.push({ source: sourceName, literal, reason: exception.reason });
      } else {
        violations.push({ source: sourceName, rule: 'forbidden_network_literal', evidence: literal });
      }
    }
  }

  violations.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  exceptionsUsed.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    schema_id: 'superwagie.viewer-source-policy-audit.v1',
    decision: violations.length === 0 ? 'GO' : 'NO_GO',
    audited_sources: audited,
    forbidden_runtime_edges: violations.length,
    violations,
    exceptions_used: exceptionsUsed,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!value || !['--candidate-root', '--output'].includes(name)) input(`${name ?? '<argument>'} is unsupported or missing a value`);
    if (name === '--candidate-root') options.candidateRoot = value;
    else options.outputPath = value;
  }
  if (!options.candidateRoot || !options.outputPath) input('--candidate-root and --output are required');
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = auditSourcePolicy({ candidateRoot: options.candidateRoot });
  const output = path.resolve(options.outputPath);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.decision !== 'GO') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error instanceof InputError ? 2 : 1;
  }
}
