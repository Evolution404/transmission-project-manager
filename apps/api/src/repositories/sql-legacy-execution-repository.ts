import type {
  DemandLifecycleSummary,
  ImplementationLineSummary,
  ImplementationRecordSummary,
  LifecycleLineSummary,
  LifecycleState,
  ProjectLifecycleSummary,
  ReleaseBatchSummary,
  ReleaseLineSummary,
  SettlementAgreementAllocationInput,
  SettlementCoverageInput,
  SettlementSummary,
} from '@tpm/shared';
import type { DatabasePort, DatabaseStatement } from '../ports/database';
import type {
  LegacyExecutionRepository,
  LegacyImplementationState,
  LegacyProjectState,
  LegacyReleaseLineState,
  LegacyScopeItem,
  LegacySettlementState,
  LegacyWriteMeta,
} from '../ports/legacy-execution-repository';

function lifecycleState(implemented: boolean, settled: boolean): LifecycleState {
  if (implemented && settled) return 'implemented_settled';
  if (implemented) return 'implemented_unsettled';
  if (settled) return 'unimplemented_settled';
  return 'unimplemented_unsettled';
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function projectGuard(projectId: string, version: number, now: string): DatabaseStatement {
  return {
    sql: `UPDATE projects SET version=version+1,updated_at=CASE WHEN version=? THEN ? ELSE NULL END WHERE id=?`,
    params: [version, now, projectId],
  };
}

function auditStatement(meta: LegacyWriteMeta, action: string, objectType: string, objectId: string, before: unknown, after: unknown): DatabaseStatement {
  return {
    sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?)`,
    params: [meta.auditId, meta.actorId, action, objectType, objectId, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), meta.now],
  };
}

function idempotencyStatement(meta: LegacyWriteMeta): DatabaseStatement {
  return {
    sql: `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at) VALUES (?,?,?,?,?,?,?)`,
    params: [meta.idempotencyKey, meta.actorId, meta.operation, meta.requestHash, meta.responseJson, meta.statusCode, meta.now],
  };
}

function quantityMap(rows: readonly { demand_material_id: string; total: number | string }[]) {
  return new Map(rows.map((row) => [row.demand_material_id, Number(row.total)]));
}

export class SqlLegacyExecutionRepository implements LegacyExecutionRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async findProject(id: string): Promise<LegacyProjectState | null> {
    const row = await this.database.first<{
      id: string; name: string; framework_id: string | null; status: 'draft' | 'confirmed'; reserve_version: number; version: number; updated_at: string;
    }>({ sql: `SELECT id,name,framework_id,status,reserve_version,version,updated_at FROM projects WHERE id=? LIMIT 1`, params: [id] });
    return row ? { id: row.id, name: row.name, frameworkId: row.framework_id, status: row.status, reserveVersion: row.reserve_version, version: row.version, updatedAt: row.updated_at } : null;
  }

  async loadProjectScope(projectId: string): Promise<readonly LegacyScopeItem[]> {
    const rows = await this.database.all<{
      allocation_id: string; demand_material_id: string; quantity_scaled: number; raw_model: string; unit: string | null; demand_id: string; line_name: string; section_text: string;
    }>({
      sql: `SELECT da.id AS allocation_id,da.demand_material_id,da.quantity_scaled,dm.raw_model,dm.unit,d.id AS demand_id,d.line_name,d.section_text
            FROM demand_allocations da
            INNER JOIN demand_materials dm ON dm.id=da.demand_material_id
            INNER JOIN demands d ON d.id=dm.demand_id
            WHERE da.project_id=? ORDER BY d.line_name,d.section_text,da.id`,
      params: [projectId],
    });
    return rows.map((row) => ({ allocationId: row.allocation_id, demandMaterialId: row.demand_material_id, quantityScaled: row.quantity_scaled, rawModel: row.raw_model, unit: row.unit, demandId: row.demand_id, lineName: row.line_name, section: row.section_text }));
  }

  async releasedTotals(projectId: string) {
    return quantityMap(await this.database.all({ sql: `SELECT demand_material_id,COALESCE(SUM(quantity_scaled),0) AS total FROM release_lines WHERE project_id=? GROUP BY demand_material_id`, params: [projectId] }));
  }

  async implementedTotals(projectId: string) {
    return quantityMap(await this.database.all({ sql: `SELECT demand_material_id,COALESCE(SUM(completed_quantity_scaled),0) AS total FROM implementation_lines WHERE project_id=? AND demand_material_id IS NOT NULL GROUP BY demand_material_id`, params: [projectId] }));
  }

  async implementedReleaseTotals(projectId: string) {
    const rows = await this.database.all<{ release_line_id: string; total: number | string }>({ sql: `SELECT release_line_id,COALESCE(SUM(completed_quantity_scaled),0) AS total FROM implementation_lines WHERE project_id=? AND release_line_id IS NOT NULL GROUP BY release_line_id`, params: [projectId] });
    return new Map(rows.map((row) => [row.release_line_id, Number(row.total)]));
  }

  async activeSettlementTotals(projectId: string) {
    return quantityMap(await this.database.all({ sql: `SELECT sc.demand_material_id,COALESCE(SUM(sc.quantity_scaled),0) AS total FROM settlement_coverage sc INNER JOIN settlements s ON s.id=sc.settlement_id WHERE sc.project_id=? AND s.voided_at IS NULL GROUP BY sc.demand_material_id`, params: [projectId] }));
  }

  async listReleaseBatches(projectId: string): Promise<readonly ReleaseBatchSummary[]> {
    const batches = await this.database.all<{ id: string; project_id: string; release_date: string; note: string | null; project_version_snapshot: number; reserve_version_snapshot: number; created_at: string }>({
      sql: `SELECT id,project_id,release_date,note,project_version_snapshot,reserve_version_snapshot,created_at FROM release_batches WHERE project_id=? ORDER BY release_date DESC,created_at DESC,id DESC LIMIT 100`, params: [projectId],
    });
    const lines = await this.database.all<{ id: string; release_batch_id: string; demand_material_id: string; quantity_scaled: number; snapshot_json: string }>({
      sql: `SELECT rl.id,rl.release_batch_id,rl.demand_material_id,rl.quantity_scaled,rl.snapshot_json FROM release_lines rl INNER JOIN release_batches rb ON rb.id=rl.release_batch_id WHERE rb.project_id=? ORDER BY rb.release_date DESC,rb.created_at DESC,rl.id`, params: [projectId],
    });
    const project = await this.findProject(projectId);
    const byBatch = new Map<string, ReleaseLineSummary[]>();
    for (const row of lines) {
      const list = byBatch.get(row.release_batch_id) ?? [];
      list.push({ id: row.id, releaseBatchId: row.release_batch_id, demandMaterialId: row.demand_material_id, quantityScaled: row.quantity_scaled, snapshot: JSON.parse(row.snapshot_json) as ReleaseLineSummary['snapshot'] });
      byBatch.set(row.release_batch_id, list);
    }
    return batches.map((row) => ({ id: row.id, projectId: row.project_id, releaseDate: row.release_date, note: row.note, projectVersionSnapshot: row.project_version_snapshot, reserveVersionSnapshot: row.reserve_version_snapshot, projectVersion: project?.version ?? row.project_version_snapshot, lines: byBatch.get(row.id) ?? [], createdAt: row.created_at }));
  }

  async findReleaseLines(projectId: string): Promise<readonly LegacyReleaseLineState[]> {
    const rows = await this.database.all<{ id: string; release_batch_id: string; project_id: string; demand_material_id: string; quantity_scaled: number; snapshot_json: string; created_at: string }>({ sql: `SELECT id,release_batch_id,project_id,demand_material_id,quantity_scaled,snapshot_json,created_at FROM release_lines WHERE project_id=?`, params: [projectId] });
    return rows.map((row) => ({ id: row.id, releaseBatchId: row.release_batch_id, projectId: row.project_id, demandMaterialId: row.demand_material_id, quantityScaled: row.quantity_scaled, snapshotJson: row.snapshot_json, createdAt: row.created_at }));
  }

  private async loadImplementationRows(input: { projectId: string | null; unlinked: boolean }) {
    return input.projectId
      ? this.database.all<{ id: string; project_id: string | null; historical: number; record_date: string; personnel: string | null; note: string | null; version: number; created_at: string; updated_at: string }>({ sql: `SELECT id,project_id,historical,record_date,personnel,note,version,created_at,updated_at FROM implementation_records WHERE project_id=? ORDER BY record_date DESC,created_at DESC,id DESC LIMIT 100`, params: [input.projectId] })
      : this.database.all<{ id: string; project_id: string | null; historical: number; record_date: string; personnel: string | null; note: string | null; version: number; created_at: string; updated_at: string }>({ sql: `SELECT id,project_id,historical,record_date,personnel,note,version,created_at,updated_at FROM implementation_records WHERE historical=1 AND project_id IS NULL ORDER BY record_date DESC,created_at DESC,id DESC LIMIT 100` });
  }

  private async implementationLines(ids: readonly string[]) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.database.all<{ id: string; implementation_id: string; project_id: string | null; release_line_id: string | null; demand_material_id: string | null; description: string | null; unit: string | null; completed_quantity_scaled: number; actual_used_quantity_scaled: number | null }>({
      sql: `SELECT id,implementation_id,project_id,release_line_id,demand_material_id,description,unit,completed_quantity_scaled,actual_used_quantity_scaled FROM implementation_lines WHERE implementation_id IN (${placeholders}) ORDER BY implementation_id,id`, params: ids,
    });
  }

  async listImplementations(input: { projectId: string | null; unlinked: boolean }): Promise<readonly ImplementationRecordSummary[]> {
    const rows = await this.loadImplementationRows(input);
    if (!rows.length) return [];
    const lines = await this.implementationLines(rows.map((row) => row.id));
    const byId = new Map<string, ImplementationLineSummary[]>();
    for (const line of lines) {
      const list = byId.get(line.implementation_id) ?? [];
      list.push({ id: line.id, implementationId: line.implementation_id, projectId: line.project_id, releaseLineId: line.release_line_id, demandMaterialId: line.demand_material_id, description: line.description, unit: line.unit, completedQuantityScaled: line.completed_quantity_scaled, actualUsedQuantityScaled: line.actual_used_quantity_scaled });
      byId.set(line.implementation_id, list);
    }
    const projectVersion = input.projectId ? (await this.findProject(input.projectId))?.version ?? null : null;
    return rows.map((row) => ({ id: row.id, projectId: row.project_id, historical: row.historical === 1, recordDate: row.record_date, personnel: row.personnel, note: row.note, version: row.version, projectVersion: row.project_id ? projectVersion : null, lines: byId.get(row.id) ?? [], createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  async findImplementation(id: string): Promise<LegacyImplementationState | null> {
    const row = await this.database.first<{ id: string; project_id: string | null; historical: number; record_date: string; personnel: string | null; note: string | null; version: number; created_at: string; updated_at: string }>({ sql: `SELECT id,project_id,historical,record_date,personnel,note,version,created_at,updated_at FROM implementation_records WHERE id=? LIMIT 1`, params: [id] });
    if (!row) return null;
    const lines = await this.implementationLines([id]);
    const projectVersion = row.project_id ? (await this.findProject(row.project_id))?.version ?? null : null;
    return {
      summary: { id: row.id, projectId: row.project_id, historical: row.historical === 1, recordDate: row.record_date, personnel: row.personnel, note: row.note, version: row.version, projectVersion, lines: lines.map((line) => ({ id: line.id, implementationId: line.implementation_id, projectId: line.project_id, releaseLineId: line.release_line_id, demandMaterialId: line.demand_material_id, description: line.description, unit: line.unit, completedQuantityScaled: line.completed_quantity_scaled, actualUsedQuantityScaled: line.actual_used_quantity_scaled })), createdAt: row.created_at, updatedAt: row.updated_at },
      rawLines: lines.map((line) => ({ id: line.id, releaseLineId: line.release_line_id, demandMaterialId: line.demand_material_id, description: line.description, unit: line.unit, completedQuantityScaled: line.completed_quantity_scaled, actualUsedQuantityScaled: line.actual_used_quantity_scaled })),
    };
  }

  private async settlementParts(ids: readonly string[]) {
    if (!ids.length) return { coverage: new Map<string, SettlementCoverageInput[]>(), agreements: new Map<string, SettlementAgreementAllocationInput[]>() };
    const placeholders = ids.map(() => '?').join(',');
    const [coverageRows, agreementRows] = await Promise.all([
      this.database.all<{ settlement_id: string; demand_material_id: string; quantity_scaled: number }>({ sql: `SELECT settlement_id,demand_material_id,quantity_scaled FROM settlement_coverage WHERE settlement_id IN (${placeholders}) ORDER BY settlement_id,demand_material_id`, params: ids }),
      this.database.all<{ settlement_id: string; agreement_id: string; amount_fen: number }>({ sql: `SELECT settlement_id,agreement_id,amount_fen FROM settlement_agreement_allocations WHERE settlement_id IN (${placeholders}) ORDER BY settlement_id,agreement_id`, params: ids }),
    ]);
    const coverage = new Map<string, SettlementCoverageInput[]>();
    for (const row of coverageRows) { const list = coverage.get(row.settlement_id) ?? []; list.push({ demandMaterialId: row.demand_material_id, quantityScaled: row.quantity_scaled }); coverage.set(row.settlement_id, list); }
    const agreements = new Map<string, SettlementAgreementAllocationInput[]>();
    for (const row of agreementRows) { const list = agreements.get(row.settlement_id) ?? []; list.push({ agreementId: row.agreement_id, amountFen: row.amount_fen }); agreements.set(row.settlement_id, list); }
    return { coverage, agreements };
  }

  async listSettlements(projectId: string): Promise<readonly SettlementSummary[]> {
    const rows = await this.database.all<{ id: string; project_id: string; settlement_date: string; amount_fen: number; final: number; note: string | null; version: number; voided_at: string | null; void_reason: string | null; created_at: string; updated_at: string }>({ sql: `SELECT id,project_id,settlement_date,amount_fen,final,note,version,voided_at,void_reason,created_at,updated_at FROM settlements WHERE project_id=? ORDER BY settlement_date DESC,created_at DESC,id DESC LIMIT 100`, params: [projectId] });
    const project = await this.findProject(projectId);
    const parts = await this.settlementParts(rows.map((row) => row.id));
    return rows.map((row) => ({ id: row.id, projectId: row.project_id, settlementDate: row.settlement_date, amountFen: row.amount_fen, final: row.final === 1, note: row.note, version: row.version, voidedAt: row.voided_at, voidReason: row.void_reason, projectVersion: project?.version ?? 0, coverage: parts.coverage.get(row.id) ?? [], agreementAllocations: parts.agreements.get(row.id) ?? [], createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  async findSettlement(id: string): Promise<LegacySettlementState | null> {
    const row = await this.database.first<{ id: string; project_id: string; settlement_date: string; amount_fen: number; final: number; note: string | null; version: number; voided_at: string | null; void_reason: string | null; created_at: string; updated_at: string }>({ sql: `SELECT id,project_id,settlement_date,amount_fen,final,note,version,voided_at,void_reason,created_at,updated_at FROM settlements WHERE id=? LIMIT 1`, params: [id] });
    if (!row) return null;
    const project = await this.findProject(row.project_id);
    const parts = await this.settlementParts([id]);
    return { projectId: row.project_id, version: row.version, voidedAt: row.voided_at, final: row.final === 1, summary: { id: row.id, projectId: row.project_id, settlementDate: row.settlement_date, amountFen: row.amount_fen, final: row.final === 1, note: row.note, version: row.version, voidedAt: row.voided_at, voidReason: row.void_reason, projectVersion: project?.version ?? 0, coverage: parts.coverage.get(id) ?? [], agreementAllocations: parts.agreements.get(id) ?? [], createdAt: row.created_at, updatedAt: row.updated_at } };
  }

  async lifecycle(projectId: string): Promise<ProjectLifecycleSummary | null> {
    const project = await this.findProject(projectId);
    if (!project) return null;
    const scope = await this.loadProjectScope(projectId);
    const [released, implemented, settled, completion, finalSettlement] = await Promise.all([
      this.releasedTotals(projectId), this.implementedTotals(projectId), this.activeSettlementTotals(projectId),
      this.database.first<{ max_date: string | null }>({ sql: `SELECT MAX(ir.record_date) AS max_date FROM implementation_lines il INNER JOIN implementation_records ir ON ir.id=il.implementation_id WHERE il.project_id=? AND il.demand_material_id IS NOT NULL`, params: [projectId] }),
      this.database.first<{ id: string }>({ sql: `SELECT id FROM settlements WHERE project_id=? AND final=1 AND voided_at IS NULL ORDER BY settlement_date DESC,created_at DESC,id DESC LIMIT 1`, params: [projectId] }),
    ]);
    const lines: LifecycleLineSummary[] = scope.map((item) => {
      const implementedQuantityScaled = implemented.get(item.demandMaterialId) ?? 0;
      const settledQuantityScaled = settled.get(item.demandMaterialId) ?? 0;
      const implementationComplete = implementedQuantityScaled >= item.quantityScaled;
      const settlementComplete = finalSettlement !== null && settledQuantityScaled >= item.quantityScaled;
      return { demandId: item.demandId, demandMaterialId: item.demandMaterialId, lineName: item.lineName, section: item.section, rawModel: item.rawModel, unit: item.unit, allocatedQuantityScaled: item.quantityScaled, releasedQuantityScaled: released.get(item.demandMaterialId) ?? 0, implementedQuantityScaled, settledQuantityScaled, implementationComplete, settlementComplete, state: lifecycleState(implementationComplete, settlementComplete) };
    });
    const implementationComplete = lines.length > 0 && lines.every((line) => line.implementationComplete);
    const settlementComplete = lines.length > 0 && lines.every((line) => line.settlementComplete);
    const demandMap = new Map<string, LifecycleLineSummary[]>();
    for (const line of lines) { const list = demandMap.get(line.demandId) ?? []; list.push(line); demandMap.set(line.demandId, list); }
    const demands: DemandLifecycleSummary[] = [...demandMap.entries()].map(([demandId, demandLines]) => { const impl = demandLines.every((line) => line.implementationComplete); const settle = demandLines.every((line) => line.settlementComplete); return { demandId, lineName: demandLines[0]!.lineName, section: demandLines[0]!.section, implementationComplete: impl, settlementComplete: settle, state: lifecycleState(impl, settle) }; });
    const implementationCompletedDate = implementationComplete ? completion?.max_date ?? null : null;
    return { projectId, projectVersion: project.version, implementationComplete, settlementComplete, projectState: lifecycleState(implementationComplete, settlementComplete), lines, demands, settlementTodo: { needed: implementationComplete && !settlementComplete, implementationCompletedDate, dueDate: implementationComplete && !settlementComplete && implementationCompletedDate ? addDays(implementationCompletedDate, 30) : null, finalSettlementId: finalSettlement?.id ?? null } };
  }

  async createReleaseBatch(input: { projectId: string; expectedProjectVersion: number; batch: ReleaseBatchSummary; meta: LegacyWriteMeta }): Promise<void> {
    await this.database.batch([
      projectGuard(input.projectId, input.expectedProjectVersion, input.meta.now),
      { sql: `INSERT INTO release_batches (id,project_id,release_date,note,project_version_snapshot,reserve_version_snapshot,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)`, params: [input.batch.id, input.projectId, input.batch.releaseDate, input.batch.note, input.batch.projectVersionSnapshot, input.batch.reserveVersionSnapshot, input.meta.actorId, input.meta.now] },
      ...input.batch.lines.map((line) => ({ sql: `INSERT INTO release_lines (id,release_batch_id,project_id,demand_material_id,quantity_scaled,snapshot_json,created_at) VALUES (?,?,?,?,?,?,?)`, params: [line.id, input.batch.id, input.projectId, line.demandMaterialId, line.quantityScaled, JSON.stringify(line.snapshot), input.meta.now] } as DatabaseStatement)),
      auditStatement(input.meta, 'release.create', 'release_batch', input.batch.id, null, input.batch), idempotencyStatement(input.meta),
    ]);
  }

  async createHistoricalImplementation(input: { summary: ImplementationRecordSummary; meta: LegacyWriteMeta }): Promise<void> {
    const s = input.summary;
    await this.database.batch([
      { sql: `INSERT INTO implementation_records (id,project_id,historical,record_date,personnel,note,version,created_by,created_at,updated_at) VALUES (?,NULL,1,?,?,?,1,?,?,?)`, params: [s.id, s.recordDate, s.personnel, s.note, input.meta.actorId, input.meta.now, input.meta.now] },
      ...s.lines.map((line) => ({ sql: `INSERT INTO implementation_lines (id,implementation_id,project_id,release_line_id,demand_material_id,description,unit,completed_quantity_scaled,actual_used_quantity_scaled,created_at) VALUES (?,?,NULL,NULL,NULL,?,?,?,?,?)`, params: [line.id, s.id, line.description, line.unit, line.completedQuantityScaled, line.actualUsedQuantityScaled, input.meta.now] } as DatabaseStatement)),
      auditStatement(input.meta, 'implementation.historical.create', 'implementation', s.id, null, s), idempotencyStatement(input.meta),
    ]);
  }

  async createImplementation(input: { expectedProjectVersion: number; summary: ImplementationRecordSummary; meta: LegacyWriteMeta }): Promise<void> {
    const s = input.summary;
    await this.database.batch([
      projectGuard(s.projectId!, input.expectedProjectVersion, input.meta.now),
      { sql: `INSERT INTO implementation_records (id,project_id,historical,record_date,personnel,note,version,created_by,created_at,updated_at) VALUES (?,?,0,?,?,?,1,?,?,?)`, params: [s.id, s.projectId!, s.recordDate, s.personnel, s.note, input.meta.actorId, input.meta.now, input.meta.now] },
      ...s.lines.map((line) => ({ sql: `INSERT INTO implementation_lines (id,implementation_id,project_id,release_line_id,demand_material_id,description,unit,completed_quantity_scaled,actual_used_quantity_scaled,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, params: [line.id, s.id, s.projectId!, line.releaseLineId, line.demandMaterialId, line.description, line.unit, line.completedQuantityScaled, line.actualUsedQuantityScaled, input.meta.now] } as DatabaseStatement)),
      auditStatement(input.meta, 'implementation.create', 'implementation', s.id, null, s), idempotencyStatement(input.meta),
    ]);
  }

  async linkHistoricalImplementation(input: { expectedProjectVersion: number; expectedRecordVersion: number; summary: ImplementationRecordSummary; meta: LegacyWriteMeta }): Promise<void> {
    const s = input.summary;
    await this.database.batch([
      projectGuard(s.projectId!, input.expectedProjectVersion, input.meta.now),
      { sql: `UPDATE implementation_records SET project_id=?,version=version+1,updated_at=CASE WHEN version=? THEN ? ELSE NULL END WHERE id=?`, params: [s.projectId!, input.expectedRecordVersion, input.meta.now, s.id] },
      ...s.lines.map((line) => ({ sql: `UPDATE implementation_lines SET project_id=?,demand_material_id=? WHERE id=? AND implementation_id=?`, params: [s.projectId!, line.demandMaterialId, line.id, s.id] } as DatabaseStatement)),
      auditStatement(input.meta, 'implementation.historical.link', 'implementation', s.id, { projectId: null, version: input.expectedRecordVersion }, { projectId: s.projectId, version: s.version }), idempotencyStatement(input.meta),
    ]);
  }

  async createSettlement(input: { expectedProjectVersion: number; summary: SettlementSummary; meta: LegacyWriteMeta }): Promise<void> {
    const s = input.summary;
    await this.database.batch([
      projectGuard(s.projectId, input.expectedProjectVersion, input.meta.now),
      { sql: `INSERT INTO settlements (id,project_id,settlement_date,amount_fen,final,note,version,voided_at,voided_by,void_reason,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,1,NULL,NULL,NULL,?,?,?)`, params: [s.id, s.projectId, s.settlementDate, s.amountFen, s.final ? 1 : 0, s.note, input.meta.actorId, input.meta.now, input.meta.now] },
      ...s.coverage.map((item) => ({ sql: `INSERT INTO settlement_coverage (id,settlement_id,project_id,demand_material_id,quantity_scaled,created_at) VALUES (?,?,?,?,?,?)`, params: [crypto.randomUUID(), s.id, s.projectId, item.demandMaterialId, item.quantityScaled, input.meta.now] } as DatabaseStatement)),
      ...s.agreementAllocations.map((item) => ({ sql: `INSERT INTO settlement_agreement_allocations (id,settlement_id,agreement_id,amount_fen,created_at) VALUES (?,?,?,?,?)`, params: [crypto.randomUUID(), s.id, item.agreementId, item.amountFen, input.meta.now] } as DatabaseStatement)),
      auditStatement(input.meta, 'settlement.create', 'settlement', s.id, null, s), idempotencyStatement(input.meta),
    ]);
  }

  async voidSettlement(input: { expectedProjectVersion: number; expectedSettlementVersion: number; summary: SettlementSummary; reason: string; meta: LegacyWriteMeta }): Promise<void> {
    const s = input.summary;
    await this.database.batch([
      projectGuard(s.projectId, input.expectedProjectVersion, input.meta.now),
      { sql: `UPDATE settlements SET voided_at=?,voided_by=?,void_reason=?,version=version+1,updated_at=CASE WHEN version=? THEN ? ELSE NULL END WHERE id=? AND voided_at IS NULL`, params: [input.meta.now, input.meta.actorId, input.reason, input.expectedSettlementVersion, input.meta.now, s.id] },
      auditStatement(input.meta, 'settlement.void', 'settlement', s.id, { version: input.expectedSettlementVersion, voidedAt: null }, { version: s.version, voidedAt: s.voidedAt, reason: input.reason }), idempotencyStatement(input.meta),
    ]);
  }
}
