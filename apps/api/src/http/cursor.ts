export function encodeJsonCursor(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function decodeJsonCursor(value: string | undefined): unknown | null {
  if (!value) return null;
  try {
    return JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/'))) as unknown;
  } catch {
    return null;
  }
}
