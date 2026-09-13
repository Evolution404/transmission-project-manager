import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { ObjectStorePort, ObjectStorePutOptions, StoredObject } from '../../ports/object-store';

type FileMetadata = {
  contentType: string | null;
  custom: Record<string, string>;
};

function safeSegments(key: string): string[] {
  if (!key || key.includes('\0') || key.includes('\\')) throw new Error('INVALID_OBJECT_KEY');
  const segments = key.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new Error('INVALID_OBJECT_KEY');
  return segments;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT';
}

export class FilesystemObjectStoreAdapter implements ObjectStorePort {
  private readonly rootDir: string;
  private readonly dataDir: string;
  private readonly metadataDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
    this.dataDir = resolve(this.rootDir, 'data');
    this.metadataDir = resolve(this.rootDir, 'metadata');
  }

  private dataPath(key: string): string {
    const path = resolve(this.dataDir, ...safeSegments(key));
    if (path !== this.dataDir && !path.startsWith(`${this.dataDir}${sep}`)) throw new Error('INVALID_OBJECT_KEY');
    return path;
  }

  private metadataPath(key: string): string {
    const hash = createHash('sha256').update(key).digest('hex');
    return resolve(this.metadataDir, `${hash}.json`);
  }

  async put(key: string, value: Uint8Array | string, options?: ObjectStorePutOptions): Promise<void> {
    const dataPath = this.dataPath(key);
    const metadataPath = this.metadataPath(key);
    await mkdir(resolve(dataPath, '..'), { recursive: true });
    await mkdir(this.metadataDir, { recursive: true });
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    const metadata: FileMetadata = {
      contentType: options?.contentType ?? null,
      custom: { ...(options?.custom ?? {}) },
    };
    await Promise.all([
      writeFile(dataPath, bytes),
      writeFile(metadataPath, JSON.stringify(metadata), 'utf8'),
    ]);
  }

  async get(key: string): Promise<StoredObject | null> {
    const dataPath = this.dataPath(key);
    const metadataPath = this.metadataPath(key);
    let info;
    try {
      info = await stat(dataPath);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }

    let metadata: FileMetadata = { contentType: null, custom: {} };
    try {
      metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as FileMetadata;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    let cached: Promise<Uint8Array> | null = null;
    return {
      key,
      metadata: {
        contentType: metadata.contentType ?? null,
        sizeBytes: info.size,
        custom: { ...(metadata.custom ?? {}) },
      },
      bytes: () => {
        cached ??= readFile(dataPath).then((buffer) => new Uint8Array(buffer));
        return cached;
      },
    };
  }

  async delete(key: string): Promise<void> {
    const dataPath = this.dataPath(key);
    const metadataPath = this.metadataPath(key);
    await Promise.all([
      unlink(dataPath).catch((error: unknown) => { if (!isNotFound(error)) throw error; }),
      unlink(metadataPath).catch((error: unknown) => { if (!isNotFound(error)) throw error; }),
    ]);
  }
}
