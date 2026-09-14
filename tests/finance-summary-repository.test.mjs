import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlFinanceSummaryRepository } from '../apps/api/src/repositories/sql-finance-summary-repository.ts';

function createRepository() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE agreements (
      id TEXT PRIMARY KEY,framework_id TEXT NOT NULL,code TEXT NOT NULL,name TEXT NOT NULL,amount_fen INTEGER NOT NULL,
      valid_from TEXT NOT NULL,valid_to TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE project_budgets (id TEXT PRIMARY KEY,budget_version INTEGER NOT NULL);
    CREATE TABLE budget_versions (
      id TEXT PRIMARY KEY,budget_id TEXT NOT NULL,framework_id TEXT NOT NULL,budget_version INTEGER NOT NULL,total_amount_fen INTEGER NOT NULL
    );
    CREATE TABLE budget_version_allocations (
      id TEXT PRIMARY KEY,budget_version_id TEXT NOT NULL,agreement_id TEXT NOT NULL,amount_fen INTEGER NOT NULL
    );
    CREATE TABLE financial_entries (
      id TEXT PRIMARY KEY,framework_id TEXT NOT NULL,entry_type TEXT NOT NULL,business_date TEXT NOT NULL,amount_fen INTEGER NOT NULL
    );
    CREATE TABLE financial_entry_allocations (
      id TEXT PRIMARY KEY,financial_entry_id TEXT NOT NULL,agreement_id TEXT NOT NULL,amount_fen INTEGER NOT NULL
    );
    INSERT INTO agreements VALUES
      ('ag-1','fw-1','AG-1','Agreement 1',1000,'2026-01-01','2026-12-31','active',1,'c','u'),
      ('ag-2','fw-1','AG-2','Agreement 2',500,'2026-01-01','2026-06-30','paused',1,'c','u');
    INSERT INTO project_budgets VALUES ('b1',2);
    INSERT INTO budget_versions VALUES
      ('bv-1','b1','fw-1',1,700),
      ('bv-2','b1','fw-1',2,800);
    INSERT INTO budget_version_allocations VALUES
      ('bva-1','bv-1','ag-1',700),
      ('bva-2','bv-2','ag-1',500),
      ('bva-3','bv-2','ag-2',300);
    INSERT INTO financial_entries VALUES
      ('e1','fw-1','budget_occurrence','2026-03-01',450),
      ('e2','fw-1','actual_cost','2026-03-01',200),
      ('e3','fw-1','budget_occurrence','2026-05-01',100);
    INSERT INTO financial_entry_allocations VALUES
      ('fea-1','e1','ag-1',300),
      ('fea-2','e1','ag-2',150),
      ('fea-3','e2','ag-1',200),
      ('fea-4','e3','ag-1',100);
  `);
  return { sqlite, repository: new SqlFinanceSummaryRepository(new SqliteDatabaseAdapter(sqlite)) };
}

test('finance summary repository returns latest-confirmed and as-of facts without business warning rules', async () => {
  const { sqlite, repository } = createRepository();
  try {
    assert.deepEqual(await repository.getFacts('fw-1','2026-03-31'), {
      confirmedBudgetFen:800,
      budgetOccurrenceFen:450,
      actualCostFen:200,
      agreements:[
        {
          agreement:{id:'ag-1',frameworkId:'fw-1',code:'AG-1',name:'Agreement 1',amountFen:1000,validFrom:'2026-01-01',validTo:'2026-12-31',status:'active',version:1,createdAt:'c',updatedAt:'u'},
          budgetCommittedFen:500,
          budgetOccurrenceFen:300,
          actualCostFen:200,
        },
        {
          agreement:{id:'ag-2',frameworkId:'fw-1',code:'AG-2',name:'Agreement 2',amountFen:500,validFrom:'2026-01-01',validTo:'2026-06-30',status:'paused',version:1,createdAt:'c',updatedAt:'u'},
          budgetCommittedFen:300,
          budgetOccurrenceFen:150,
          actualCostFen:0,
        },
      ],
    });
  } finally { sqlite.close(); }
});
