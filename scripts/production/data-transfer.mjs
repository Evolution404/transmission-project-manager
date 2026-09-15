import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const INTERNAL_TABLES = new Set(['d1_migrations', 'sqlite_sequence']);

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function tableNames(database) {
  return database.prepare(`SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all()
    .map((row) => String(row.name))
    .filter((name) => !INTERNAL_TABLES.has(name) && !name.startsWith('_cf_'));
}

function tableColumns(database, table) {
  return database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => ({
    name: String(row.name),
    type: String(row.type ?? '').trim().toUpperCase(),
    notnull: Number(row.notnull) === 1,
    defaultValue: row.dflt_value === null ? null : String(row.dflt_value),
    primaryKey: Number(row.pk),
  }));
}

function tableForeignKeys(database, table) {
  return database.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all().map((row) => ({
    from: String(row.from),
    to: String(row.to),
    table: String(row.table),
    onUpdate: String(row.on_update),
    onDelete: String(row.on_delete),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function schemaDescription(database) {
  return tableNames(database).map((name) => ({
    name,
    columns: tableColumns(database, name),
    foreignKeys: tableForeignKeys(database, name),
  }));
}

function fingerprint(description) {
  return createHash('sha256').update(JSON.stringify(description)).digest('hex');
}

function rowCount(database, table) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count);
}

function sourceFitsTarget(sourceColumns, targetColumns) {
  const targetByName = new Map(targetColumns.map((column) => [column.name, column]));
  for (const sourceColumn of sourceColumns) {
    const targetColumn = targetByName.get(sourceColumn.name);
    if (!targetColumn) return { ok: false, reason: `目标模型已移除字段 ${sourceColumn.name}` };
    if (sourceColumn.type !== targetColumn.type || sourceColumn.primaryKey !== targetColumn.primaryKey) {
      return { ok: false, reason: `字段 ${sourceColumn.name} 的类型或主键语义已变化` };
    }
  }
  const sourceNames = new Set(sourceColumns.map((column) => column.name));
  for (const targetColumn of targetColumns) {
    if (sourceNames.has(targetColumn.name)) continue;
    if (targetColumn.primaryKey > 0 || (targetColumn.notnull && targetColumn.defaultValue === null)) {
      return { ok: false, reason: `目标模型新增必填字段 ${targetColumn.name}，无法自动推导历史值` };
    }
  }
  return { ok: true, reason: null };
}

function copyRows(source, target, table, columns) {
  if (!columns.length) return;
  const names = columns.map((column) => column.name);
  const select = source.prepare(`SELECT ${names.map(quoteIdentifier).join(',')} FROM ${quoteIdentifier(table)}`);
  const insert = target.prepare(`INSERT OR REPLACE INTO ${quoteIdentifier(table)} (${names.map(quoteIdentifier).join(',')}) VALUES (${names.map(() => '?').join(',')})`);
  for (const row of select.all()) insert.run(...names.map((name) => row[name]));
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  return `'${String(value).replaceAll("'", "''")}'`;
}

function createDataSql(target) {
  const statements = [];
  for (const table of tableNames(target)) {
    const columns = tableColumns(target, table).map((column) => column.name);
    if (!columns.length) continue;
    const rows = target.prepare(`SELECT ${columns.map(quoteIdentifier).join(',')} FROM ${quoteIdentifier(table)}`).all();
    for (const row of rows) {
      statements.push(`INSERT OR REPLACE INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(',')}) VALUES (${columns.map((name) => sqlLiteral(row[name])).join(',')});`);
    }
  }
  return `${statements.join('\n')}\n`;
}

function createResetSql(source) {
  const tables = tableNames(source);
  const dependencies = new Map(tables.map((table) => [table, new Set(tableForeignKeys(source, table).map((item) => item.table).filter((name) => name !== table && tables.includes(name)))]));
  const order = [];
  const seen = new Set();
  function visit(table) {
    if (seen.has(table)) return;
    seen.add(table);
    order.push(table);
    for (const parent of dependencies.get(table) ?? []) visit(parent);
  }
  for (const table of tables) visit(table);
  const statements = ['PRAGMA defer_foreign_keys=ON;'];
  for (const table of order) statements.push(`DROP TABLE IF EXISTS ${quoteIdentifier(table)};`);
  statements.push('DROP TABLE IF EXISTS d1_migrations;');
  return `${statements.join('\n')}\n`;
}

function createCombinedResetSql(source, target) {
  const sourceReset = createResetSql(source).split('\n').filter((line) => line.startsWith('DROP TABLE'));
  const targetReset = createResetSql(target).split('\n').filter((line) => line.startsWith('DROP TABLE'));
  return `PRAGMA defer_foreign_keys=ON;\n${[...new Set([...targetReset, ...sourceReset])].join('\n')}\n`;
}

function createVerifySql(target) {
  const statements = tableNames(target).map((table) => `SELECT '${table.replaceAll("'", "''")}' AS table_name, COUNT(*) AS row_count FROM ${quoteIdentifier(table)};`);
  statements.push('PRAGMA foreign_key_check;');
  statements.push('PRAGMA integrity_check;');
  return `${statements.join('\n')}\n`;
}

async function loadTransform(transformPath) {
  if (!transformPath) return null;
  const module = await import(`${pathToFileURL(transformPath).href}?t=${Date.now()}`);
  const sourceFingerprint = typeof module.sourceFingerprint === 'string' ? module.sourceFingerprint : '';
  const handledSourceTables = Array.isArray(module.handledSourceTables) ? module.handledSourceTables.map(String) : [];
  if (!/^[a-f0-9]{64}$/.test(sourceFingerprint)) throw new Error('DATA_TRANSFORM_INVALID: sourceFingerprint is required');
  if (typeof module.transform !== 'function') throw new Error('DATA_TRANSFORM_INVALID: transform() is required');
  if (typeof module.verify !== 'function') throw new Error('DATA_TRANSFORM_INVALID: verify() is required');
  return { sourceFingerprint, handledSourceTables, transform: module.transform, verify: module.verify };
}

export async function planProductionDataTransfer({ sourceSqlPath, targetBaselinePath, transformPath = null }) {
  const sourceSql = await readFile(sourceSqlPath, 'utf8');
  const targetSql = await readFile(targetBaselinePath, 'utf8');
  const source = new DatabaseSync(':memory:');
  const target = new DatabaseSync(':memory:');
  try {
    source.exec('PRAGMA foreign_keys=OFF;');
    source.exec(sourceSql);
    target.exec('PRAGMA foreign_keys=OFF;');
    target.exec(targetSql);

    const sourceDescription = schemaDescription(source);
    const targetDescription = schemaDescription(target);
    const sourceFingerprint = fingerprint(sourceDescription);
    const targetFingerprint = fingerprint(targetDescription);
    const rebuildRequired = sourceFingerprint !== targetFingerprint;
    const transform = await loadTransform(transformPath);
    const handled = new Set(transform?.handledSourceTables ?? []);
    const decisionRequired = [];
    const autoCopiedTables = [];
    const transformedSourceTables = [];
    const targetTables = new Map(targetDescription.map((table) => [table.name, table]));

    if (transform && transform.sourceFingerprint !== sourceFingerprint) {
      decisionRequired.push({ table: 'transform', rows: null, reason: `一次性转换规则的旧 schema 指纹不匹配（期望 ${transform.sourceFingerprint}，实际 ${sourceFingerprint}）` });
    }

    for (const sourceTable of sourceDescription) {
      const count = rowCount(source, sourceTable.name);
      const targetTable = targetTables.get(sourceTable.name);
      if (!targetTable) {
        if (count > 0 && !handled.has(sourceTable.name)) decisionRequired.push({ table: sourceTable.name, rows: count, reason: '当前模型已删除该表，且没有显式数据转换规则' });
        continue;
      }
      const compatibility = sourceFitsTarget(sourceTable.columns, targetTable.columns);
      if (compatibility.ok) {
        copyRows(source, target, sourceTable.name, sourceTable.columns);
        autoCopiedTables.push(sourceTable.name);
        continue;
      }
      if (count > 0 && !handled.has(sourceTable.name)) decisionRequired.push({ table: sourceTable.name, rows: count, reason: compatibility.reason });
    }

    if (!decisionRequired.length && transform) {
      transform.transform({ source, target });
      transformedSourceTables.push(...transform.handledSourceTables);
      const transformErrors = await transform.verify({ source, target });
      if (!Array.isArray(transformErrors)) throw new Error('DATA_TRANSFORM_INVALID: verify() must return an array');
      for (const error of transformErrors) decisionRequired.push({ table: 'transform', rows: null, reason: String(error) });
    }

    target.exec('PRAGMA foreign_keys=ON;');
    const foreignKeyErrors = target.prepare('PRAGMA foreign_key_check').all();
    for (const error of foreignKeyErrors) decisionRequired.push({ table: String(error.table ?? 'unknown'), rows: null, reason: `外键校验失败: ${JSON.stringify(error)}` });
    const integrity = target.prepare('PRAGMA integrity_check').get();
    if (String(integrity.integrity_check ?? '').toLowerCase() !== 'ok') decisionRequired.push({ table: 'database', rows: null, reason: 'SQLite integrity_check 未通过' });

    const sourceRows = Object.fromEntries(sourceDescription.map((table) => [table.name, rowCount(source, table.name)]));
    const targetRows = Object.fromEntries(targetDescription.map((table) => [table.name, rowCount(target, table.name)]));
    return {
      status: decisionRequired.length ? 'decision_required' : 'ready',
      rebuildRequired,
      sourceFingerprint,
      targetFingerprint,
      sourceRows,
      targetRows,
      autoCopiedTables: autoCopiedTables.sort(),
      transformedSourceTables: [...new Set(transformedSourceTables)].sort(),
      decisionRequired,
      dataSql: decisionRequired.length ? null : createDataSql(target),
      resetSql: decisionRequired.length ? null : createResetSql(source),
      rollbackResetSql: decisionRequired.length ? null : createCombinedResetSql(source, target),
      verifySql: decisionRequired.length ? null : createVerifySql(target),
    };
  } finally {
    source.close();
    target.close();
  }
}
