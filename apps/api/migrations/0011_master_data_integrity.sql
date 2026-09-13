-- Append-only master-data consistency and history protection. 0009/0010 are frozen.
PRAGMA foreign_keys = ON;

CREATE TRIGGER master_line_parent_insert BEFORE INSERT ON transmission_lines
WHEN 1 AND NOT EXISTS (SELECT 1 FROM voltage_levels WHERE id=NEW.voltage_level_id AND enabled=1)
BEGIN SELECT RAISE(ABORT, 'VOLTAGE_LEVEL_NOT_FOUND'); END;
CREATE TRIGGER master_tower_parent_insert BEFORE INSERT ON transmission_towers
WHEN 1 AND NOT EXISTS (SELECT 1 FROM transmission_lines l JOIN voltage_levels v ON v.id=l.voltage_level_id WHERE l.id=NEW.line_id AND l.enabled=1 AND v.enabled=1)
BEGIN SELECT RAISE(ABORT, 'LINE_NOT_FOUND'); END;

CREATE TRIGGER master_line_parent_update BEFORE UPDATE ON transmission_lines
WHEN (NEW.voltage_level_id IS NOT OLD.voltage_level_id OR NEW.enabled=1) AND NOT EXISTS (SELECT 1 FROM voltage_levels WHERE id=NEW.voltage_level_id AND enabled=1)
BEGIN SELECT RAISE(ABORT, 'VOLTAGE_LEVEL_NOT_FOUND'); END;
CREATE TRIGGER master_tower_parent_update BEFORE UPDATE ON transmission_towers
WHEN (NEW.line_id IS NOT OLD.line_id OR NEW.enabled=1) AND NOT EXISTS (SELECT 1 FROM transmission_lines l JOIN voltage_levels v ON v.id=l.voltage_level_id WHERE l.id=NEW.line_id AND l.enabled=1 AND v.enabled=1)
BEGIN SELECT RAISE(ABORT, 'LINE_NOT_FOUND'); END;

CREATE TRIGGER master_line_reference_update BEFORE UPDATE ON transmission_lines
WHEN NEW.voltage_level_id IS NOT OLD.voltage_level_id AND EXISTS (SELECT 1 FROM demands WHERE line_id=OLD.id)
BEGIN SELECT RAISE(ABORT, 'LINE_LOCATION_IN_USE'); END;
CREATE TRIGGER master_voltage_reference_update BEFORE UPDATE ON voltage_levels
WHEN (NEW.nominal_kv IS NOT OLD.nominal_kv OR NEW.system_type IS NOT OLD.system_type)
 AND EXISTS (SELECT 1 FROM demands WHERE voltage_level_id=OLD.id)
BEGIN SELECT RAISE(ABORT, 'VOLTAGE_LOCATION_IN_USE'); END;
-- A tower inside a range is referenced even when it is not an endpoint.
-- Freeze order/identity for the entire referenced line to preserve existing section semantics.
CREATE TRIGGER master_tower_reference_update BEFORE UPDATE ON transmission_towers
WHEN (NEW.line_id IS NOT OLD.line_id OR NEW.sort_index IS NOT OLD.sort_index OR NEW.tower_no IS NOT OLD.tower_no)
 AND EXISTS (SELECT 1 FROM demands WHERE line_id=OLD.line_id OR line_id=NEW.line_id)
BEGIN SELECT RAISE(ABORT, 'TOWER_LOCATION_IN_USE'); END;
CREATE TRIGGER master_tower_reference_delete BEFORE DELETE ON transmission_towers
WHEN EXISTS (SELECT 1 FROM demands WHERE line_id=OLD.line_id)
BEGIN SELECT RAISE(ABORT, 'TOWER_LOCATION_IN_USE'); END;
CREATE TRIGGER master_line_reference_delete BEFORE DELETE ON transmission_lines
WHEN EXISTS (SELECT 1 FROM demands WHERE line_id=OLD.id) OR EXISTS (SELECT 1 FROM transmission_towers WHERE line_id=OLD.id)
BEGIN SELECT RAISE(ABORT, 'MASTER_DATA_IN_USE'); END;
CREATE TRIGGER master_voltage_reference_delete BEFORE DELETE ON voltage_levels
WHEN EXISTS (SELECT 1 FROM demands WHERE voltage_level_id=OLD.id) OR EXISTS (SELECT 1 FROM transmission_lines WHERE voltage_level_id=OLD.id)
BEGIN SELECT RAISE(ABORT, 'MASTER_DATA_IN_USE'); END;

CREATE TRIGGER demand_grid_location_insert BEFORE INSERT ON demands
WHEN NEW.voltage_level_id IS NOT NULL OR NEW.line_id IS NOT NULL OR NEW.location_type IS NOT NULL OR NEW.start_tower_id IS NOT NULL OR NEW.end_tower_id IS NOT NULL
BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM transmission_lines l JOIN voltage_levels v ON v.id=l.voltage_level_id
  WHERE l.id=NEW.line_id AND v.id=NEW.voltage_level_id
 ) THEN RAISE(ABORT, 'INVALID_GRID_LOCATION') END;
 SELECT CASE WHEN NOT (
  (NEW.location_type='whole_line' AND NEW.start_tower_id IS NULL AND NEW.end_tower_id IS NULL)
  OR (NEW.location_type='tower' AND NEW.start_tower_id=NEW.end_tower_id AND EXISTS(SELECT 1 FROM transmission_towers WHERE id=NEW.start_tower_id AND line_id=NEW.line_id))
  OR (NEW.location_type='tower_range' AND EXISTS(SELECT 1 FROM transmission_towers s JOIN transmission_towers e ON e.line_id=s.line_id WHERE s.id=NEW.start_tower_id AND e.id=NEW.end_tower_id AND s.line_id=NEW.line_id AND s.sort_index<e.sort_index))
 ) OR NEW.location_type IS NULL THEN RAISE(ABORT, 'INVALID_GRID_LOCATION') END;
END;

CREATE TRIGGER demand_grid_location_update BEFORE UPDATE OF voltage_level_id,line_id,location_type,start_tower_id,end_tower_id ON demands
WHEN NEW.voltage_level_id IS NOT NULL OR NEW.line_id IS NOT NULL OR NEW.location_type IS NOT NULL OR NEW.start_tower_id IS NOT NULL OR NEW.end_tower_id IS NOT NULL
BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM transmission_lines l JOIN voltage_levels v ON v.id=l.voltage_level_id
  WHERE l.id=NEW.line_id AND v.id=NEW.voltage_level_id
 ) THEN RAISE(ABORT, 'INVALID_GRID_LOCATION') END;
 SELECT CASE WHEN NOT (
  (NEW.location_type='whole_line' AND NEW.start_tower_id IS NULL AND NEW.end_tower_id IS NULL)
  OR (NEW.location_type='tower' AND NEW.start_tower_id=NEW.end_tower_id AND EXISTS(SELECT 1 FROM transmission_towers WHERE id=NEW.start_tower_id AND line_id=NEW.line_id))
  OR (NEW.location_type='tower_range' AND EXISTS(SELECT 1 FROM transmission_towers s JOIN transmission_towers e ON e.line_id=s.line_id WHERE s.id=NEW.start_tower_id AND e.id=NEW.end_tower_id AND s.line_id=NEW.line_id AND s.sort_index<e.sort_index))
 ) OR NEW.location_type IS NULL THEN RAISE(ABORT, 'INVALID_GRID_LOCATION') END;
END;
