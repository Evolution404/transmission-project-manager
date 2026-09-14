-- Active-state checks belong to atomic API write guards; restore must accept disabled historical assets.
DROP TRIGGER master_line_parent_insert;
DROP TRIGGER master_tower_parent_insert;
CREATE TABLE master_data_guards (valid INTEGER NOT NULL);
CREATE TRIGGER master_data_guard BEFORE INSERT ON master_data_guards
WHEN NEW.valid <> 1
BEGIN SELECT RAISE(ABORT, 'INVALID_GRID_LOCATION'); END;
CREATE TRIGGER master_data_guard_cleanup AFTER INSERT ON master_data_guards
BEGIN DELETE FROM master_data_guards; END;

DROP TRIGGER demand_grid_location_insert;
CREATE TRIGGER demand_grid_location_insert BEFORE INSERT ON demands
WHEN NEW.voltage_level_id IS NOT NULL OR NEW.line_id IS NOT NULL OR NEW.location_type IS NOT NULL OR NEW.start_tower_id IS NOT NULL OR NEW.end_tower_id IS NOT NULL
BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM transmission_lines l JOIN voltage_levels v ON v.id=l.voltage_level_id
  WHERE l.id=NEW.line_id AND v.id=NEW.voltage_level_id
 ) THEN RAISE(ABORT, 'INVALID_GRID_LOCATION') END;
 SELECT CASE WHEN NOT COALESCE((
  (NEW.location_type='whole_line' AND NEW.start_tower_id IS NULL AND NEW.end_tower_id IS NULL)
  OR (NEW.location_type='tower' AND NEW.start_tower_id=NEW.end_tower_id AND EXISTS(SELECT 1 FROM transmission_towers WHERE id=NEW.start_tower_id AND line_id=NEW.line_id))
  OR (NEW.location_type='tower_range' AND EXISTS(SELECT 1 FROM transmission_towers s JOIN transmission_towers e ON e.line_id=s.line_id WHERE s.id=NEW.start_tower_id AND e.id=NEW.end_tower_id AND s.line_id=NEW.line_id AND s.sort_index<e.sort_index))
 ),0) THEN RAISE(ABORT, 'INVALID_GRID_LOCATION') END;
END;

DROP TRIGGER demand_grid_location_update;
CREATE TRIGGER demand_grid_location_update BEFORE UPDATE OF voltage_level_id,line_id,location_type,start_tower_id,end_tower_id ON demands
WHEN NEW.voltage_level_id IS NOT NULL OR NEW.line_id IS NOT NULL OR NEW.location_type IS NOT NULL OR NEW.start_tower_id IS NOT NULL OR NEW.end_tower_id IS NOT NULL
BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM transmission_lines l JOIN voltage_levels v ON v.id=l.voltage_level_id
  WHERE l.id=NEW.line_id AND v.id=NEW.voltage_level_id
 ) THEN RAISE(ABORT, 'INVALID_GRID_LOCATION') END;
 SELECT CASE WHEN NOT COALESCE((
  (NEW.location_type='whole_line' AND NEW.start_tower_id IS NULL AND NEW.end_tower_id IS NULL)
  OR (NEW.location_type='tower' AND NEW.start_tower_id=NEW.end_tower_id AND EXISTS(SELECT 1 FROM transmission_towers WHERE id=NEW.start_tower_id AND line_id=NEW.line_id))
  OR (NEW.location_type='tower_range' AND EXISTS(SELECT 1 FROM transmission_towers s JOIN transmission_towers e ON e.line_id=s.line_id WHERE s.id=NEW.start_tower_id AND e.id=NEW.end_tower_id AND s.line_id=NEW.line_id AND s.sort_index<e.sort_index))
 ),0) THEN RAISE(ABORT, 'INVALID_GRID_LOCATION') END;
END;
