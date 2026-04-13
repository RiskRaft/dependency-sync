const core = require('@actions/core');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

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
    const transport = parsedUrl.protocol === 'https:' ? https : http;

    const req = transport.request(parsedUrl, options, (res) => {
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

    // Find manifest files
    let manifestPaths;
    if (manifestInput) {
      manifestPaths = manifestInput.split(',').map(f => f.trim()).filter(Boolean);
      // Validate they exist
      for (const p of manifestPaths) {
        if (!fs.existsSync(p)) {
          core.warning(`Manifest file not found: ${p}`);
        }
      }
      manifestPaths = manifestPaths.filter(p => fs.existsSync(p));
    } else {
      const workspace = process.env.GITHUB_WORKSPACE || '.';
      manifestPaths = findManifests(workspace);
      core.info(`Auto-detected ${manifestPaths.length} manifest file(s)`);
    }

    if (manifestPaths.length === 0) {
      core.warning('No manifest files found. Nothing to sync.');
      core.setOutput('summary', 'No manifest files found');
      return;
    }

    // Read file contents
    const files = manifestPaths.map(filePath => ({
      filename: path.basename(filePath),
      content: fs.readFileSync(filePath, 'utf-8'),
    }));

    core.info(`Syncing ${files.length} manifest(s): ${files.map(f => f.filename).join(', ')}`);

    // Build request
    const payload = { files, mode };
    if (projectId) {
      payload.project_id = projectId;
    } else if (projectName) {
      payload.project_name = projectName;
    }

    const body = JSON.stringify(payload);
    const endpoint = `${apiUrl.replace(/\/$/, '')}/v1/api/subscriptions/import/manifest`;

    const response = await makeRequest(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
    }, body);

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
