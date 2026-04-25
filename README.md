# RiskRaft Dependency Sync

A GitHub Action that automatically syncs your project's dependencies to [RiskRaft](https://riskraft.io) for continuous vulnerability monitoring. Every push keeps your RiskRaft subscriptions in sync with what you actually deploy.

## How It Works

1. On push (or on a schedule), the action reads your manifest files
2. Sends the raw file contents to the RiskRaft API
3. RiskRaft parses them server-side and updates your package subscriptions
4. You get vulnerability alerts for exactly what's in your repo

## Supported Manifest Files

| File | Ecosystem |
|------|-----------|
| `requirements.txt` | PyPI |
| `Pipfile.lock` | PyPI |
| `package.json` | npm |
| `package-lock.json` | npm |
| `go.mod` | Go |
| `Cargo.toml` / `Cargo.lock` | Rust |
| `pom.xml` | Maven |
| `build.gradle` | Gradle |
| `Gemfile.lock` | RubyGems |
| `composer.lock` | Composer |
| CycloneDX SBOM | Multi |
| SPDX SBOM | Multi |

## Quick Start

The action generates a CycloneDX SBOM with [Syft](https://github.com/anchore/syft) automatically — no extra steps needed. You get exact resolved versions for every dependency (including transitives) instead of the wildcard/range pollution that comes from raw manifest parsing.

```yaml
name: RiskRaft Sync
on:
  push:
    branches: [main]

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: riskraft/dependency-sync@v1
        with:
          api-key: ${{ secrets.RISKRAFT_API_KEY }}
```

That's it. On first run the action downloads Syft (~30 MB, cached after) and scans `$GITHUB_WORKSPACE`.

## Bring your own SBOM

If you already produce a CycloneDX or SPDX SBOM upstream (e.g. via `anchore/sbom-action`, `cdxgen`, or a custom step), pass its path:

```yaml
- uses: anchore/sbom-action@v0
  with:
    format: cyclonedx-json
    output-file: sbom.cdx.json
- uses: riskraft/dependency-sync@v1
  with:
    api-key: ${{ secrets.RISKRAFT_API_KEY }}
    sbom-file: sbom.cdx.json
```

## Legacy manifest mode

Skip Syft entirely and parse manifest files directly. Not recommended — version ranges (`^1.0.0`), wildcards (`*`), and workspace links can produce false-positive vulnerabilities.

```yaml
- uses: riskraft/dependency-sync@v1
  with:
    api-key: ${{ secrets.RISKRAFT_API_KEY }}
    legacy-manifest: 'true'
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api-key` | Yes | | RiskRaft API key with write scope |
| `api-url` | No | `https://app.riskraft.io` | RiskRaft API base URL |
| `project-id` | No | | Assign packages to a specific RiskRaft project |
| `project-name` | No | | Alternative to `project-id` (resolved server-side) |
| `mode` | No | `replace` | `add` = append new packages, `replace` = mirror exactly |
| `sbom-file` | No | | Path to a pre-generated CycloneDX/SPDX SBOM. Skips auto-generation. |
| `legacy-manifest` | No | `false` | Set to `true` to skip Syft and parse manifests directly. Not recommended. |
| `manifest-files` | No | Auto-detect | (Legacy mode) comma-separated manifest paths. |

## Outputs

| Output | Description |
|--------|-------------|
| `packages-added` | Number of new packages subscribed |
| `packages-updated` | Number of packages with version updates |
| `packages-removed` | Number of packages removed (replace mode) |
| `summary` | Human-readable summary |

## Modes

### Replace (default)

Mirrors your manifest exactly. Packages removed from your codebase are unsubscribed from RiskRaft. This is the recommended mode for most projects.

### Add

Only adds new packages, never removes. Useful if you manage some subscriptions manually in RiskRaft and don't want the action to remove them.

## Examples

### Monorepo with multiple manifests

```yaml
- uses: riskraft/dependency-sync@v1
  with:
    api-key: ${{ secrets.RISKRAFT_API_KEY }}
    manifest-files: 'backend/requirements.txt,frontend/package.json,services/go.mod'
    project-id: 'my-project-id'
```

### Scheduled sync (daily)

```yaml
on:
  schedule:
    - cron: '0 8 * * 1-5'  # Weekdays at 8am UTC
  push:
    branches: [main]
```

### Use output in subsequent steps

```yaml
- uses: riskraft/dependency-sync@v1
  id: riskraft
  with:
    api-key: ${{ secrets.RISKRAFT_API_KEY }}

- run: echo "RiskRaft sync: ${{ steps.riskraft.outputs.summary }}"
```

## Setup

1. In RiskRaft, go to **Settings > API Keys** and create a key with **write** scope
2. In your GitHub repo, go to **Settings > Secrets** and add `RISKRAFT_API_KEY`
3. Add the workflow file to `.github/workflows/riskraft-sync.yml`

## API Key Scopes

The action requires an API key with `write` scope. API keys are available on PRO, TEAMS, and BUSINESS plans.
