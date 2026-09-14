import type { DatabaseSync, SQLInputValue, StatementResultingChanges } from 'node:sqlite';
import type { DatabasePort, DatabaseRunResult, DatabaseStatement, DatabaseValue } from '../../ports/database';

function bindValue(value: DatabaseValue): SQLInputValue {
  return value;
}

function parameters(statement: DatabaseStatement): SQLInputValue[] {
  return statement.params?.map(bindValue) ?? [];
}

function runResult(result: StatementResultingChanges): DatabaseRunResult {
  return {
    changes: Number(result.changes),
    lastInsertRowId: typeof result.lastInsertRowid === 'bigint' ? result.lastInsertRowid.toString() : result.lastInsertRowid,
  };
}

export class SqliteDatabaseAdapter implements DatabasePort {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async first<T extends Record<string, unknown>>(statement: DatabaseStatement): Promise<T | null> {
    const row = this.db.prepare(statement.sql).get(...parameters(statement));
    return row ? { ...row } as T : null;
  }

  async all<T extends Record<string, unknown>>(statement: DatabaseStatement): Promise<readonly T[]> {
    return this.db.prepare(statement.sql).all(...parameters(statement)).map((row) => ({ ...row } as T));
  }

  async run(statement: DatabaseStatement): Promise<DatabaseRunResult> {
    return runResult(this.db.prepare(statement.sql).run(...parameters(statement)));
  }

  async batch(statements: readonly DatabaseStatement[]): Promise<readonly DatabaseRunResult[]> {
    if (statements.length === 0) return [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => runResult(this.db.prepare(statement.sql).run(...parameters(statement))));
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
