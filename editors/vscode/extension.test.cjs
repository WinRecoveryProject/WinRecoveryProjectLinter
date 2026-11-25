const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const filename = path.join(__dirname, 'extension.cjs');
const source = readFileSync(filename, 'utf8');

test('manual scan and doctor respect trust and publish exact workspace diagnostics and coverage', async () => {
  const root = path.resolve('project with spaces');
  const callbacks = new Map();
  const entries = new Map();
  const output = [];
  const actions = [];
  const workspace = {
    isTrusted: false, workspaceFolders: [{ name: 'Root', uri: { scheme: 'file', fsPath: root } }],
    getConfiguration: () => ({ get: () => '' }),
  };
  const vscode = {
    workspace,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    Diagnostic: class Diagnostic { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
    Range: class Range { constructor(startLine, startColumn, endLine, endColumn) { Object.assign(this, { startLine, startColumn, endLine, endColumn }); } },
    Uri: { file: value => value },
    ProgressLocation: { Notification: 1 },
    languages: { createDiagnosticCollection: () => ({
      set: values => values.forEach(([file, diagnostics]) => entries.set(file, diagnostics)),
      delete: value => entries.delete(value),
    }) },
    commands: { registerCommand: (name, callback) => { callbacks.set(name, callback); return {}; } },
    window: {
      createOutputChannel: () => ({ appendLine: message => output.push(message), show: () => {} }),
      showWarningMessage: message => output.push(message),
      showErrorMessage: message => { throw Error(message); },
      withProgress: (_, callback) => callback(null, { onCancellationRequested: () => ({ dispose: () => {} }) }),
    },
  };
  const report = {
    root,
    status: 'INCOMPLETE',
    findings: [
      { file: 'test.lua', line: 3, column: 4, severity: 'warning', rule: 'LUA51-syntax', message: 'Finding' },
      { file: '../outside.lua', line: 1, column: 1, message: 'Ignored path' },
    ],
    coverage: [{ type: 'lua', status: 'checked', files: 1 }],
    incomplete: ['Another linter is unavailable'],
  };
  const runner = { async diagnosticPath(scanRoot, name) {
    assert.equal(scanRoot, report.root);
    return name === 'test.lua' ? path.join(scanRoot, name) : null;
  }, async readReport(command, options) {
    actions.push(command);
    assert.equal(options.root, root);
    assert.equal(options.engineRoot, path.join(path.dirname(filename), 'core'));
    if (command === 'doctor') return { results: [{ type: 'lua', available: true }] };
    return report;
  } };
  const mod = { exports: {} };
  const requireUnderTest = id => id === 'vscode' ? vscode : id === './runner.cjs' ? runner : require(id);
  vm.runInNewContext(source, { require: requireUnderTest, module: mod, AbortController }, { filename });
  mod.exports.activate({ extensionPath: path.dirname(filename), subscriptions: [] });
  const scan = callbacks.get('wrpLinter.scan');
  await scan();
  assert.equal(actions.length, 0);
  assert.match(output[0], /trusted local workspace/);
  workspace.isTrusted = true;
  await scan();
  assert.deepEqual(actions, ['scan']);
  assert.equal(entries.size, 1);
  const diagnostic = entries.get(path.join(root, 'test.lua'))[0];
  assert.equal(diagnostic.source, 'WinRecoveryProjectLinter');
  assert.equal(diagnostic.code, 'LUA51-syntax');
  assert.equal(diagnostic.severity, 1);
  assert.equal(diagnostic.range.startLine, 2);
  assert.equal(diagnostic.range.startColumn, 3);
  assert.match(output.join('\n'), /lua — checked, 1\/1 files/);
  assert.match(output.join('\n'), /Incomplete — Another linter is unavailable/);
  await callbacks.get('wrpLinter.doctor')();
  assert.deepEqual(actions, ['scan', 'doctor']);
  assert.equal(entries.size, 1);
  assert.match(output.join('\n'), /lua — available/);
  report.findings = [];
  await scan();
  assert.equal(entries.size, 0);
});
