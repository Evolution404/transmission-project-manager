import type { ObjectStorePort, ObjectStorePutOptions, StoredObject } from '../../ports/object-store';

type FetchLike = typeof fetch;

export interface NotionObjectStoreOptions {
  token: string;
  dataSourceId: string;
  apiVersion?: string;
  fetchFn?: FetchLike;
  now?: () => string;
}

type JsonObject = Record<string, unknown>;

const API_ROOT = 'https://api.notion.com/v1';
const RETRYABLE_STATUS = new Set([429, 502, 503, 504, 529]);

function toBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
}

function richTextValue(value: string): Array<{ type: 'text'; text: { content: string } }> {
  if (!value) return [];
  const chunks: Array<{ type: 'text'; text: { content: string } }> = [];
  for (let offset = 0; offset < value.length; offset += 1800) {
    chunks.push({ type: 'text', text: { content: value.slice(offset, offset + 1800) } });
  }
  return chunks;
}

function propertyPlainText(property: unknown): string {
  if (!property || typeof property !== 'object') return '';
  const row = property as Record<string, unknown>;
  const type = row.type;
  const values = type === 'title' ? row.title : type === 'rich_text' ? row.rich_text : null;
  if (!Array.isArray(values)) return '';
  return values.map((value) => {
    if (!value || typeof value !== 'object') return '';
    const item = value as Record<string, unknown>;
    if (typeof item.plain_text === 'string') return item.plain_text;
    const text = item.text;
    return text && typeof text === 'object' && typeof (text as Record<string, unknown>).content === 'string'
      ? String((text as Record<string, unknown>).content)
      : '';
  }).join('');
}

function propertyNumber(property: unknown): number | null {
  if (!property || typeof property !== 'object') return null;
  const value = (property as Record<string, unknown>).number;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeCustomMetadata(value: string): Readonly<Record<string, string>> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, item]) => typeof item === 'string')) as Record<string, string>;
  } catch {
    return {};
  }
}

function fileUrl(property: unknown): string | null {
  if (!property || typeof property !== 'object') return null;
  const files = (property as Record<string, unknown>).files;
  if (!Array.isArray(files) || !files.length) return null;
  const first = files[0];
  if (!first || typeof first !== 'object') return null;
  const row = first as Record<string, unknown>;
  if (row.type === 'file' && row.file && typeof row.file === 'object') {
    const url = (row.file as Record<string, unknown>).url;
    return typeof url === 'string' ? url : null;
  }
  if (row.type === 'external' && row.external && typeof row.external === 'object') {
    const url = (row.external as Record<string, unknown>).url;
    return typeof url === 'string' ? url : null;
  }
  return null;
}

function displayName(key: string): string {
  const tail = key.split('/').filter(Boolean).at(-1) ?? 'object';
  return tail.slice(0, 240) || 'object';
}

async function wait(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

export class NotionObjectStoreAdapter implements ObjectStorePort {
  private readonly token: string;
  private readonly dataSourceId: string;
  private readonly apiVersion: string;
  private readonly fetchFn: FetchLike;
  private readonly now: () => string;

  constructor(options: NotionObjectStoreOptions) {
    if (!options.token.trim()) throw new Error('NOTION_API_TOKEN_REQUIRED');
    if (!options.dataSourceId.trim()) throw new Error('NOTION_STORAGE_DATA_SOURCE_ID_REQUIRED');
    this.token = options.token;
    this.dataSourceId = options.dataSourceId;
    this.apiVersion = options.apiVersion ?? '2026-03-11';
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private headers(contentType = true): Headers {
    const headers = new Headers({
      Authorization: `Bearer ${this.token}`,
      'Notion-Version': this.apiVersion,
    });
    if (contentType) headers.set('Content-Type', 'application/json');
    return headers;
  }

  private async requestJson(path: string, init: RequestInit = {}): Promise<JsonObject> {
    let attempt = 0;
    while (true) {
      const response = await this.fetchFn(`${API_ROOT}${path}`, {
        ...init,
        headers: init.headers ?? this.headers(!(init.body instanceof FormData)),
      });
      if (response.ok) return await response.json() as JsonObject;
      const retryAfter = Number(response.headers.get('retry-after'));
      if (RETRYABLE_STATUS.has(response.status) && attempt < 3) {
        const delay = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 250 * (2 ** attempt);
        attempt += 1;
        await wait(Math.min(delay, 5000));
        continue;
      }
      let code = 'unknown';
      try {
        const error = await response.json() as Record<string, unknown>;
        if (typeof error.code === 'string') code = error.code;
      } catch {
        // Keep the error value intentionally non-sensitive.
      }
      throw new Error(`NOTION_API_ERROR:${response.status}:${code}`);
    }
  }

  private async findActivePage(key: string): Promise<JsonObject | null> {
    const result = await this.requestJson(`/data_sources/${encodeURIComponent(this.dataSourceId)}/query`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        filter: {
          and: [
            { property: 'Object Key', title: { equals: key } },
            { property: 'State', select: { equals: 'active' } },
          ],
        },
        page_size: 1,
      }),
    });
    const results = Array.isArray(result.results) ? result.results : [];
    const first = results[0];
    return first && typeof first === 'object' ? first as JsonObject : null;
  }

  private async createFileUpload(bytes: Uint8Array, contentType: string | null, name: string): Promise<string> {
    const createBody: Record<string, unknown> = { mode: 'single_part' };
    if (contentType) createBody.content_type = contentType;
    if (name.includes('.')) createBody.filename = name;
    const upload = await this.requestJson('/file_uploads', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(createBody),
    });
    const id = typeof upload.id === 'string' ? upload.id : '';
    if (!id) throw new Error('NOTION_FILE_UPLOAD_ID_MISSING');

    const form = new FormData();
    form.append('file', new Blob([bytes], { type: contentType ?? 'application/octet-stream' }), name);
    const sent = await this.requestJson(`/file_uploads/${encodeURIComponent(id)}/send`, {
      method: 'POST',
      headers: this.headers(false),
      body: form,
    });
    if (sent.status !== 'uploaded') throw new Error('NOTION_FILE_UPLOAD_INCOMPLETE');
    return id;
  }

  private pageProperties(key: string, uploadId: string, bytes: Uint8Array, options?: ObjectStorePutOptions): Record<string, unknown> {
    const now = this.now();
    const contentType = options?.contentType ?? '';
    const custom = JSON.stringify(options?.custom ?? {});
    return {
      'Object Key': { type: 'title', title: richTextValue(key) },
      File: {
        type: 'files',
        files: [{
          type: 'file_upload',
          file_upload: { id: uploadId },
          name: displayName(key),
        }],
      },
      'Content Type': { type: 'rich_text', rich_text: richTextValue(contentType) },
      'Size Bytes': { type: 'number', number: bytes.byteLength },
      'Custom Metadata': { type: 'rich_text', rich_text: richTextValue(custom) },
      State: { type: 'select', select: { name: 'active' } },
      'Updated At': { type: 'date', date: { start: now } },
    };
  }

  async put(key: string, value: Uint8Array | string, options?: ObjectStorePutOptions): Promise<void> {
    if (!key || key.length > 1800) throw new Error('INVALID_OBJECT_KEY');
    const bytes = toBytes(value);
    const existing = await this.findActivePage(key);
    const uploadId = await this.createFileUpload(bytes, options?.contentType ?? null, displayName(key));
    const properties = this.pageProperties(key, uploadId, bytes, options);
    if (existing && typeof existing.id === 'string') {
      await this.requestJson(`/pages/${encodeURIComponent(existing.id)}`, {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({ properties }),
      });
      return;
    }
    (properties['Created At'] as Record<string, unknown>) = { type: 'date', date: { start: this.now() } };
    await this.requestJson('/pages', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        parent: { type: 'data_source_id', data_source_id: this.dataSourceId },
        properties,
      }),
    });
  }

  async get(key: string): Promise<StoredObject | null> {
    const page = await this.findActivePage(key);
    if (!page) return null;
    const properties = page.properties;
    if (!properties || typeof properties !== 'object') return null;
    const map = properties as Record<string, unknown>;
    const url = fileUrl(map.File);
    if (!url) return null;
    const contentType = propertyPlainText(map['Content Type']) || null;
    const sizeBytes = propertyNumber(map['Size Bytes']);
    const custom = safeCustomMetadata(propertyPlainText(map['Custom Metadata']));
    let cached: Promise<Uint8Array> | null = null;
    return {
      key,
      metadata: {
        contentType,
        sizeBytes: sizeBytes ?? 0,
        custom,
      },
      bytes: () => {
        cached ??= this.fetchFn(url).then(async response => {
          if (!response.ok) throw new Error(`NOTION_FILE_DOWNLOAD_FAILED:${response.status}`);
          return new Uint8Array(await response.arrayBuffer());
        });
        return cached;
      },
    };
  }

  async delete(key: string): Promise<void> {
    const page = await this.findActivePage(key);
    if (!page || typeof page.id !== 'string') return;
    await this.requestJson(`/pages/${encodeURIComponent(page.id)}`, {
      method: 'PATCH',
      headers: this.headers(),
      body: JSON.stringify({ in_trash: true }),
    });
  }
}
