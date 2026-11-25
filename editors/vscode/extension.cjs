const path = require('node:path');
const vscode = require('vscode');
const { diagnosticPath, readReport } = require('./runner.cjs');

const product = 'WinRecoveryProjectLinter';
const displayControls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const visibleText = value => String(value).replace(displayControls, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
const appendTextLine = (output, value = '') => output.appendLine(visibleText(value));
const severities = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  information: vscode.DiagnosticSeverity.Information,
  style: vscode.DiagnosticSeverity.Hint,
  note: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

function publishFindings(collection, prior, root, report) {
  const files = new Map();
  for (const item of report.findings ?? []) {
    const file = diagnosticPath(root, item.file);
    if (!file || typeof item.message !== 'string') continue;
    const line = Number.isSafeInteger(item.line) ? Math.max(0, item.line - 1) : 0;
    const column = Number.isSafeInteger(item.column) ? Math.max(0, item.column - 1) : 0;
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(line, column, line, column + 1), item.message,
      severities[item.severity] ?? vscode.DiagnosticSeverity.Information,
    );
    diagnostic.source = product;
    diagnostic.code = item.rule;
    if (!files.has(file)) files.set(file, []);
    files.get(file).push(diagnostic);
  }
  for (const file of prior.get(root) ?? []) {
    if (!files.has(file)) collection.delete(vscode.Uri.file(file));
  }
  collection.set([...files].map(([file, items]) => [vscode.Uri.file(file), items]));
  prior.set(root, new Set(files.keys()));
}

function displayReport(output, folder, command, report) {
  appendTextLine(output);
  appendTextLine(output, folder.name + ' — ' + command);
  if (command === 'doctor') {
    appendTextLine(output, report.message ?? report.error ?? 'Adapter availability');
    for (const item of report.results ?? []) {
      appendTextLine(output, '  ' + item.type + ' — ' + (item.available ? 'available' : 'unavailable') + (item.reason ? ' — ' + item.reason : ''));
    }
    return;
  }
  appendTextLine(output, report.status + ' — ' + (report.findings?.length ?? 0) + ' findings');
  for (const row of report.coverage ?? []) {
    const checked = row.checkedFiles ?? (row.status === 'checked' ? row.files : 0);
    appendTextLine(output, '  ' + row.type + ' — ' + row.status + ', ' + checked + '/' + row.files + ' files' + (row.detail ? ' — ' + row.detail : ''));
  }
  if (report.error) appendTextLine(output, '  ' + report.error);
  if (report.remedy) appendTextLine(output, '  ' + report.remedy);
  for (const reason of report.incomplete ?? []) appendTextLine(output, '  Incomplete — ' + reason);
  for (const notice of report.notices ?? []) appendTextLine(output, '  Note — ' + notice);
}

function activate(context) {
  const output = vscode.window.createOutputChannel(product);
  const diagnostics = vscode.languages.createDiagnosticCollection('wrp-linter');
  const prior = new Map();
  let busy = false;

  async function invoke(command) {
    const projectFolders = vscode.workspace.workspaceFolders ?? [];
    const folders = projectFolders.filter(folder => folder.uri.scheme === 'file');
    if (!vscode.workspace.isTrusted || !folders.length) {
      vscode.window.showWarningMessage(product + ' requires a trusted local workspace folder.');
      return;
    }
    if (busy) {
      vscode.window.showInformationMessage(product + ' is already running.');
      return;
    }
    busy = true;
    try {
      const folder = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(
        folders.map(value => ({ label: value.name, description: value.uri.fsPath, value })),
        { placeHolder: 'Choose a folder to check' },
      ))?.value;
      if (!folder) return;
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: product,
        cancellable: true,
      }, async (_, token) => {
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) controller.abort();
        try {
          const report = await readReport(command, {
            engineRoot: path.join(context.extensionPath, 'core'),
            root: folder.uri.fsPath,
            workspaceRoots: folders.map(value => value.uri.fsPath),
            configuredNode: vscode.workspace.getConfiguration('wrpLinter').get('nodePath'),
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          if (command === 'scan') publishFindings(diagnostics, prior, folder.uri.fsPath, report);
          displayReport(output, folder, command, report);
          output.show(true);
        } catch (error) {
          if (!controller.signal.aborted) {
            const message = visibleText(error.message);
            appendTextLine(output, message);
            vscode.window.showErrorMessage(product + ' — ' + message);
          }
        } finally {
          cancellation.dispose();
        }
      });
    } finally {
      busy = false;
    }
  }

  context.subscriptions.push(output, diagnostics,
    vscode.commands.registerCommand('wrpLinter.scan', () => invoke('scan')),
    vscode.commands.registerCommand('wrpLinter.doctor', () => invoke('doctor')),
  );
}

module.exports = { activate };
