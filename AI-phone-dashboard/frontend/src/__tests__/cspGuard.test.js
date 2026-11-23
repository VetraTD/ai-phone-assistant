import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { missingConnectOrigins, apiAddressProblem } from "../../cspGuard.js";

const firebaseJson = JSON.parse(readFileSync(join(cwd(), "firebase.json"), "utf8"));

// The CSP names the API origin literally. If VITE_API_URL moves (a custom API
// domain, a preview channel) without the CSP following, every request is
// blocked and the dashboard looks dead. The app build checks this and fails.
describe("CSP follows the API address", () => {
  it("the production API origin is allowed", () => {
    expect(missingConnectOrigins(firebaseJson, ["https://dashboard-api-uk-prod-qn43z3hljq-nw.a.run.app"])).toEqual([]);
  });
  it("a path on an allowed origin is allowed", () => {
    expect(missingConnectOrigins(firebaseJson, ["https://dashboard-api-uk-prod-qn43z3hljq-nw.a.run.app/api"])).toEqual([]);
  });
  it("a different API origin is reported", () => {
    expect(missingConnectOrigins(firebaseJson, ["https://api.vetratd.com"])).toEqual(["https://api.vetratd.com"]);
  });
  it("relative and unset addresses go to the page's own origin and need nothing", () => {
    expect(missingConnectOrigins(firebaseJson, ["", undefined, "/api"])).toEqual([]);
  });
  it("a local development API is not checked (local builds are never deployed)", () => {
    expect(missingConnectOrigins(firebaseJson, ["http://localhost:3001"])).toEqual([]);
  });
});

describe("a production app build needs a real API address", () => {
  it("refuses an unset or local API address unless it is a local build", () => {
    expect(apiAddressProblem(undefined)).toMatch(/VITE_API_URL/);
    expect(apiAddressProblem("http://localhost:3001")).toMatch(/local/);
    expect(apiAddressProblem("http://localhost:3001", { localBuild: true })).toBeNull();
    expect(apiAddressProblem("https://dashboard-api-uk-prod-qn43z3hljq-nw.a.run.app")).toBeNull();
  });
});
