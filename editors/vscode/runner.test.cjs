const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { diagnosticPath, processEnvironment, readReport } = require('./runner.cjs');

const core = process.env.WRP_TEST_PACKAGED_CORE || path.resolve(__dirname, '..', '..');

test('findings resolve inside the workspace only', () => {
  const root = path.resolve(os.tmpdir(), 'test root');
  assert.equal(diagnosticPath(root, 'src/file.json'), path.join(root, 'src', 'file.json'));
  assert.equal(diagnosticPath(root, '..\\outside.json'), null);
  assert.equal(diagnosticPath(root, '/../outside.json'), null);
  assert.equal(diagnosticPath(root, 'C:/outside.json'), null);
  assert.equal(diagnosticPath(root, 'file.json:alternate'), null);
});

test('runner ignores workspace and relative PATH entries and Node startup hooks', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wrp-vscode-path-'));
  t.after(() => fs.rmdir(root));
  const result = await processEnvironment(process.execPath, [root], {
    PATH: ['.', root, path.dirname(process.execPath)].join(path.delimiter), NODE_OPTIONS: '--require project-hook', NODE_PATH: root,
    WRP_LINT_PWSH: root, BASH_ENV: root, PSModulePath: [root, path.dirname(process.execPath)].join(path.delimiter),
  });
  assert.equal(result.node, await fs.realpath(process.execPath));
  assert.equal(result.env.PATH, await fs.realpath(path.dirname(process.execPath)));
  assert.equal(result.env.NODE_OPTIONS, undefined);
  assert.equal(result.env.NODE_PATH, undefined);
  assert.equal(result.env.WRP_LINT_PWSH, undefined);
  assert.equal(result.env.BASH_ENV, undefined);
  assert.equal(result.env.PSModulePath, await fs.realpath(path.dirname(process.execPath)));
  await assert.rejects(processEnvironment('./node', [root]), /absolute/);
});

test('bundled executable produces real doctor, finding, clean and incomplete reports', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wrp-vscode workspace-'));
  const file = path.join(root, 'bad.json');
  const unsupported = path.join(root, 'styles.less');
  t.after(async () => {
    await fs.rm(file, { force: true });
    await fs.rm(unsupported, { force: true });
    await fs.rmdir(root);
  });
  const options = { engineRoot: core, root, workspaceRoots: [root], configuredNode: process.execPath };
  await fs.writeFile(file, '{ "broken": ] }\n');
  const doctor = await readReport('doctor', options);
  assert.equal(doctor.exitCode, 0, JSON.stringify(doctor));
  assert.ok(doctor.results.some(item => item.type === 'json' && item.available));
  const findings = await readReport('scan', options);
  assert.equal(findings.status, 'FINDINGS');
  assert.equal(findings.exitCode, 1);
  assert.equal(findings.version, '0.1.6');
  assert.ok(findings.findings.some(item => item.file === 'bad.json' && item.line === 1 && item.column > 0));
  assert.equal(diagnosticPath(root, findings.findings[0].file), file);
  await fs.writeFile(file, '{}\n');
  assert.equal((await readReport('scan', options)).status, 'CLEAN');
  await fs.writeFile(unsupported, 'p { color: red; }\n');
  const incomplete = await readReport('scan', options);
  assert.equal(incomplete.status, 'INCOMPLETE');
  assert.equal(incomplete.exitCode, 2);
  assert.ok(incomplete.incomplete.some(reason => reason.includes('SCSS') || reason.includes('less')));
});
