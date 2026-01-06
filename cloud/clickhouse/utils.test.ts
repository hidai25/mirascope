import { describe, it, expect } from "vitest";
import { formatDateTime64 } from "@/clickhouse/utils";

describe("formatDateTime64", () => {
  it("formats a date to ClickHouse DateTime64(9) format", () => {
    const date = new Date("2024-01-15T10:30:45.123Z");
    const result = formatDateTime64(date);
    expect(result).toBe("2024-01-15 10:30:45.123000000");
  });

  it("replaces T separator with space", () => {
    const date = new Date("2024-06-01T00:00:00.000Z");
    const result = formatDateTime64(date);
    expect(result).toContain(" ");
    expect(result).not.toContain("T");
  });

  it("removes Z suffix and pads to nanoseconds", () => {
    const date = new Date("2024-12-31T23:59:59.999Z");
    const result = formatDateTime64(date);
    expect(result).not.toContain("Z");
    expect(result).toBe("2024-12-31 23:59:59.999000000");
  });

  it("handles midnight correctly", () => {
    const date = new Date("2024-01-01T00:00:00.000Z");
    const result = formatDateTime64(date);
    expect(result).toBe("2024-01-01 00:00:00.000000000");
  });

  it("handles dates with zero milliseconds", () => {
    const date = new Date("2024-07-04T12:00:00.000Z");
    const result = formatDateTime64(date);
    expect(result).toBe("2024-07-04 12:00:00.000000000");
  });
});
