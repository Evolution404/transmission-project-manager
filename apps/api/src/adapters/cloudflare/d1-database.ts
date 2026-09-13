import type { DatabasePort, DatabaseRunResult, DatabaseStatement, DatabaseValue } from '../../ports/database';

function bindValue(value: DatabaseValue): string | number | null | ArrayBuffer {
  if (value instanceof Uint8Array) return new Uint8Array(value).buffer as ArrayBuffer;
  return value;
}

function prepare(db: D1Database, statement: DatabaseStatement): D1PreparedStatement {
  const prepared = db.prepare(statement.sql);
  return statement.params?.length ? prepared.bind(...statement.params.map(bindValue)) : prepared;
}

function runResult(result: D1Result<unknown>): DatabaseRunResult {
  return {
    changes: Number(result.meta.changes ?? 0),
    lastInsertRowId: result.meta.last_row_id ?? null,
  };
}

export class D1DatabaseAdapter implements DatabasePort {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async first<T extends Record<string, unknown>>(statement: DatabaseStatement): Promise<T | null> {
    return prepare(this.db, statement).first<T>();
  }

  async all<T extends Record<string, unknown>>(statement: DatabaseStatement): Promise<readonly T[]> {
    const result = await prepare(this.db, statement).all<T>();
    return result.results ?? [];
  }

  async run(statement: DatabaseStatement): Promise<DatabaseRunResult> {
    return runResult(await prepare(this.db, statement).run());
  }

  async batch(statements: readonly DatabaseStatement[]): Promise<readonly DatabaseRunResult[]> {
    if (statements.length === 0) return [];
    const results = await this.db.batch(statements.map((statement) => prepare(this.db, statement)));
    return results.map(runResult);
  }
}
