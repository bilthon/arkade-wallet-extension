/** Validate local port overrides consistently in the extension and test webapp. */
export function localhostUrl(name: string, value: string): string {
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer port between 1 and 65535.`);
  }
  return `http://localhost:${port}`;
}
