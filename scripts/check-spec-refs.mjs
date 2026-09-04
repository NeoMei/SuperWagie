#!/usr/bin/env node
// 校验 rules/ 规则包中的规格锚点与矩阵需求 ID。
// 用法:
//   node scripts/check-spec-refs.mjs             校验模式
//   node scripts/check-spec-refs.mjs --coverage  额外列出未被引用的矩阵需求(信息性)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rulesDir = path.join(repoRoot, 'rules');
const readmePath = path.join(rulesDir, 'README.md');
const matrixPath = path.join(repoRoot, 'docs', '技术可行性', '技术要求矩阵.md');

const errors = [];
const read = (p) => fs.readFileSync(p, 'utf8');

// 1. 解析别名表: "- WD = docs/..." 行
const aliases = {};
for (const line of read(readmePath).split(/\r?\n/)) {
  const m = line.match(/^- ([A-Z][A-Z0-9]*) = (.+)$/);
  if (m) aliases[m[1]] = m[2].trim();
}

// 2. 收集规则文件(README 是别名来源, 不参与校验)
const ruleFiles = fs.readdirSync(rulesDir).filter((f) => f.endsWith('.md') && f !== 'README.md');

// 3. 解析矩阵需求 ID
const matrixIds = new Set();
for (const m of read(matrixPath).matchAll(/^\|\s*([A-Z]+-\d+)\s*\|/gm)) matrixIds.add(m[1]);

// 4. 校验锚点与矩阵引用, 并统计覆盖率
const referenced = new Set();
const anchorRe = /\[([A-Z][A-Z0-9]*) §(\d+(?:\.\d+)?)\]/g;
const matrixTokenRe = /[A-Z]{2,4}-\d{2,3}/g;

for (const f of ruleFiles) {
  const raw = read(path.join(rulesDir, f));
  const text = raw.replace(/R-[A-Z]{2,4}-\d{2}/g, ''); // 规则编号不算矩阵引用
  for (const m of text.matchAll(anchorRe)) {
    const alias = m[1];
    const section = m[2];
    const rel = aliases[alias];
    if (!rel) {
      errors.push(f + ': 未知别名 ' + alias + ' (§' + section + ')');
      continue;
    }
    const targetPath = path.join(repoRoot, rel);
    if (!fs.existsSync(targetPath)) {
      errors.push(f + ': 别名 ' + alias + ' 指向不存在的文件 ' + rel);
      continue;
    }
    const headings = [];
    for (const line of read(targetPath).split('\n')) {
      const h = line.match(/^#{1,6}\s+(\d+(?:\.\d+)*)(?:[.\s])/);
      if (h) headings.push(h[1]);
    }
    if (!headings.includes(section)) {
      errors.push(f + ': [' + alias + ' §' + section + '] 在 ' + rel + ' 中无对应章节标题');
    }
  }
  for (const m of text.matchAll(matrixTokenRe)) {
    const id = m[0];
    if (!matrixIds.has(id)) {
      errors.push(f + ': 矩阵中不存在需求 ID ' + id);
    } else {
      referenced.add(id);
    }
  }
}

// 5. 覆盖率(信息性)
const uncovered = [...matrixIds].filter((id) => !referenced.has(id));

console.log('规则文件: ' + ruleFiles.length + ' 个');
console.log('别名: ' + Object.keys(aliases).length + ' 个; 矩阵需求: ' + matrixIds.size + ' 条');
console.log('已被规则包引用的矩阵需求: ' + referenced.size + ' 条');

if (process.argv.includes('--coverage')) {
  console.log('未被引用的矩阵需求(信息性, 可按模块逐步补齐):');
  for (const id of uncovered) console.log('  - ' + id);
}

if (errors.length) {
  console.error('');
  console.error('校验失败:');
  for (const e of errors) console.error('  x ' + e);
  process.exit(1);
}
console.log('');
console.log('锚点与矩阵引用校验通过。');
