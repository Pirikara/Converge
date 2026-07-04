# Converge

[![CI](https://github.com/Pirikara/Converge/actions/workflows/ci.yml/badge.svg)](https://github.com/Pirikara/Converge/actions/workflows/ci.yml)

> Hands-off dependency updates that **resolve what Dependabot can't**, **block what you shouldn't install**, and **explain the impact** — across 12 ecosystems.

Converge is a self-hosted, open-source CLI (in the spirit of Renovate) for keeping
dependencies up to date. Unlike tools that stop at "here's a version bump", Converge:

1. **Resolves** the update — including the *other* packages that need to move with it —
   and commits a verified lockfile, or explains exactly why it can't.
2. **Vets** the target version against known malware/vulnerabilities and supply-chain
   signals **before** anything is installed, and refuses dangerous ones.
3. **Maps the blast radius** — where the package is actually used in your code — and
   scores the triage risk.
4. **Flags deprecation / abandonment** and suggests replacements.

A core principle runs through all of it: **Converge never executes third-party package
code.** Every resolver uses a metadata-only / lockfile-only mode.

---

## The four pains it targets

| | Pain with existing tools | Converge |
|---|---|---|
| **P1** | Can't resolve the graph → no PR, silent failure | F1 resolution + automatic co-bump; always resolve **or** report the exact conflict |
| **P2** | A PR appears but the impact is unknown → triage stalls | F3 usage mapping (`file:line`) + Low/Med/High risk |
| **P3** | Unaware of deprecated / abandoned packages | F4 deprecation, staleness, replacement hints |
| **P4** | No idea if the target version is safe | F2 OSV malware/vuln block + cooldown + provenance-downgrade detection |

---

## Supported ecosystems

Twelve, in two tiers. **Lockfile-regenerating** managers rebuild the lockfile (no code
run) so co-bumps and transitive changes are captured. **Edit-only** managers rewrite the
declared version/constraint in the manifest (no toolchain required).

| Ecosystem | Manifest(s) | Safety (OSV) | Resolution |
|---|---|---|---|
| **npm** | `package.json` | ✅ | lockfile — npm · pnpm · Yarn Berry · bun (iterative co-bump) |
| **pip** | `requirements.txt`, `pyproject.toml` | ✅ | lockfile — via `uv` |
| **Go** | `go.mod` | ✅ | lockfile — via `go get` |
| **RubyGems** | `Gemfile` | ✅ | lockfile — via `bundle lock` |
| **Cargo** | `Cargo.toml` | ✅ | lockfile — via `cargo update` |
| **NuGet** | `*.csproj`, `Directory.Packages.props` | ✅ | edit-only |
| **Composer** | `composer.json` (+ `composer.lock`) | ✅ | lockfile — via `composer update` (code-free) |
| **Maven / Gradle** | `pom.xml`, `build.gradle(.kts)`, `libs.versions.toml` | ✅ | edit-only |
| **GitHub Actions** | `.github/workflows/*.yml`, `action.yml` | ✅ | edit-only (incl. SHA-pinned refs) |
| **Docker** | `Dockerfile`, `docker-compose.yml` | — | edit-only (base-image tags) |
| **Terraform** | `*.tf` | — | edit-only (providers + registry modules) |
| **Helm** | `Chart.yaml` | — | edit-only (chart dependencies) |

OSV covers every ecosystem OSV.dev indexes; Docker/Terraform/Helm aren't OSV-indexed, so
they're scan-and-bump only. Yarn Classic (v1) is intentionally unsupported (deprecated).
**Grouping** bundles related updates into one PR (see `groups` in config).

---

## Requirements

- **Node.js ≥ 20** (to run Converge itself)
- A **GitHub token** for `run` (PAT with `repo` scope, or `secrets.GITHUB_TOKEN` in Actions)
- A toolchain **only for the lockfile-regenerating ecosystems you use**:
  - npm → bundled with Node; **pnpm / Yarn Berry** → `corepack` (bundled with Node); **bun** → `bun`
  - pip → [`uv`](https://docs.astral.sh/uv/) · Go → `go` · RubyGems → `bundler` · Cargo → `cargo` · Composer → `composer`
  - The edit-only ecosystems (NuGet, Maven/Gradle, Actions, Docker, Terraform, Helm)
    need **no toolchain** — Converge rewrites the manifest directly. (Composer falls
    back to manifest-only if `composer` isn't installed.)

Converge runs these in metadata/lockfile-only modes, so packages are never built or executed.

---

## Install

Not yet published to a registry — build from source:

```bash
git clone https://github.com/Pirikara/Converge && cd Converge
pnpm install       # or: npm install
pnpm build         # or: npm run build
node dist/cli.js --help
```

To run it on a schedule with zero infrastructure, use the
[GitHub Action](#run-as-a-github-action-no-server-no-hosted-app) instead.

---

## Usage

### `scan` — list outdated dependencies (local, read-only)

```bash
node dist/cli.js scan ./path/to/repo
node dist/cli.js scan ./repo --json
```

### `audit` — scan the whole lockfile tree for malware & vulns (local, read-only)

Walks the **transitive** dependency tree from your lockfiles (npm/pnpm/yarn, Cargo,
Go, Gemfile, poetry/uv, composer) and checks every package against OSV — catching
malware and vulnerabilities that direct-only scanners miss.

```bash
node dist/cli.js audit ./repo
# MALWARE  event-stream@3.3.6  [npm] [transitive]
# vuln     express@4.17.1      [npm] [direct]
# warn 2 affected package(s): 1 malware, 1 transitive (1 would be missed by direct-only scanners)
```

### `run` — propose safe, resolved update PRs for a GitHub repo

Dry-run by default; `--apply` opens PRs.

```bash
export CONVERGE_TOKEN=ghp_xxx           # or GITHUB_TOKEN

# preview (no changes): scan → safety → resolve → impact for each candidate
node dist/cli.js run owner/repo

# open PRs for minor+patch updates
node dist/cli.js run owner/repo --apply --types minor,patch --limit 10
```

Each PR body contains the F1/F2/F3/F4 report (resolution + co-bumps, safety verdict,
usage map + risk, deprecation), and the commit includes the manifest **and** the
regenerated lockfile.

Options: `--apply`, `--token <t>`, `--types major,minor,patch`, `--limit <n>`,
`--strategy latest|in-range`, `-v`.

### Run as a GitHub Action (no server, no hosted app)

The closest thing to a "one-click" setup: Converge ships an action, so you can run it
on GitHub's own CI runners on a schedule — nothing to host. Add a workflow to **your**
repo (a full copy is in [`examples/converge.yml`](examples/converge.yml)):

```yaml
# .github/workflows/converge.yml
name: Converge
on:
  schedule:
    - cron: "0 6 * * 1" # Mondays 06:00 UTC
  workflow_dispatch: {}
permissions:
  contents: write
  pull-requests: write
jobs:
  converge:
    runs-on: ubuntu-latest
    steps:
      - uses: Pirikara/Converge@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          apply: "true"          # "false" (default) = dry-run
          types: "minor,patch"   # add "major" for breaking bumps
          limit: "10"
```

Inputs: `repository` (default: the current repo), `token` (required), `apply`, `types`,
`limit`, `strategy` (`latest`|`in-range`), `security-only`, `verbose`. The built-in
`secrets.GITHUB_TOKEN` is enough for same-repo PRs; use a PAT to target another repository.

**One workflow, run frequently.** Converge has no event-driven trigger, so freshness
follows your cron. Run it **daily (or hourly)** and control cadence in `converge.json`:
security fixes are proposed on **every run**, while routine updates only open PRs inside
the `schedule` window (below). No need to split into multiple workflows. (`--security-only`
/ the `security-only` input still exists for an ad-hoc "just fix vulnerabilities now" run.)

### `resolve` — resolve a single bump locally (no PR)

Auto-detects the ecosystem (`package.json` / `requirements.txt` / `Gemfile`) and, for
npm, the package manager (npm/pnpm/yarn/bun).

```bash
node dist/cli.js resolve ./repo react 19.0.0 --write
node dist/cli.js resolve ./backend langchain 1.3.11
```

---

## Configuration — `converge.json`

Optional, at the repo root. JSON with comments (JSON5) is allowed. All fields are
optional with sensible defaults.

All 12 ecosystems are enabled by default; list one only to change it.

```json5
{
  // "latest" (default): bump to the registry's latest, replacing the range if
  // needed (may cross a major). "in-range": only move up within the declared
  // range — never crossing its major — so "^3.23.8" advances to "^3.25.76" but
  // never "^4.x". (npm ecosystem; override per run with `--strategy`.)
  "updateStrategy": "in-range",
  // Keep open PRs current when the base branch moves. "conflicting" (default):
  // rebase only PRs that actually conflict; "behind": rebase any PR behind base;
  // "never": don't auto-rebase. PRs a human has pushed to are never rebased.
  "rebase": "conflicting",
  // Window (UTC) when *routine* updates may open PRs — run the workflow often and
  // let this gate routine cadence. Security fixes ignore it (always proposed).
  // Empty (default) = any time. Example: only Monday mornings.
  "schedule": { "days": ["mon"], "hours": [6, 10] },
  // Lockfile refresh (opt-in): regenerate lockfiles within the existing
  // manifest ranges — no manifest change, no overrides — pulling transitive deps
  // up to their latest allowed version. Catches in-range transitive security
  // fixes (the PR flags which advisories it clears). npm/pnpm, Composer, Go,
  // Cargo, RubyGems, pip (uv.lock).
  "lockRefresh": { "enabled": true },
  "ecosystems": {
    "npm":    { "enabled": true, "directories": ["frontend/"] },
    "docker": { "enabled": false }   // opt an ecosystem out
    // pip, gomod, rubygems, cargo, nuget, composer, maven,
    // "github-actions", terraform, helm are on by default
  },
  "safety": {
    "cooldownDays": 3,            // don't adopt a version younger than this
    "onKnownMalware": "block",    // block | warn | hold
    "onSuspicious": "hold",       // provenance downgrade etc.
    "allow": [{ "pkg": "some-pkg", "version": "1.2.3" }]  // false-positive overrides
  },
  "groups": [
    // bundle related updates into a single PR (same ecosystem + directory)
    { "name": "eslint", "match": ["eslint*", "@typescript-eslint/*"] }
  ]
}
```

---

## Safety model (F2)

Evaluated **before** resolution, so dangerous versions are never installed:

- **Known malware / vulnerabilities** via [OSV.dev](https://osv.dev) — malware is detected
  from `MAL-*` advisories, GitHub-reviewed malware advisories, and malware CWEs. Known
  malware is blocked; high/critical vulnerabilities block, lower ones warn.
- **Cooldown** — freshly published versions are held for `cooldownDays` (anti-supply-chain).
- **Provenance downgrade** — if a package had npm provenance and the target version drops
  it, that's treated as suspicious (possible hijacked publish).
- **Allowlist** — explicit `pkg@version` entries override the gate.

### Security remediation (fix, not just block)

Beyond blocking bad *targets*, Converge opens PRs to **fix a vulnerable version you
already have**: for each direct dependency whose *installed* version (read from the
lockfile, not just the manifest range) is affected by an OSV advisory, it bumps to the
fixed version — bypassing the update-type filter, the cooldown, and the `schedule`
window. Covers **every OSV-indexed ecosystem** — npm, pip, Go, Cargo, RubyGems, NuGet,
Composer, Maven/Gradle (`security.strategy`: `lowest` (default) | `highest`). Direct
dependencies (plus Go's `// indirect`). For **transitive** vulns, `audit` surfaces the
whole tree, and **lockfile refresh** (below) pulls them up to the latest in-range
version — no manifest overrides. A vuln that needs a parent bump to fix is reported, not
forced (the same limit Renovate/Dependabot hit).

---

## Status & limitations

Converge is early. Known gaps:

- pip / RubyGems outdated detection acts on **exact pins** only (range floors need
  installed-version modelling from the lockfile).
- npm has **iterative co-bump**; other lockfile ecosystems resolve directly (peer
  conflicts in pnpm/yarn/bun are surfaced as warnings). The remaining edit-only
  ecosystems (NuGet, Maven/Gradle) don't regenerate their lockfile — the PR notes
  when you should.
- Maven `${property}` / parent / BOM-managed versions and Gradle catalog multi-line
  entries aren't bumped yet; Terraform/Helm resolve http(s) registries (not OCI).
- Impact usage-mapping is best-effort (distribution name ≠ import name in some pip/Ruby cases).
- Provenance signals are npm-only for now.
- Distribution is build-from-source or the GitHub Action; not yet on npm.

---

## Development

```bash
pnpm typecheck
pnpm test        # vitest
pnpm build
```

## Data & attribution

Converge queries the [OSV.dev](https://osv.dev) API at runtime for vulnerability and
malware advisories — it bundles no OSV data. Advisory records remain © their sources
under their own licenses: CC-BY-4.0 (GitHub/GHSA, PyPA, Go), CC0-1.0 (RustSec),
Apache-2.0 (OpenSSF Malicious Packages), and others aggregated by OSV. Each advisory
Converge surfaces links back to `osv.dev/vulnerability/<id>`. See the
[OSV data sources](https://google.github.io/osv.dev/data/) and [`NOTICE`](NOTICE).

Converge is an independent, clean-room implementation in the spirit of Renovate; it
contains no Renovate (or other tool) code.

## License

MIT — see [`LICENSE`](LICENSE).
