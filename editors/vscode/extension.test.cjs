const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const { diagnosticPath } = require('./runner.cjs');

const filename = path.join(__dirname, 'extension.cjs');
const source = readFileSync(filename, 'utf8');

test('manual scan and doctor respect trust and publish exact workspace diagnostics and coverage', async () => {
  const root = path.resolve('project with spaces');
  const callbacks = new Map();
  const entries = new Map();
  const output = [];
  const actions = [];
  const workspace = {
    isTrusted: false, workspaceFolders: [{ name: 'Root\n\u001b[2J', uri: { scheme: 'file', fsPath: root } }],
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
    status: 'INCOMPLETE',
    findings: [
      { file: 'test.lua', line: 3, column: 4, severity: 'warning', rule: 'LUA51-syntax', message: 'Finding' },
      { file: '../outside.lua', line: 1, column: 1, message: 'Ignored path' },
    ],
    coverage: [{ type: 'lua', status: 'checked', files: 1, detail: 'Checked\r\u0085\u2028' }],
    incomplete: ['Another linter is unavailable\n\u001b]8;;forged'],
    notices: ['Notice\u007f\u2029forged'],
  };
  const runner = { diagnosticPath, async readReport(command, options) {
    actions.push(command);
    assert.equal(options.root, root);
    assert.equal(options.engineRoot, path.join(path.dirname(filename), 'core'));
    if (command === 'doctor') return { message: 'Availability\u0000only', results: [{ type: 'lua', available: true, reason: 'reason\t\u009b' }] };
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
  assert.ok(output.every(line => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(line)));
  assert.ok(output.join('\n').includes('Root\\u000a\\u001b[2J'));
  assert.ok(output.join('\n').includes('Checked\\u000d\\u0085\\u2028'));
  assert.ok(output.join('\n').includes('unavailable\\u000a\\u001b]8;;forged'));
  assert.ok(output.join('\n').includes('Notice\\u007f\\u2029forged'));
  assert.match(output.join('\n'), /lua — checked, 1\/1 files/);
  assert.match(output.join('\n'), /Incomplete — Another linter is unavailable/);
  await callbacks.get('wrpLinter.doctor')();
  assert.deepEqual(actions, ['scan', 'doctor']);
  assert.equal(entries.size, 1);
  assert.ok(output.join('\n').includes('Availability\\u0000only'));
  assert.ok(output.join('\n').includes('reason\\u0009\\u009b'));
  assert.match(output.join('\n'), /lua — available/);
  report.findings = [];
  await scan();
  assert.equal(entries.size, 0);
});
