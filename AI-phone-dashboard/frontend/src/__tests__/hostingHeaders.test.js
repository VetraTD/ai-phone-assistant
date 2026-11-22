import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

const { hosting } = JSON.parse(readFileSync(join(cwd(), "firebase.json"), "utf8"));

describe("dashboard hosting headers", () => {
  it("every page gets the security headers", () => {
    const all = hosting.headers.find((h) => h.source === "**").headers;
    const get = (k) => all.find((h) => h.key === k)?.value;
    const csp = get("Content-Security-Policy");
    for (const d of ["default-src 'self'", "script-src 'self';", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'"]) expect(csp).toContain(d);
    expect(csp).not.toMatch(/\*|unsafe-eval/);
    expect(get("X-Frame-Options")).toBe("DENY");
    expect(get("X-Content-Type-Options")).toBe("nosniff");
    expect(get("Strict-Transport-Security")).toMatch(/max-age=31536000/);
  });

  it("the API and sign-in origins are named literally, never a wildcard", () => {
    const all = hosting.headers.find((h) => h.source === "**").headers;
    const csp = all.find((h) => h.key === "Content-Security-Policy").value;
    const connect = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src"));
    const frame = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("frame-src"));
    for (const src of connect.split(/\s+/).slice(1)) expect(src).toMatch(/^('self'|https:\/\/[a-z0-9.-]+)$/);
    for (const src of frame.split(/\s+/).slice(1)) expect(src).toMatch(/^https:\/\/[a-z0-9.-]+$/);
  });
});
