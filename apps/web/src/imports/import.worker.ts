import { parseSpreadsheet } from './parser';

interface ParseWorkerRequest {
  name: string;
  data: ArrayBuffer;
}

self.onmessage = async (event: MessageEvent<ParseWorkerRequest>) => {
  try {
    const data = await parseSpreadsheet(event.data);
    self.postMessage({ ok: true, data });
  } catch (cause) {
    self.postMessage({
      ok: false,
      error: cause instanceof Error ? cause.message : 'SPREADSHEET_PARSE_FAILED: 未知解析错误',
    });
  }
};
