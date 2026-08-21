import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// The cost controls that are enforced by something being ABSENT.
//
// C-6 and C-3 are both "do not create this resource", and an absence is the one
// kind of decision a comment cannot defend — the next person to need a Redis
// cache or a VPC route adds one, the plan grows by a line nobody reads closely,
// and a $70-160/month meter starts. These are the tripwires for that.
//
// They read the Terraform source as text, which is crude and is the point: it
// catches the resource block regardless of what variable or module wraps it,
// and it needs no GCP credentials, so it runs on every workstation and in CI.

const TF_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "infra",
  "terraform"
);

function terraformSource() {
  return fs
    .readdirSync(TF_DIR)
    .filter((f) => f.endsWith(".tf"))
    .map((f) => ({ file: f, src: fs.readFileSync(path.join(TF_DIR, f), "utf8") }));
}

/** Resource blocks of `type`, ignoring the comment prose that explains them. */
function resourceBlocks(type) {
  const hits = [];
  for (const { file, src } of terraformSource()) {
    const uncommented = src
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    const re = new RegExp(`resource\\s+"${type}"`, "g");
    let m;
    while ((m = re.exec(uncommented))) hits.push({ file, index: m.index });
  }
  return hits;
}

describe("C-6 — Direct VPC egress, never a connector", () => {
  it("creates no google_vpc_access_connector", () => {
    // A Serverless VPC Access connector is a managed group of real VM
    // instances, billed per instance-hour whether or not a packet crosses it —
    // roughly $30-40 each, so four is $120-160/month. Direct VPC egress reaches
    // the same private IPs from the Cloud Run service, with no fixed charge.
    //
    // An earlier revision of the module created four of these and would have
    // started the meter on the very first apply, for infrastructure nothing
    // used until B2.
    expect(resourceBlocks("google_vpc_access_connector")).toEqual([]);
  });

  it("keeps the subnets large enough for Direct VPC egress", () => {
    // Direct VPC egress allocates an address from the subnet PER CLOUD RUN
    // INSTANCE, so the subnet — not a connector's instance count — is what caps
    // concurrency. A tightened subnet would show up as capacity errors under
    // load, at C3, which is the worst place to discover it.
    const network = fs.readFileSync(path.join(TF_DIR, "network.tf"), "utf8");
    const cidr = network.match(/ip_cidr_range\s*=\s*"[^"]*\/(\d+)"/);
    expect(cidr).not.toBeNull();
    expect(Number(cidr[1])).toBeLessThanOrEqual(20);
  });
});

describe("C-3 — Postgres for call state, not Memorystore", () => {
  it("creates no google_redis_instance", () => {
    expect(resourceBlocks("google_redis_instance")).toEqual([]);
  });

  it("does not enable the Memorystore API on the regional stacks", () => {
    // The enforcement, and the reason it is worth a test: an API enabled "just
    // in case" is how the instance gets created by someone who assumed the
    // decision had gone the other way. Nothing can be provisioned through an
    // API that is off.
    const locals = fs.readFileSync(path.join(TF_DIR, "locals.tf"), "utf8");
    const apiList = locals.slice(locals.indexOf("regional_apis"), locals.indexOf("shared_apis"));
    expect(apiList).not.toMatch(/redis\.googleapis\.com/);
  });

  it("grants no Redis role to a runtime service account", () => {
    const iam = fs.readFileSync(path.join(TF_DIR, "iam.tf"), "utf8");
    const roleList = iam.slice(iam.indexOf("runtime_roles"));
    expect(roleList).not.toMatch(/roles\/redis\./);
  });
});

describe("Bucket Lock is not applied yet, and that is deliberate", () => {
  it("no log bucket sets `locked`", () => {
    // Bucket Lock is IRREVERSIBLE. Applied to a bucket receiving application
    // output, one regression in the PHI scrubber creates UNDELETABLE PHI —
    // unerasable under GDPR Art. 17 and a permanent disclosure under HIPAA.
    //
    // It belongs after the audit/application split has been running against
    // real traffic, done with the owner present. Terraform will happily apply
    // an irreversible retention policy from an unattended session, which is
    // exactly why this is a test and not a note.
    const logging = fs.readFileSync(path.join(TF_DIR, "logging.tf"), "utf8");
    const uncommented = logging
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(uncommented).not.toMatch(/^\s*locked\s*=/m);
  });
});

describe("the tripwires can actually see the source", () => {
  it("reads a meaningful number of .tf files", () => {
    // A path bug that silently scanned nothing would make every assertion above
    // pass forever.
    expect(terraformSource().length).toBeGreaterThan(8);
  });

  it("resourceBlocks finds a resource that IS there", () => {
    // And the matcher itself has to be able to match. Without this, a broken
    // regex reads as "no connectors found".
    expect(resourceBlocks("google_project").length).toBeGreaterThan(0);
  });
});
