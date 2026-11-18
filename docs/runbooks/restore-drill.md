# Restore drill — putting a Cloud SQL clone back into service

Closes ledger **P26**. Phase 5 Gate 9a proved the data comes back; this is the
half that was never written down — getting something to **serve** it again.

**Measured, Gate 9a:** a PITR clone takes **591s**, carries all migrations and
the tenant row, and matches the source on tier, region, CMEK key, private-IP-only
and backup configuration. It lands with a **different name, a different private
IP, a different zone** (`europe-west2-a` → `-c`), a **fresh server CA**, and it
is **not in `tfstate`**.

---

## Before you start

| | |
|---|---|
| **Point Twilio away first** | `+441372656055` currently serves from GCP. A repoint restarts both Cloud Run services; a call landing mid-drill fails. Move it to Railway, or drill when nobody will dial. |
| **Do not drill before Gate 4** | The live call is the first real test of the receptionist. Do not spend it on a half-repointed estate. |
| **Record the current instance** | `export VETRA_SQL_INSTANCE_ORIGINAL=vetra-uk-edc8ca:europe-west2:vetra-uk` — nothing on the estate remembers it after step 3, and `--rollback` deliberately refuses to guess. |
| **Auth** | Every command needs `CLOUDSDK_CONFIG=~/.gcloud-vetra2`. The default config is a personal account. |

---

## The drill

### 1. Where are we now (read-only)

```bash
CLOUDSDK_CONFIG=~/.gcloud-vetra2 node scripts/restore-drill.js --status
```

Expect all three workloads on the same instance. If they disagree, a previous
drill stopped half way — finish or roll it back before doing anything else.

### 2. Clone (manual, on purpose)

Left out of the script because a typo here costs an hour:

```bash
CLOUDSDK_CONFIG=~/.gcloud-vetra2 gcloud sql instances clone vetra-uk vetra-uk-restore-$(date +%Y%m%d) \
  --point-in-time "2026-08-31T12:00:00Z" \
  --project vetra-uk-edc8ca
```

~591s. The clone's **connection name** is what step 3 wants:
`vetra-uk-edc8ca:europe-west2:<clone-name>`.

### 3. Repoint

```bash
# dry run — prints the exact gcloud commands, changes nothing
CLOUDSDK_CONFIG=~/.gcloud-vetra2 node scripts/restore-drill.js \
  --repoint vetra-uk-edc8ca:europe-west2:vetra-uk-restore-20260831

# then, deliberately
CLOUDSDK_CONFIG=~/.gcloud-vetra2 node scripts/restore-drill.js \
  --repoint vetra-uk-edc8ca:europe-west2:vetra-uk-restore-20260831 --confirm
```

Three workloads, not two — **the migrate job counts**. Leaving it behind means
the next deploy migrates the database nobody is serving.

If a step fails the script **stops rather than continuing**, because a partial
repoint splits the estate across two databases: worse than either end state.
It tells you where it stopped.

### 4. Verify

```bash
CLOUDSDK_CONFIG=~/.gcloud-vetra2 node scripts/restore-drill.js --status   # all three agree
curl -s -o /dev/null -w '%{http_code}\n' https://<voice-url>/             # 200
```

Then a real call, if Twilio is pointed at GCP.

### 5. Roll back

```bash
export VETRA_SQL_INSTANCE_ORIGINAL=vetra-uk-edc8ca:europe-west2:vetra-uk
CLOUDSDK_CONFIG=~/.gcloud-vetra2 node scripts/restore-drill.js --rollback --confirm
```

Then delete the clone, or it bills as a second `db-g1-small` indefinitely:

```bash
CLOUDSDK_CONFIG=~/.gcloud-vetra2 gcloud sql instances delete vetra-uk-restore-20260831 --project vetra-uk-edc8ca
```

---

## Afterwards — Terraform state is now stale

The script drives `gcloud`, not Terraform, and that is deliberate: recovery must
be fast and must not depend on the state file being healthy. Losing the database
and needing a clean plan in the same hour is not a recovery story.

The cost is that the estate no longer matches state. **Do not run
`terraform apply` until this is reconciled** — it would quietly revert the
repoint and point production back at the instance you were recovering from.

- **Rolled back (drill):** nothing to do. The estate matches state again.
- **Kept the clone (real recovery):** the clone is not a Terraform resource.
  Either rename it to the original instance name once the original is deleted —
  so `sql.tf` matches reality again — or add it to `sql.tf` and
  `terraform import` it. The rename is usually right after a real incident; the
  import is right if the clone becomes permanent.

Check with a read-only plan before any apply:

```bash
cd infra/terraform
CLOUDSDK_CONFIG=~/.gcloud-vetra2 TF_DISABLE_PLUGIN_TLS=1 \
  terraform plan -lock=false -input=false
```

---

## Two environment traps, both measured 2026-08-31

**`TF_DISABLE_PLUGIN_TLS=1` is required on this workstation.** Without it every
provider fails with `x509: certificate signed by unknown authority` — on the
**loopback gRPC channel between Terraform and its own plugins**, not on any
Google API call. Norton intercepts localhost TLS. `SSL_CERT_FILE` does not help
(Go reads the Windows system roots). The error names schema loading and looks
like a config fault, which is what makes it cost an hour.

**`gcloud` is a `.cmd` shim on Windows.** Node's `execFileSync` gives `ENOENT`
without the extension and `EINVAL` with it; `shell: true` is required, which is
why `restore-drill.js` validates the instance name before it reaches a shell.

---

## What the drill still will not tell you

- **The fresh server CA.** The clone gets a new one. Nothing here connects with
  a pinned CA today, so it does not bite — but if certificate pinning is ever
  added, this is where it breaks.
- **The private IP changes.** Only matters if something is ever addressed by IP
  instead of connection name.
- **`vetra-us` is untested.** Everything here is UK-only.
