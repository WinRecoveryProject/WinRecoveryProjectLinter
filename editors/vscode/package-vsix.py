"""Package the installed VS Code extension with the release's exact linter code."""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile

EDITOR = Path(__file__).resolve().parent
REPO = EDITOR.parents[1]
EXTENSION_FILES = ("README.md", "extension.cjs", "package.json", "runner.cjs")
CORE_FILES = {"package.json", "package-lock.json", "npm-shrinkwrap.json", "THIRD-PARTY-NOTICES.md", "LICENSE"}
CORE_PATHS = ("src/", "bin/", "adapters/", "config/", "licenses/")
STAMP = (1980, 1, 1, 0, 0, 0)


def native_payload():
    spec = importlib.util.spec_from_file_location("wrp_native", REPO / "scripts/package-native.py")
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    names = native.profile_entries(native.read_source(REPO, native.PROFILE))
    payload = {name: native.read_source(REPO, name) for name in names}
    version, _ = native.validate_payload(payload)
    return version, {
        "core/" + name: data
        for name, data in payload.items()
        if name in CORE_FILES or name.startswith(CORE_PATHS) and name != native.PROFILE
    } | {"icon.png": payload["assets/logo.png"], "LICENSE": payload["LICENSE"]}


def build(vsce, output):
    node = shutil.which("node")
    if not node:
        raise ValueError("Node.js 24+ is required to package the extension.")
    if output.suffix.lower() != ".vsix":
        raise ValueError("The output must be a .vsix file.")
    version, stage_files = native_payload()
    stage_files.update({name: (EDITOR / name).read_bytes() for name in EXTENSION_FILES})
    manifest = json.loads(stage_files["package.json"])
    if manifest["version"] != version:
        raise ValueError("The extension and bundled linter versions must match.")
    with tempfile.TemporaryDirectory(prefix="wrp-vscode-stage-") as directory:
        stage = Path(directory) / "extension"
        for name, data in stage_files.items():
            destination = stage / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        raw = Path(directory) / "raw.vsix"
        subprocess.run([node, str(vsce), "package", "--no-dependencies",
                        "--no-rewrite-relative-links", "--out", str(raw)],
                       cwd=stage, stdin=subprocess.DEVNULL, check=True)
        with zipfile.ZipFile(raw) as bundle:
            names = bundle.namelist()
            required = {"extension.vsixmanifest", "[Content_Types].xml"}
            packaged_names = {"README.md": "readme.md", "LICENSE": "LICENSE.txt"}
            archive_paths = {name: "extension/" + packaged_names.get(name, name) for name in stage_files}
            expected = required | set(archive_paths.values())
            if len(names) != len(expected) or set(names) != expected or bundle.testzip():
                raise ValueError("VSIX member set or integrity differs from the checked stage.")
            for name, data in stage_files.items():
                if bundle.read(archive_paths[name]) != data:
                    raise ValueError("VSIX payload changed during packaging: " + name)
            xml = ET.fromstring(bundle.read("extension.vsixmanifest"))
            identity = xml.find(".//{*}Identity")
            if identity is None or (identity.get("Id"), identity.get("Publisher"), identity.get("Version")) != (
                    manifest["name"], manifest["publisher"], version):
                raise ValueError("VSIX identity disagrees with extension/package.json.")
            with zipfile.ZipFile(output, mode="x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as release:
                for name in sorted(names):
                    info = zipfile.ZipInfo(name, STAMP)
                    info.create_system = 3
                    info.external_attr = 0o100644 << 16
                    release.writestr(info, bundle.read(name), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    print(json.dumps({"version": version, "files": len(expected),
                      "path": str(output), "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vsce", type=lambda value: Path(value).resolve(strict=True), required=True,
                        help="Existing @vscode/vsce 3.7.1 CLI script. The build does not download it.")
    parser.add_argument("--out", type=lambda value: Path(value).resolve(), required=True)
    args = parser.parse_args()
    vsce_package = json.loads((args.vsce.parent / "package.json").read_bytes())
    if vsce_package.get("name") != "@vscode/vsce" or vsce_package.get("version") != "3.7.1":
        parser.error("--vsce must refer to the @vscode/vsce 3.7.1 CLI script.")
    build(args.vsce, args.out)
