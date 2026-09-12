import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParsedSpreadsheet } from '../src/imports/parser';
import { parseFileInWorker } from '../src/imports/workerClient';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  posted: unknown[] = [];
  transfer: Transferable[] | undefined;

  constructor(public readonly url: URL, public readonly options?: WorkerOptions) {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown, transfer?: Transferable[]) {
    this.posted.push(message);
    this.transfer = transfer;
  }

  terminate() {
    this.terminated = true;
  }
}

describe('P2 spreadsheet worker client', () => {
  afterEach(() => {
    FakeWorker.instances = [];
    vi.unstubAllGlobals();
  });

  it('transfers file bytes to a module worker and resolves parsed results', async () => {
    vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
    const file = new File(['序号,线路名称\n1,龙城线\n'], '需求.csv', { type: 'text/csv' });
    const promise = parseFileInWorker(file);
    await Promise.resolve();

    const worker = FakeWorker.instances[0]!;
    expect(worker.options?.type).toBe('module');
    const posted = worker.posted[0] as { name: string; data: ArrayBuffer };
    expect(posted.name).toBe('需求.csv');
    expect(posted.data).toBeInstanceOf(ArrayBuffer);
    expect(worker.transfer).toEqual([posted.data]);

    const parsed: ParsedSpreadsheet = {
      fileType: 'csv',
      sheets: [{ name: 'Sheet1', headers: ['序号', '线路名称'], rows: [{ rowNumber: 2, cells: { 序号: 1, 线路名称: '龙城线' } }] }],
    };
    worker.onmessage?.(new MessageEvent('message', { data: { ok: true, data: parsed } }));
    await expect(promise).resolves.toEqual(parsed);
    expect(worker.terminated).toBe(true);
  });

  it('rejects worker parser errors and always terminates the worker', async () => {
    vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
    const file = new File(['x'], '旧表.xls');
    const promise = parseFileInWorker(file);
    await Promise.resolve();
    const worker = FakeWorker.instances[0]!;
    worker.onmessage?.(new MessageEvent('message', { data: { ok: false, error: 'XLS_UNSUPPORTED: 请另存为 .xlsx' } }));
    await expect(promise).rejects.toThrow(/XLS_UNSUPPORTED/);
    expect(worker.terminated).toBe(true);
  });
});
