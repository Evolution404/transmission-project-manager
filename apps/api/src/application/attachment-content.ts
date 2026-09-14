import type { ObjectStorePort } from '../ports/object-store';

export interface AttachmentContent {
  bytes: Uint8Array;
  contentType: string | null;
  sizeBytes: number;
}

export async function saveAttachmentContent(
  objectStore: ObjectStorePort,
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  await objectStore.put(key, bytes, { contentType });
}

export async function loadAttachmentContent(
  objectStore: ObjectStorePort,
  key: string,
): Promise<AttachmentContent | null> {
  const object = await objectStore.get(key);
  if (!object) return null;
  return {
    bytes: await object.bytes(),
    contentType: object.metadata.contentType,
    sizeBytes: object.metadata.sizeBytes,
  };
}

export async function deleteAttachmentContent(objectStore: ObjectStorePort, key: string): Promise<void> {
  await objectStore.delete(key);
}
