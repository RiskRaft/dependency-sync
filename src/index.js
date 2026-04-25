const core = require('@actions/core');
const tc = require('@actions/tool-cache');
const exec = require('@actions/exec');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

// Pinned Syft version. Bump deliberately when validating a new release.
const SYFT_VERSION = '1.18.1';

async function ensureSyft() {
  // Check the per-runner tool cache first.
  let dir = tc.find('syft', SYFT_VERSION);
  if (dir) {
    return path.join(dir, process.platform === 'win32' ? 'syft.exe' : 'syft');
  }

  // Map node platform/arch → Syft release artifact.
  const platformMap = { linux: 'linux', darwin: 'darwin', win32: 'windows' };
  const archMap     = { x64: 'amd64', arm64: 'arm64' };
  const plat = platformMap[process.platform];
  const arch = archMap[process.arch];
  if (!plat || !arch) {
    throw new Error(`Unsupported platform/arch for Syft: ${process.platform}/${process.arch}`);
  }
  const ext = plat === 'windows' ? 'zip' : 'tar.gz';
  const url = `https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}/syft_${SYFT_VERSION}_${plat}_${arch}.${ext}`;

  core.info(`Downloading Syft ${SYFT_VERSION} (${plat}/${arch})…`);
  const archive = await tc.downloadTool(url);
  const extracted = ext === 'zip' ? await tc.extractZip(archive) : await tc.extractTar(archive);
  dir = await tc.cacheDir(extracted, 'syft', SYFT_VERSION);
  return path.join(dir, plat === 'windows' ? 'syft.exe' : 'syft');
}

async function generateSbom(scanRoot) {
  const syft = await ensureSyft();
  const out = path.join(os.tmpdir(), `riskraft-sbom-${Date.now()}.cdx.json`);
  // dir:<path> tells Syft to scan a filesystem, not an OCI image.
  // Exclusions:
  //   .github/   — Syft's github-actions cataloger treats `uses:` refs as npm pkgs
  //   node_modules/ — already covered by lockfiles; avoids double-counting and
  //                   bundling the action runner's own node_modules
  //   vendor/, target/, build/, dist/ — vendored or build outputs that pollute
  await exec.exec(syft, [
    `dir:${scanRoot}`,
    '--exclude', './.github/**',
    '--exclude', '**/node_modules/**',
    '--exclude', '**/vendor/**',
    '--exclude', '**/target/**',
    '--exclude', '**/build/**',
    '--exclude', '**/dist/**',
    // Exclude any dir that looks like a GitHub Action source — its
    // package.json lists @actions/* runtime deps that aren't part of
    // the host project. Most repos won't have these dirs; harmless if
    // absent.
    '--exclude', '**/github-action/**',
    '--exclude', '**/.github-action/**',
    '-o', `cyclonedx-json=${out}`,
    '-q',
  ]);
  return out;
}

// Manifest files to auto-detect (in priority order)
const KNOWN_MANIFESTS = [
  'requirements.txt',
  'Pipfile.lock',
  'package.json',
  'package-lock.json',
  'go.mod',
  'Cargo.toml',
  'Cargo.lock',
  'pom.xml',
  'build.gradle',
  'Gemfile.lock',
  'composer.lock',
];

function findManifests(rootDir) {
  const found = [];
  for (const name of KNOWN_MANIFESTS) {
    const filePath = path.join(rootDir, name);
    if (fs.existsSync(filePath)) {
      found.push(filePath);
    }
  }
  return found;
}

function makeRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:') {
      reject(new Error(`Refusing to send request over cleartext ${parsedUrl.protocol} (use an https:// API URL)`));
      return;
    }

    const req = https.request(parsedUrl, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function run() {
  try {
    const apiKey = core.getInput('api-key', { required: true });
    const apiUrl = core.getInput('api-url') || 'https://app.riskraft.io';
    const projectId = core.getInput('project-id') || null;
    const projectName = core.getInput('project-name') || null;
    const mode = core.getInput('mode') || 'replace';
    const manifestInput = core.getInput('manifest-files') || '';
    const sbomFile = core.getInput('sbom-file') || '';
    const legacyManifest = (core.getInput('legacy-manifest') || '').toLowerCase() === 'true';
    const workspace = process.env.GITHUB_WORKSPACE || '.';

    // Resolution order:
    //   1. sbom-file: caller passed an SBOM, send it as-is.
    //   2. manifest-files OR legacy-manifest=true: read raw manifests (back-compat).
    //   3. default: generate a CycloneDX SBOM via Syft against $GITHUB_WORKSPACE.
    let files;
    if (sbomFile) {
      if (!fs.existsSync(sbomFile)) {
        core.setFailed(`SBOM file not found: ${sbomFile}`);
        return;
      }
      files = [{
        filename: path.basename(sbomFile),
        content: fs.readFileSync(sbomFile, 'utf-8'),
      }];
      core.info(`Syncing SBOM: ${sbomFile}`);
    } else if (manifestInput || legacyManifest) {
      let manifestPaths;
      if (manifestInput) {
        manifestPaths = manifestInput.split(',').map(f => f.trim()).filter(Boolean);
        for (const p of manifestPaths) {
          if (!fs.existsSync(p)) {
            core.warning(`Manifest file not found: ${p}`);
          }
        }
        manifestPaths = manifestPaths.filter(p => fs.existsSync(p));
      } else {
        manifestPaths = findManifests(workspace);
        core.info(`Auto-detected ${manifestPaths.length} manifest file(s)`);
      }

      if (manifestPaths.length === 0) {
        core.warning('No manifest files found. Nothing to sync.');
        core.setOutput('summary', 'No manifest files found');
        return;
      }

      files = manifestPaths.map(filePath => ({
        filename: path.basename(filePath),
        content: fs.readFileSync(filePath, 'utf-8'),
      }));

      core.info(`Syncing ${files.length} manifest(s): ${files.map(f => f.filename).join(', ')}`);
    } else {
      // Default path — generate a clean SBOM with Syft against the workspace.
      try {
        const sbomPath = await generateSbom(workspace);
        const stat = fs.statSync(sbomPath);
        files = [{
          filename: 'sbom.cdx.json',
          content: fs.readFileSync(sbomPath, 'utf-8'),
        }];
        core.info(`Generated SBOM (${(stat.size / 1024).toFixed(1)} KB) and syncing`);
      } catch (e) {
        core.warning(`SBOM generation failed (${e.message}); falling back to manifest auto-detect`);
        const manifestPaths = findManifests(workspace);
        if (manifestPaths.length === 0) {
          core.setFailed('SBOM generation failed and no manifest files were found in workspace.');
          return;
        }
        files = manifestPaths.map(filePath => ({
          filename: path.basename(filePath),
          content: fs.readFileSync(filePath, 'utf-8'),
        }));
        core.info(`Fell back to ${files.length} manifest(s): ${files.map(f => f.filename).join(', ')}`);
      }
    }

    // Build request
    const payload = { files, mode };
    if (projectId) {
      payload.project_id = projectId;
    } else if (projectName) {
      payload.project_name = projectName;
    }

    const body = JSON.stringify(payload);
    const endpoint = `${apiUrl.replace(/\/$/, '')}/v1/api/subscriptions/import/manifest`;

    core.info(`Endpoint: ${endpoint}`);
    const response = await makeRequest(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        'User-Agent': 'RiskRaft-Dependency-Sync/1.0',
        'Accept': 'application/json',
      },
    }, body);
    core.info(`Response status: ${response.status}`);
    if (response.status >= 400) {
      core.info(`Response body: ${JSON.stringify(response.data).substring(0, 500)}`);
    }

    if (response.status === 401) {
      const detail = response.data?.detail || 'Unauthorized';
      core.setFailed(`Authentication failed (401): ${detail}`);
      return;
    }

    if (response.status === 403) {
      const detail = response.data?.detail || 'Forbidden';
      core.setFailed(`Access denied (403): ${detail}`);
      return;
    }

    if (response.status >= 400) {
      core.setFailed(`API error (${response.status}): ${JSON.stringify(response.data)}`);
      return;
    }

    const result = response.data;

    // Set outputs
    const added = result.packages_added || 0;
    const updated = result.packages_updated || 0;
    const removed = result.packages_removed || 0;
    const skipped = result.packages_skipped || 0;

    core.setOutput('packages-added', added);
    core.setOutput('packages-updated', updated);
    core.setOutput('packages-removed', removed);

    // Log file results
    if (result.files) {
      for (const f of result.files) {
        core.info(`  ${f.filename}: ${f.packages_found} packages (${f.status})`);
      }
    }

    // Build summary
    const parts = [];
    if (added > 0) parts.push(`${added} added`);
    if (updated > 0) parts.push(`${updated} updated`);
    if (removed > 0) parts.push(`${removed} removed`);
    if (skipped > 0) parts.push(`${skipped} unchanged`);
    const summary = parts.length > 0 ? parts.join(', ') : 'No changes';

    core.setOutput('summary', summary);
    core.info(`Sync complete: ${summary}`);

    // Log errors/warnings
    if (result.errors && result.errors.length > 0) {
      for (const err of result.errors) {
        core.warning(err);
      }
    }

    if (result.limit_warning) {
      core.warning(result.limit_warning);
    }

    // Job summary (shows in Actions UI)
    await core.summary
      .addHeading('RiskRaft Dependency Sync')
      .addTable([
        [{ data: 'Metric', header: true }, { data: 'Count', header: true }],
        ['Packages Added', String(added)],
        ['Packages Updated', String(updated)],
        ['Packages Removed', String(removed)],
        ['Packages Unchanged', String(skipped)],
      ])
      .addRaw(result.limit_warning ? `\n⚠️ ${result.limit_warning}` : '')
      .write();

  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();
