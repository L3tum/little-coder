/** `${mtimeMs}:${size}` via lstatSync; null on any error (ENOENT = "no file"). */
export function fileFreshnessKey(path: string): string | null;
