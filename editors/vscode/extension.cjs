const path = require('node:path');
const vscode = require('vscode');
const { diagnosticPath, readReport } = require('./runner.cjs');

const product = 'WinRecoveryProjectLinter';
const severities = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  information: vscode.DiagnosticSeverity.Information,
  style: vscode.DiagnosticSeverity.Hint,
  note: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

async function publishFindings(collection, prior, root, report) {
  const files = new Map();
  const resolved = new Map();
  for (const item of report.findings ?? []) {
    if (!resolved.has(item.file)) resolved.set(item.file, diagnosticPath(report.root, item.file));
    const file = await resolved.get(item.file);
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
  output.appendLine('\n' + folder.name + ' — ' + command);
  if (command === 'doctor') {
    output.appendLine(report.message ?? report.error ?? 'Adapter availability');
    for (const item of report.results ?? []) {
      output.appendLine('  ' + item.type + ' — ' + (item.available ? 'available' : 'unavailable') + (item.reason ? ' — ' + item.reason : ''));
    }
    return;
  }
  output.appendLine(report.status + ' — ' + (report.findings?.length ?? 0) + ' findings');
  for (const row of report.coverage ?? []) {
    const checked = row.checkedFiles ?? (row.status === 'checked' ? row.files : 0);
    output.appendLine('  ' + row.type + ' — ' + row.status + ', ' + checked + '/' + row.files + ' files' + (row.detail ? ' — ' + row.detail : ''));
  }
  if (report.error) output.appendLine('  ' + report.error);
  if (report.remedy) output.appendLine('  ' + report.remedy);
  for (const reason of report.incomplete ?? []) output.appendLine('  Incomplete — ' + reason);
  for (const notice of report.notices ?? []) output.appendLine('  Note — ' + notice);
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
          if (command === 'scan') await publishFindings(diagnostics, prior, folder.uri.fsPath, report);
          displayReport(output, folder, command, report);
          output.show(true);
        } catch (error) {
          if (!controller.signal.aborted) {
            output.appendLine(String(error.message));
            vscode.window.showErrorMessage(product + ' — ' + error.message);
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
