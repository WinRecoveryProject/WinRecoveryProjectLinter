const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');

const run = promisify(execFile);
const statuses = ['CLEAN', 'FINDINGS', 'INCOMPLETE'];

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

function diagnosticPath(root, name) {
  if (typeof name !== 'string' || !name || name.includes(':') || /\p{Cc}/u.test(name) || path.isAbsolute(name) || /^[\\/]/.test(name)) return null;
  const candidate = path.resolve(root, name.replaceAll('\\', '/'));
  return candidate !== root && isInside(root, candidate) ? candidate : null;
}

async function processEnvironment(configuredNode, roots, env = process.env) {
  const child = { ...env };
  const envKey = name => Object.keys(child).find(key => key.toUpperCase() === name) || name;
  const pathKey = envKey('PATH');
  const modulesKey = envKey('PSMODULEPATH');
  const inheritedHooks = ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'BASH_ENV', 'ENV'];
  for (const key of Object.keys(child)) {
    const upper = key.toUpperCase();
    if (inheritedHooks.includes(upper) || upper.startsWith('WRP_LINT_')) delete child[key];
  }
  const realRoots = await Promise.all(roots.map(async root => {
    try { return await fs.realpath(root); } catch { return path.resolve(root); }
  }));
  const outside = location => !realRoots.some(root => isInside(root, location));
  async function outsideDirectories(value) {
    const directories = new Set();
    for (const entry of (value || '').split(path.delimiter)) {
      if (!path.isAbsolute(entry)) continue;
      try {
        const physical = await fs.realpath(entry);
        if (outside(physical) && (await fs.stat(physical)).isDirectory()) directories.add(physical);
      } catch { /* Missing entries do not supply a trusted runtime. */ }
    }
    return [...directories];
  }
  const pathEntries = await outsideDirectories(child[pathKey]);
  child[pathKey] = pathEntries.join(path.delimiter);
  if (child[modulesKey]) child[modulesKey] = (await outsideDirectories(child[modulesKey])).join(path.delimiter);
  if (configuredNode && !path.isAbsolute(configuredNode)) {
    throw new Error('wrpLinter.nodePath must be an absolute path to Node.js outside the workspace.');
  }
  const executable = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates = configuredNode ? [configuredNode] : pathEntries.map(entry => path.join(entry, executable));
  for (const candidate of candidates) {
    try {
      const physical = await fs.realpath(candidate);
      if (outside(physical) && (await fs.stat(physical)).isFile()) return { node: physical, env: child };
    } catch { /* Continue with the next explicit host PATH entry. */ }
  }
  throw new Error('Node.js 24 or newer was not found outside the workspace. Configure wrpLinter.nodePath at user level or add Node.js to the host PATH.');
}

async function validateRuntimeCache(engineRoot, workspaceRoots, env) {
  const runtime = await import(pathToFileURL(path.join(engineRoot, 'src', 'runtime-cache.mjs')).href);
  return runtime.assertRuntimeCacheDisjoint(workspaceRoots, { cacheRoot: runtime.defaultCacheRoot({ env }) });
}

async function readReport(command, { engineRoot, root, workspaceRoots, configuredNode, signal }) {
  if (!['scan', 'doctor'].includes(command)) throw new Error('Unsupported linter command.');
  const { node, env } = await processEnvironment(configuredNode, workspaceRoots);
  await validateRuntimeCache(engineRoot, workspaceRoots, env);
  const options = { cwd: engineRoot, env, signal, windowsHide: true, maxBuffer: 32 * 1024 * 1024 };
  const version = (await run(node, ['--version'], options)).stdout.trim().match(/^v(\d+)\./);
  if (!version || Number(version[1]) < 24) throw new Error('WinRecoveryProjectLinter requires Node.js 24 or newer.');
  const args = [path.join(engineRoot, 'bin', 'wrp-lint.mjs'), command, root, '--format', 'json'];
  let result;
  try {
    result = { ...(await run(node, args, options)), code: 0 };
  } catch (error) {
    if (signal?.aborted || ![1, 2].includes(error.code) || !error.stdout) throw error;
    result = error;
  }
  let report;
  try { report = JSON.parse(result.stdout); } catch { throw new Error('The bundled linter produced an invalid JSON report.'); }
  if (!report || report.exitCode !== result.code || (command === 'scan' && report.status !== statuses[result.code])) {
    throw new Error('The bundled linter report disagrees with its process status.');
  }
  return report;
}

module.exports = { diagnosticPath, processEnvironment, readReport, validateRuntimeCache };
