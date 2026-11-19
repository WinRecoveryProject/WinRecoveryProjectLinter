# WinRecoveryProjectLinter for Visual Studio Code

Run the same WinRecoveryProjectLinter 0.1.6 engine from VS Code. The VSIX bundles the engine independently of Codex.

1. Use desktop VS Code 1.90 or later and Node.js 24 or later. If VS Code cannot find Node through its host PATH, set `wrpLinter.nodePath` in User Settings to an absolute Node executable outside the project.
2. Open a trusted local workspace.
3. In the Command Palette, run **WinRecoveryProjectLinter: Scan Workspace Folder** or **WinRecoveryProjectLinter: Check Linter Availability**. In a multi-root workspace, select the folder to check.

Open **Problems** to navigate findings and the **WinRecoveryProjectLinter** Output channel to see checked file counts, missing adapters and coverage gaps. The linter scans saved files. An incomplete report can still contain findings for the families that were checked.

The scan uses the existing data-only `.wrp-lint.json` for language selection, excluded paths and the SQL dialect. The VSIX contains the runner, adapters and pinned dependency metadata. If the host has already prepared the compatible per-user linter cache, the extension uses it. Otherwise use the CLI's explicit setup command to prepare the selected adapters:

```text
node "<extension directory>/core/bin/wrp-lint.mjs" setup "<workspace folder>" --detected
```

Scan and Check Availability are manual and read-only. Both use local tools and avoid telemetry, cloud services, automatic setup and execution of project code. Setup may download pinned tools from the public registry when you start it yourself. External language tools such as PowerShell, Bash or Python have their own local prerequisites. See the [CLI documentation](https://github.com/WinRecoveryProject/WinRecoveryProjectLinter) for supported languages and limits.

## Build

From the repository root, run the following command with an existing copy of Microsoft's `@vscode/vsce` 3.7.1. The packager uses the repository's native whitelist to stage the checked core files, verifies the official VSIX output and normalizes ZIP member order and timestamps.

```text
python -I -B editors/vscode/package-vsix.py --vsce "<path to @vscode/vsce/vsce>" --out "<destination>/winrecoveryproject-linter-0.1.6.vsix"
node --test editors/vscode/runner.test.cjs
```
