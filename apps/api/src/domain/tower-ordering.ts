import { compareTowerNo } from '@tpm/shared';

export function inferNewTowerOrder(
  existing: readonly { id: string; towerNo: string; sortRank: number }[],
  towerNo: string,
): { sortRank: number; rebalance: boolean } {
  if (!existing.length) return { sortRank: 1000, rebalance: false };

  let insertIndex = existing.findIndex((item) => compareTowerNo(towerNo, item.towerNo) < 0);
  if (insertIndex < 0) insertIndex = existing.length;
  const left = insertIndex > 0 ? existing[insertIndex - 1]! : null;
  const right = insertIndex < existing.length ? existing[insertIndex]! : null;

  if (!left && right) {
    if (right.sortRank > 1) return { sortRank: Math.floor(right.sortRank / 2), rebalance: false };
    return { sortRank: 500, rebalance: true };
  }
  if (left && !right) {
    if (left.sortRank <= Number.MAX_SAFE_INTEGER - 1000) return { sortRank: left.sortRank + 1000, rebalance: false };
    return { sortRank: (existing.length + 1) * 1000, rebalance: true };
  }
  if (left && right) {
    const gap = right.sortRank - left.sortRank;
    if (gap > 1) return { sortRank: Math.floor((left.sortRank + right.sortRank) / 2), rebalance: false };
    return { sortRank: insertIndex * 1000 + 500, rebalance: true };
  }
  return { sortRank: 1000, rebalance: false };
}

export function importedTowerRanks(
  existing: readonly { id: string; towerNo: string; sortRank: number }[],
  created: readonly { id: string; towerNo: string; sourceIndex: number }[],
): Map<string, number> {
  const byGap = new Map<number, Array<{ id: string; towerNo: string; sourceIndex: number }>>();
  for (const item of created) {
    let gap = existing.findIndex((current) => compareTowerNo(item.towerNo, current.towerNo) < 0);
    if (gap < 0) gap = existing.length;
    const group = byGap.get(gap) ?? [];
    group.push(item);
    byGap.set(gap, group);
  }
  const ranks = new Map<string, number>();
  for (const [gap, unsorted] of byGap) {
    const group = [...unsorted].sort((a, b) => compareTowerNo(a.towerNo, b.towerNo) || a.sourceIndex - b.sourceIndex);
    const leftRank = gap * 1000;
    if (gap === existing.length) {
      group.forEach((item, index) => ranks.set(item.id, leftRank + (index + 1) * 1000));
      continue;
    }
    const width = 1000;
    group.forEach((item, index) => ranks.set(item.id, leftRank + Math.floor(width * (index + 1) / (group.length + 1))));
  }
  return ranks;
}
