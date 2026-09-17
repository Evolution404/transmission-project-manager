export function encodeJsonCursor(value: unknown): string {
  const json = JSON.stringify(value);
  let encoded: string;
  try {
    encoded = btoa(json);
  } catch {
    encoded = btoa(encodeURIComponent(json));
  }
  return encoded
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function decodeJsonCursor(value: string | undefined): unknown | null {
  if (!value) return null;
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
    const decoded = atob(padded);
    try {
      return JSON.parse(decoded) as unknown;
    } catch {
      return JSON.parse(decodeURIComponent(decoded)) as unknown;
    }
  } catch {
    return null;
  }
}
