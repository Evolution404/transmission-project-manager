import type { ObjectStorePort, ObjectStorePutOptions, StoredObject } from '../../ports/object-store';

export class R2ObjectStoreAdapter implements ObjectStorePort {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  async put(key: string, value: Uint8Array | string, options?: ObjectStorePutOptions): Promise<void> {
    await this.bucket.put(key, value, {
      ...(options?.contentType ? { httpMetadata: { contentType: options.contentType } } : {}),
      ...(options?.custom ? { customMetadata: { ...options.custom } } : {}),
    });
  }

  async get(key: string): Promise<StoredObject | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    let cached: Promise<Uint8Array> | null = null;
    return {
      key,
      metadata: {
        contentType: object.httpMetadata?.contentType ?? null,
        sizeBytes: object.size,
        custom: { ...(object.customMetadata ?? {}) },
      },
      bytes: () => {
        cached ??= object.arrayBuffer().then((buffer) => new Uint8Array(buffer));
        return cached;
      },
    };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}
