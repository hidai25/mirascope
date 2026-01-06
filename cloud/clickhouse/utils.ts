/**
 * Format a Date for ClickHouse DateTime64(9).
 * ClickHouse expects: "2024-01-01 00:00:00.000000000" (space separator, 9 decimal places)
 * JavaScript toISOString() returns: "2024-01-01T00:00:00.000Z" (incompatible)
 */
export function formatDateTime64(date: Date): string {
  const iso = date.toISOString();
  // Replace 'T' with space, remove 'Z', and pad milliseconds to nanoseconds
  return iso.replace("T", " ").replace("Z", "") + "000000";
}
