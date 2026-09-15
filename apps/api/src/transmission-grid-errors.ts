export const gridConstraintMessages: Readonly<Record<string, string>> = {
  VOLTAGE_LEVEL_NOT_FOUND: '电压等级不存在或已停用，请先维护基础台账',
  LINE_NOT_FOUND: '线路或所属电压等级不存在或已停用，请先维护基础台账',
  LINE_LOCATION_IN_USE: '线路已被需求或项目引用，不能更换电压等级',
  TOWER_LOCATION_IN_USE: '线路已有需求区段，不能跨线路移动或删除受保护杆塔；可停用',
  MASTER_DATA_IN_USE: '对象已被业务引用或仍有下级台账，不能删除；请停用',
  VOLTAGE_LOCATION_IN_USE: '电压等级已被业务引用，不能改变制式或标称电压',
  INVALID_GRID_LOCATION: '需求位置关联已变化或停用，请刷新并先维护基础台账',
};
