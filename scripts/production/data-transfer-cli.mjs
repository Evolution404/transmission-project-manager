import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { planProductionDataTransfer } from './data-transfer.mjs';

function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid argument: ${key ?? ''}`);
    result[key.slice(2)] = value;
  }
  return result;
}

const options = args(process.argv.slice(2));
if (!options.source || !options.target || !options.summary) throw new Error('Required: --source --target --summary');
const transformPath = options.transform && existsSync(options.transform) ? options.transform : null;
const plan = await planProductionDataTransfer({
  sourceSqlPath: options.source,
  targetBaselinePath: options.target,
  transformPath,
});
const summary = {
  status: plan.status,
  rebuildRequired: plan.rebuildRequired,
  sourceFingerprint: plan.sourceFingerprint,
  targetFingerprint: plan.targetFingerprint,
  sourceRows: plan.sourceRows,
  targetRows: plan.targetRows,
  autoCopiedTables: plan.autoCopiedTables,
  transformedSourceTables: plan.transformedSourceTables,
  decisionRequired: plan.decisionRequired,
};
await writeFile(options.summary, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
if (plan.status === 'decision_required') {
  console.log(JSON.stringify(summary));
  process.exitCode = 42;
} else {
  if (options.data) await writeFile(options.data, plan.dataSql, { mode: 0o600 });
  if (options.reset) await writeFile(options.reset, plan.resetSql, { mode: 0o600 });
  if (options['rollback-reset']) await writeFile(options['rollback-reset'], plan.rollbackResetSql, { mode: 0o600 });
  if (options.verify) await writeFile(options.verify, plan.verifySql, { mode: 0o600 });
  console.log(JSON.stringify(summary));
}
