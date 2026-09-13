export type DatabaseValue = string | number | null | Uint8Array;

export interface DatabaseStatement {
  sql: string;
  params?: readonly DatabaseValue[];
}

export interface DatabaseRunResult {
  changes: number;
  lastInsertRowId: number | string | null;
}

export interface TransactionPort {
  batch(statements: readonly DatabaseStatement[]): Promise<readonly DatabaseRunResult[]>;
}

export interface DatabasePort extends TransactionPort {
  first<T extends Record<string, unknown>>(statement: DatabaseStatement): Promise<T | null>;
  all<T extends Record<string, unknown>>(statement: DatabaseStatement): Promise<readonly T[]>;
  run(statement: DatabaseStatement): Promise<DatabaseRunResult>;
}
