/** Transaction-time validation also detects renamed assets since validation/selection. */
export function gridLocationGuard(db: D1Database, voltageId: string, lineId: string, startId: string | null, endId: string | null, voltageName: string, lineName: string, section: string) {
  return db.prepare(`INSERT INTO master_data_guards (valid) VALUES (CASE WHEN EXISTS (
    SELECT 1 FROM transmission_lines l JOIN voltage_levels v ON v.id=l.voltage_level_id
    WHERE l.id=? AND v.id=? AND l.enabled=1 AND v.enabled=1 AND v.display_name=? AND l.line_name=?
    AND ((? IS NULL AND ? IS NULL AND ?='全线') OR EXISTS (
      SELECT 1 FROM transmission_towers s JOIN transmission_towers e ON e.line_id=s.line_id
      WHERE s.id=? AND e.id=? AND s.line_id=l.id AND s.enabled=1 AND e.enabled=1 AND s.sort_index<=e.sort_index
      AND (CASE WHEN s.id=e.id THEN s.tower_no ELSE s.tower_no || '—' || e.tower_no END)=?
    ))
  ) THEN 1 ELSE 0 END)`).bind(lineId, voltageId, voltageName, lineName, startId, endId, section, startId, endId, section);
}
