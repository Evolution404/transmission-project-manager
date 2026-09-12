import { CREDENTIAL_KDF, type DerivedCredentialInput } from '@tpm/shared';

interface WorkerSuccess {
  id: string;
  ok: true;
  credential: string;
}

interface WorkerFailure {
  id: string;
  ok: false;
  error: string;
}

type WorkerReply = WorkerSuccess | WorkerFailure;

let worker: Worker | null = null;
const pending = new Map<string, { resolve: (value: string) => void; reject: (reason: Error) => void }>();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function authWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./credential-worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if (event.data.ok) request.resolve(event.data.credential);
    else request.reject(new Error(event.data.error));
  };
  worker.onerror = () => {
    for (const request of pending.values()) request.reject(new Error('本地密码计算失败'));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function validatePasswordForClient(password: string): string | null {
  const length = Array.from(password).length;
  if (length < 15) return '密码至少需要 15 个字符';
  if (length > 128) return '密码最多允许 128 个字符';
  return null;
}

export async function deriveCredential(password: string, salt: string): Promise<string> {
  const id = crypto.randomUUID();
  const result = new Promise<string>((resolve, reject) => pending.set(id, { resolve, reject }));
  authWorker().postMessage({ id, password, salt });
  return result;
}

export async function createDerivedCredential(password: string): Promise<DerivedCredentialInput> {
  const salt = base64UrlEncode(crypto.getRandomValues(new Uint8Array(CREDENTIAL_KDF.saltLength)));
  return { salt, credential: await deriveCredential(password, salt) };
}
