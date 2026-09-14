export interface ObjectMetadata {
  contentType: string | null;
  sizeBytes: number;
  custom: Readonly<Record<string, string>>;
}

export interface StoredObject {
  key: string;
  metadata: ObjectMetadata;
  bytes(): Promise<Uint8Array>;
}

export interface ObjectStorePutOptions {
  contentType?: string;
  custom?: Readonly<Record<string, string>>;
}

export interface ObjectStorePort {
  put(key: string, value: Uint8Array | string, options?: ObjectStorePutOptions): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}
