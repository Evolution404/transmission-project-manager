import type { DatabasePort, DatabaseStatement, DatabaseValue } from '../../ports/database.ts';
import type {
  CommitLineRenameInput,
  CommitTowerImportChunkInput,
  CommitTowerMoveInput,
  CommitTowerReorderInput,
  CommitTowerRenameInput,
} from '../../ports/master-data-write-repository.ts';
import { singleMasterBusinessStatement } from './single-master-write.ts';
import { jsonValue } from './shared.ts';

export async function commitTowerImportChunk(database: DatabasePort, input: CommitTowerImportChunkInput): Promise<void> {
  const updates = input.items.filter((item) => item.action === 'update');
  const updateCondition = updates.length
    ? updates.map(() => 'EXISTS(SELECT 1 FROM line_tower_positions WHERE id=? AND line_id=? AND version=?)').join(' AND ')
    : '1';
  const updateParams = updates.flatMap((item) => [item.id, input.lineId, item.expectedVersion!] as DatabaseValue[]);
  const statements: DatabaseStatement[] = [{
    sql: `INSERT INTO idempotency_records
          (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
          VALUES (?,?,?,CASE WHEN EXISTS(
            SELECT 1 FROM transmission_lines WHERE id=? AND tower_order_version=?
          ) AND ${updateCondition} THEN ? ELSE NULL END,?,?,?)`,
    params: [input.mutation.key, input.mutation.actorId, input.mutation.operation, input.lineId, input.expectedTowerOrderVersion, ...updateParams, input.mutation.hash, input.mutation.responseJson, input.mutation.statusCode, input.mutation.now],
  }, {
    sql: `INSERT INTO master_data_guards (id,line_parent)
          VALUES (1,CASE WHEN EXISTS (
            SELECT 1 FROM transmission_lines l JOIN voltage_levels v ON v.id=l.voltage_level_id
            WHERE l.id=? AND l.enabled=1 AND v.enabled=1
          ) THEN 1 ELSE 0 END)
          ON CONFLICT(id) DO UPDATE SET line_parent=excluded.line_parent`,
    params: [input.lineId],
  }];

  if (input.rebalanceTowerOrder) {
    statements.push({
      sql: `WITH ranked(id,new_rank) AS MATERIALIZED (
              SELECT id,-ROW_NUMBER() OVER (ORDER BY sort_rank,id)*1000
              FROM line_tower_positions WHERE line_id=?
            )
            UPDATE line_tower_positions
            SET sort_rank=(SELECT new_rank FROM ranked WHERE ranked.id=line_tower_positions.id)
            WHERE line_id=?`,
      params: [input.lineId, input.lineId],
    }, {
      sql: 'UPDATE line_tower_positions SET sort_rank=-sort_rank WHERE line_id=?',
      params: [input.lineId],
    });
  }

  for (const item of input.items) {
    if (item.createPhysicalTower) {
      const physical = item.createPhysicalTower;
      statements.push({
        sql: `INSERT INTO physical_towers
              (id,asset_code,tower_type_id,maintenance_team_id,enabled,version,created_at,updated_at)
              VALUES (?,?,?,?,?,1,?,?)`,
        params: [physical.id, physical.assetCode, physical.towerTypeId, physical.maintenanceTeamId, physical.enabled ? 1 : 0, input.mutation.now, input.mutation.now],
      });
    }
    statements.push(singleMasterBusinessStatement({
      kind: 'tower-position',
      action: item.action,
      id: item.id,
      values: item.values,
      expectedVersion: item.expectedVersion,
      mutation: input.mutation,
      audit: { action: '', objectType: '', before: null, after: null },
    }));
  }
  if (input.changesTowerOrder) {
    statements.push({
      sql: `UPDATE transmission_lines
            SET tower_order_version=tower_order_version+1,updated_at=?
            WHERE id=? AND tower_order_version=?`,
      params: [input.mutation.now, input.lineId, input.expectedTowerOrderVersion],
    });
  }
  statements.push({
    sql: `INSERT INTO audit_events
          (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
    params: [input.mutation.auditId, input.mutation.actorId, input.audit.action, input.audit.objectType, input.lineId, jsonValue(input.audit.before), jsonValue(input.audit.after), input.mutation.now],
  });
  await database.batch(statements);
}

export async function commitTowerReorder(database: DatabasePort, input: CommitTowerReorderInput): Promise<void> {
  const idsJson = JSON.stringify(input.towerIds);
  await database.batch([{
    sql: `INSERT INTO idempotency_records
          (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
          VALUES (?,?,?,CASE WHEN EXISTS(
            SELECT 1 FROM transmission_lines WHERE id=? AND tower_order_version=?
          ) AND (SELECT COUNT(*) FROM line_tower_positions WHERE line_id=?)=?
            AND NOT EXISTS(
              SELECT 1 FROM line_tower_positions t
              WHERE t.line_id=? AND t.id NOT IN (SELECT value FROM json_each(?))
            )
          THEN ? ELSE NULL END,?,?,?)`,
    params: [input.mutation.key, input.mutation.actorId, input.mutation.operation, input.lineId, input.expectedTowerOrderVersion, input.lineId, input.towerIds.length, input.lineId, idsJson, input.mutation.hash, input.mutation.responseJson, input.mutation.statusCode, input.mutation.now],
  }, {
    sql: `WITH desired(id,new_rank) AS MATERIALIZED (
            SELECT value,-(CAST(key AS INTEGER)+1)*1000 FROM json_each(?)
          )
          UPDATE line_tower_positions
          SET sort_rank=(SELECT new_rank FROM desired WHERE desired.id=line_tower_positions.id)
          WHERE line_id=?`,
    params: [idsJson, input.lineId],
  }, {
    sql: 'UPDATE line_tower_positions SET sort_rank=-sort_rank WHERE line_id=?',
    params: [input.lineId],
  }, {
    sql: `UPDATE transmission_lines
          SET tower_order_version=tower_order_version+1,updated_at=?
          WHERE id=? AND tower_order_version=?`,
    params: [input.mutation.now, input.lineId, input.expectedTowerOrderVersion],
  }, {
    sql: `INSERT INTO audit_events
          (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
    params: [input.mutation.auditId, input.mutation.actorId, input.audit.action, input.audit.objectType, input.lineId, jsonValue(input.audit.before), jsonValue(input.audit.after), input.mutation.now],
  }]);
}

export async function commitLineRename(database: DatabasePort, input: CommitLineRenameInput): Promise<void> {
  await database.batch([{
    sql: `INSERT INTO idempotency_records
          (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
          VALUES (?,?,?,CASE WHEN EXISTS(
            SELECT 1 FROM transmission_lines WHERE id=? AND version=?
          ) THEN ? ELSE NULL END,?,?,?)`,
    params: [input.mutation.key, input.mutation.actorId, input.mutation.operation, input.id, input.expectedVersion, input.mutation.hash, input.mutation.responseJson, input.mutation.statusCode, input.mutation.now],
  }, {
    sql: `INSERT INTO transmission_line_name_history
          (id,line_id,line_name,valid_from,valid_to,changed_by,change_reason,created_at)
          SELECT ?,id,line_name,name_valid_from,?,?,?,?
          FROM transmission_lines WHERE id=? AND version=?`,
    params: [input.historyId, input.mutation.now, input.mutation.actorId, input.reason, input.mutation.now, input.id, input.expectedVersion],
  }, {
    sql: `UPDATE transmission_lines
          SET line_name=?,name_valid_from=?,version=version+1,updated_at=?
          WHERE id=? AND version=?`,
    params: [input.lineName, input.mutation.now, input.mutation.now, input.id, input.expectedVersion],
  }, {
    sql: `INSERT INTO audit_events
          (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
    params: [input.mutation.auditId, input.mutation.actorId, input.audit.action, input.audit.objectType, input.id, jsonValue(input.audit.before), jsonValue(input.audit.after), input.mutation.now],
  }]);
}

export async function commitTowerRename(database: DatabasePort, input: CommitTowerRenameInput): Promise<void> {
  await database.batch([{
    sql: `INSERT INTO idempotency_records
          (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
          VALUES (?,?,?,CASE WHEN EXISTS(
            SELECT 1 FROM line_tower_positions WHERE id=? AND version=?
          ) THEN ? ELSE NULL END,?,?,?)`,
    params: [input.mutation.key, input.mutation.actorId, input.mutation.operation, input.id, input.expectedVersion, input.mutation.hash, input.mutation.responseJson, input.mutation.statusCode, input.mutation.now],
  }, {
    sql: `INSERT INTO line_tower_position_no_history
          (id,line_tower_position_id,line_id,tower_no,valid_from,valid_to,changed_by,change_reason,created_at)
          SELECT ?,id,line_id,tower_no,number_valid_from,?,?,?,?
          FROM line_tower_positions WHERE id=? AND version=?`,
    params: [input.historyId, input.mutation.now, input.mutation.actorId, input.reason, input.mutation.now, input.id, input.expectedVersion],
  }, {
    sql: `UPDATE line_tower_positions
          SET tower_no=?,number_valid_from=?,version=version+1,updated_at=?
          WHERE id=? AND version=?`,
    params: [input.towerNo, input.mutation.now, input.mutation.now, input.id, input.expectedVersion],
  }, {
    sql: `INSERT INTO audit_events
          (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
    params: [input.mutation.auditId, input.mutation.actorId, input.audit.action, input.audit.objectType, input.id, jsonValue(input.audit.before), jsonValue(input.audit.after), input.mutation.now],
  }]);
}

export async function commitTowerMove(database: DatabasePort, input: CommitTowerMoveInput): Promise<void> {
  const statements: DatabaseStatement[] = [{
    sql: `INSERT INTO idempotency_records
          (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
          VALUES (?,?,?,CASE WHEN EXISTS(
            SELECT 1 FROM transmission_lines WHERE id=? AND tower_order_version=?
          ) AND EXISTS(
            SELECT 1 FROM line_tower_positions WHERE id=? AND line_id=?
          ) AND EXISTS(
            SELECT 1 FROM line_tower_positions WHERE id=? AND line_id=?
          ) THEN ? ELSE NULL END,?,?,?)`,
    params: [input.mutation.key, input.mutation.actorId, input.mutation.operation, input.lineId, input.expectedTowerOrderVersion, input.towerId, input.lineId, input.targetTowerId, input.lineId, input.mutation.hash, input.mutation.responseJson, input.mutation.statusCode, input.mutation.now],
  }];
  if (input.rebalance) {
    statements.push({
      sql: `WITH ranked(id,new_rank) AS MATERIALIZED (
              SELECT id,-ROW_NUMBER() OVER (ORDER BY sort_rank,id)*1000
              FROM line_tower_positions WHERE line_id=?
            )
            UPDATE line_tower_positions
            SET sort_rank=(SELECT new_rank FROM ranked WHERE ranked.id=line_tower_positions.id)
            WHERE line_id=?`,
      params: [input.lineId, input.lineId],
    }, {
      sql: 'UPDATE line_tower_positions SET sort_rank=-sort_rank WHERE line_id=?',
      params: [input.lineId],
    });
  }
  statements.push({
    sql: 'UPDATE line_tower_positions SET sort_rank=-9007199254740000 WHERE id=? AND line_id=?',
    params: [input.towerId, input.lineId],
  });
  if (input.placement === 'before') {
    statements.push({
      sql: `UPDATE line_tower_positions
            SET sort_rank=(
              SELECT CAST((COALESCE((
                SELECT MAX(previous.sort_rank) FROM line_tower_positions previous
                WHERE previous.line_id=? AND previous.id<>? AND previous.sort_rank>0
                  AND previous.sort_rank<target.sort_rank
              ),0)+target.sort_rank)/2 AS INTEGER)
              FROM line_tower_positions target WHERE target.id=? AND target.line_id=?
            ),updated_at=?
            WHERE id=? AND line_id=?`,
      params: [input.lineId, input.towerId, input.targetTowerId, input.lineId, input.mutation.now, input.towerId, input.lineId],
    });
  } else {
    statements.push({
      sql: `UPDATE line_tower_positions
            SET sort_rank=(
              SELECT CASE WHEN (
                SELECT MIN(next.sort_rank) FROM line_tower_positions next
                WHERE next.line_id=? AND next.id<>? AND next.sort_rank>target.sort_rank
              ) IS NULL THEN target.sort_rank+1000 ELSE CAST((target.sort_rank+(
                SELECT MIN(next.sort_rank) FROM line_tower_positions next
                WHERE next.line_id=? AND next.id<>? AND next.sort_rank>target.sort_rank
              ))/2 AS INTEGER) END
              FROM line_tower_positions target WHERE target.id=? AND target.line_id=?
            ),updated_at=?
            WHERE id=? AND line_id=?`,
      params: [input.lineId, input.towerId, input.lineId, input.towerId, input.targetTowerId, input.lineId, input.mutation.now, input.towerId, input.lineId],
    });
  }
  statements.push({
    sql: `UPDATE transmission_lines
          SET tower_order_version=tower_order_version+1,updated_at=?
          WHERE id=? AND tower_order_version=?`,
    params: [input.mutation.now, input.lineId, input.expectedTowerOrderVersion],
  }, {
    sql: `INSERT INTO audit_events
          (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
    params: [input.mutation.auditId, input.mutation.actorId, input.audit.action, input.audit.objectType, input.towerId, jsonValue(input.audit.before), jsonValue(input.audit.after), input.mutation.now],
  });
  await database.batch(statements);
}
