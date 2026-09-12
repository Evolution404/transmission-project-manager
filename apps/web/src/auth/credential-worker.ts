/// <reference lib="webworker" />

import initialize from '@phi-ag/argon2/fetch';
import wasmUrl from '@phi-ag/argon2/argon2.wasm?url';
import { Argon2Type, Argon2Version } from '@phi-ag/argon2';
import { CREDENTIAL_KDF } from '@tpm/shared';

interface DeriveMessage {
  id: string;
  password: string;
  salt: string;
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const argon2Promise = initialize(wasmUrl);

self.onmessage = async (event: MessageEvent<DeriveMessage>) => {
  const { id, password, salt } = event.data;
  try {
    const argon2 = await argon2Promise;
    const result = argon2.hash(password, {
      salt: base64UrlDecode(salt),
      hashLength: CREDENTIAL_KDF.hashLength,
      timeCost: CREDENTIAL_KDF.timeCost,
      memoryCost: CREDENTIAL_KDF.memoryCostKiB,
      parallelism: CREDENTIAL_KDF.parallelism,
      type: Argon2Type.Argon2id,
      version: Argon2Version.Version13,
    });
    self.postMessage({ id, ok: true, credential: base64UrlEncode(result.hash) });
  } catch (error) {
    const message = error instanceof Error ? error.message : '本地密码计算失败';
    self.postMessage({ id, ok: false, error: message });
  }
};
