import { describe, expect, it } from 'vitest';
import { normalizeTowerNo } from '@tpm/shared';

describe('杆塔编号规范化', () => {
  it.each([
    ['1', '#001'],
    ['10', '#010'],
    ['010', '#010'],
    ['#10', '#010'],
    ['0010', '#010'],
    ['10-1', '#010-1'],
    ['#010-1', '#010-1'],
    ['10-01', '#010-1'],
    ['99-12', '#099-12'],
    ['100', '#100'],
    ['999', '#999'],
    ['1000', '#1000'],
    ['3058', '#3058'],
    ['3058-2', '#3058-2'],
    ['＃１０－１', '#010-1'],
  ])('把 %s 规范为 %s', (input, expected) => {
    expect(normalizeTowerNo(input)).toBe(expected);
  });

  it.each([
    '',
    '0',
    '#000',
    '10-0',
    'G1',
    '10A',
    '10+1',
    '10-1-2',
    '10/1',
    '#ABC',
  ])('拒绝无法识别的杆塔编号 %s', (input) => {
    expect(normalizeTowerNo(input)).toBeNull();
  });
});
