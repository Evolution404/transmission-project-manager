import type { ParsedSpreadsheet } from './parser';

interface WorkerResponse {
  ok: boolean;
  data?: ParsedSpreadsheet;
  error?: string;
}

export async function parseFileInWorker(file: File): Promise<ParsedSpreadsheet> {
  const data = await file.arrayBuffer();
  return new Promise<ParsedSpreadsheet>((resolve, reject) => {
    const worker = new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => worker.terminate();

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      finish();
      if (event.data.ok && event.data.data) {
        resolve(event.data.data);
        return;
      }
      reject(new Error(event.data.error ?? 'SPREADSHEET_PARSE_FAILED: Worker 未返回有效结果'));
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || 'SPREADSHEET_WORKER_FAILED: Worker 执行失败'));
    };
    worker.postMessage({ name: file.name, data }, [data]);
  });
}
