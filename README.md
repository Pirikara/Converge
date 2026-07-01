# Converge

> Hands-off dependency updates that **resolve what Dependabot can't**, **block what you shouldn't install**, and **explain the impact** — across npm, pip, Go, and RubyGems.

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

| Ecosystem | Manifest | Outdated scan | Safety (OSV) | Resolution + PR |
|---|---|---|---|---|
| **npm** | `package.json` | ✅ | ✅ | ✅ npm · pnpm · Yarn Berry · bun |
| **pip** | `requirements.txt` | ✅ | ✅ | ✅ via `uv` |
| **Go** | `go.mod` | ✅ | ✅ | ✅ via `go get` |
| **RubyGems** | `Gemfile` | ✅ | ✅ | ✅ via `bundle lock` |

Yarn Classic (v1) is intentionally unsupported (deprecated). pip/RubyGems resolution
currently acts on exact pins (`==` / `gem "x", "1.2.3"`).

---

## Requirements

- **Node.js ≥ 20** (to run Converge itself)
- A **GitHub token** for `run` (PAT with `repo` scope, or a self-hosted GitHub App token)
- The toolchain for each ecosystem you resolve (only what you use):
  - npm → bundled with Node; **pnpm / Yarn Berry** → `corepack` (bundled with Node); **bun** → `bun`
  - pip → [`uv`](https://docs.astral.sh/uv/)
  - Go → `go`
  - RubyGems → `bundler` (Ruby)

Converge runs these in metadata/lockfile-only modes, so packages are never built or executed.

---

## Install

Not yet published to a registry — build from source:

```bash
git clone <your-fork-or-repo> converge && cd converge
pnpm install
pnpm build
node dist/cli.js --help
```

---

## Usage

### `scan` — list outdated dependencies (local, read-only)

```bash
node dist/cli.js scan ./path/to/repo
node dist/cli.js scan ./repo --json
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

Options: `--apply`, `--token <t>`, `--types major,minor,patch`, `--limit <n>`, `-v`.

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
      - uses: <owner>/Converge@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          apply: "true"          # "false" (default) = dry-run
          types: "minor,patch"   # add "major" for breaking bumps
          limit: "10"
```

Inputs: `repository` (default: the current repo), `token` (required), `apply`, `types`,
`limit`, `verbose`. The built-in `secrets.GITHUB_TOKEN` is enough for same-repo PRs;
use a PAT to target another repository.

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

```json5
{
  "ecosystems": {
    "npm":      { "enabled": true, "directories": ["frontend/"] },
    "pip":      { "enabled": true },
    "gomod":    { "enabled": true },
    "rubygems": { "enabled": true }
  },
  "safety": {
    "cooldownDays": 3,            // don't adopt a version younger than this
    "onKnownMalware": "block",    // block | warn | hold
    "onSuspicious": "hold",       // provenance downgrade etc.
    "allow": [{ "pkg": "some-pkg", "version": "1.2.3" }]  // false-positive overrides
  }
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

---

## Status & limitations

Converge is early. Known gaps:

- pip / RubyGems outdated detection acts on **exact pins** only (range floors need
  installed-version modelling from the lockfile).
- npm has **iterative co-bump**; other ecosystems resolve directly (peer conflicts in
  pnpm/yarn/bun are surfaced as warnings).
- No **lockfile-only maintenance** or **transitive-dependency security updates** yet.
- Impact usage-mapping is best-effort (distribution name ≠ import name in some pip/Ruby cases).
- Provenance signals are npm-only for now.

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
