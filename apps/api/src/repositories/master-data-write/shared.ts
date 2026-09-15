import type { CustomFieldEntityType } from '@tpm/shared';
import type { MasterConfigKind, MasterDataWriteKind } from '../../ports/master-data-write-repository.ts';

export const masterDataTables: Readonly<Record<MasterDataWriteKind, string>> = {
  'voltage-level': 'voltage_levels',
  line: 'transmission_lines',
  'tower-position': 'line_tower_positions',
};

export const masterConfigTables: Readonly<Record<MasterConfigKind, string>> = {
  team: 'teams',
  'tower-type': 'tower_types',
  'custom-field': 'custom_field_definitions',
};

export const customFieldEntityTables: Readonly<Record<CustomFieldEntityType, string>> = {
  physical_tower: 'physical_towers',
  transmission_line: 'transmission_lines',
  line_tower_position: 'line_tower_positions',
  demand: 'demands',
  project: 'projects',
  project_task: 'project_tasks',
};

export function jsonValue(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value);
}
