import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const forbiddenTracked = tracked.filter((file) =>
  /(^|\/)(?:dist|coverage|playwright-report|test-results|\.wrangler)(?:\/|$)|(^|\/)\.DS_Store$/.test(file),
);

if (forbiddenTracked.length > 0) {
  console.error('[audit] 检测到被 Git 跟踪的生成物/临时文件：');
  for (const file of forbiddenTracked) console.error(`  - ${file}`);
  process.exitCode = 1;
}

const productionFiles = tracked.filter((file) =>
  /^(?:apps\/[^/]+\/src|packages\/[^/]+\/src|scripts)\//.test(file)
  && file !== 'scripts/engineering/repository-audit.mjs'
  && ['.ts', '.vue', '.mjs', '.js', '.sh'].includes(extname(file)),
);

const debtPattern = /\b(?:TODO|FIXME|HACK|XXX)\b/;
const debtHits = [];
const hotspots = [];

for (const file of productionFiles) {
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');
  if (lines.length >= 600) hotspots.push({ file, lines: lines.length });
  lines.forEach((line, index) => {
    if (debtPattern.test(line)) debtHits.push(`${file}:${index + 1}: ${line.trim()}`);
  });
}

if (debtHits.length > 0) {
  console.error('[audit] 生产真源中存在 TODO/FIXME/HACK/XXX：');
  for (const hit of debtHits) console.error(`  - ${hit}`);
  process.exitCode = 1;
}

hotspots.sort((left, right) => right.lines - left.lines || left.file.localeCompare(right.file));
console.log(`[audit] Git 跟踪文件：${tracked.length}`);
console.log(`[audit] 生产源码/脚本：${productionFiles.length}`);
console.log('[audit] >=600 行维护热点（仅报告，不按行数机械判失败）：');
if (hotspots.length === 0) console.log('  - 无');
for (const hotspot of hotspots) console.log(`  - ${hotspot.lines}  ${hotspot.file}`);

if (!process.exitCode) console.log('[audit] 仓库工程卫生检查 PASS');
