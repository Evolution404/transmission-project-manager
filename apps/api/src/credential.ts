import { CREDENTIAL_KDF, type CredentialKdfDescriptor, type DerivedCredentialInput } from '@tpm/shared';

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const username = value.trim().toLowerCase();
  return /^[a-z0-9._-]{3,64}$/.test(username) ? username : null;
}

export function credentialDescriptor(salt: string): CredentialKdfDescriptor {
  return {
    algorithm: CREDENTIAL_KDF.algorithm,
    salt,
    memoryCostKiB: CREDENTIAL_KDF.memoryCostKiB,
    timeCost: CREDENTIAL_KDF.timeCost,
    parallelism: CREDENTIAL_KDF.parallelism,
    hashLength: CREDENTIAL_KDF.hashLength,
    version: CREDENTIAL_KDF.version,
  };
}

export function validateCredentialValue(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return base64UrlDecode(value)?.byteLength === CREDENTIAL_KDF.hashLength;
}

export function validateDerivedCredential(input: DerivedCredentialInput): boolean {
  const salt = base64UrlDecode(input.salt);
  return salt?.byteLength === CREDENTIAL_KDF.saltLength && validateCredentialValue(input.credential);
}

async function hmac(key: string, bytes: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, bytes));
}

export async function credentialVerifier(credential: string, pepper: string): Promise<string> {
  const bytes = base64UrlDecode(credential);
  if (!bytes || bytes.byteLength !== CREDENTIAL_KDF.hashLength) throw new Error('INVALID_DERIVED_CREDENTIAL');
  return base64UrlEncode(await hmac(`verifier:${pepper}`, bytes));
}

export async function fakeSaltForUsername(username: string, pepper: string): Promise<string> {
  const digest = await hmac(`fake-salt:${pepper}`, encoder.encode(username));
  return base64UrlEncode(digest.slice(0, CREDENTIAL_KDF.saltLength));
}

export async function fakeVerifierForUsername(username: string, pepper: string): Promise<string> {
  const digest = await hmac(`fake-verifier:${pepper}`, encoder.encode(username));
  return base64UrlEncode(digest);
}

export function constantTimeEqualText(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function verifyDerivedCredential(credential: string, expectedVerifier: string, pepper: string): Promise<boolean> {
  try {
    const actual = await credentialVerifier(credential, pepper);
    return constantTimeEqualText(actual, expectedVerifier);
  } catch {
    return false;
  }
}

export const credentialParamsJson = JSON.stringify({
  algorithm: CREDENTIAL_KDF.algorithm,
  memoryCostKiB: CREDENTIAL_KDF.memoryCostKiB,
  timeCost: CREDENTIAL_KDF.timeCost,
  parallelism: CREDENTIAL_KDF.parallelism,
  hashLength: CREDENTIAL_KDF.hashLength,
  version: CREDENTIAL_KDF.version,
});
