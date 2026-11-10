"""Package only the Neo access tool and its instructions; never include local runtime or credentials."""
from pathlib import Path
import hashlib
import json
import stat
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = [
    'README.md', 'macos/bridges-client.sh',
    'docs/给Neo上的GPT.md', 'docs/首次配对与日常部署.md',
    'docs/验证记录_20261110.md',
]
DESTINATION = ROOT / 'release/Bridges_Neo接入工具_v0.1.0_20261110.zip'


def main():
    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    if DESTINATION.exists():
        raise SystemExit('Delivery already exists; preserved. Use a new version name for an update.')
    manifest = {}
    with zipfile.ZipFile(DESTINATION, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for relative in FILES:
            source = ROOT / relative
            data = source.read_bytes()
            if source.suffix == '.sh':
                data = data.replace(b'\r\n', b'\n')
            info = zipfile.ZipInfo('Bridges_Neo接入工具/' + relative)
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | (0o755 if source.suffix == '.sh' else 0o644)) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
            manifest[relative] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        archive.writestr('Bridges_Neo接入工具/manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    with zipfile.ZipFile(DESTINATION) as check:
        assert check.testzip() is None
        assert len(check.namelist()) == len(FILES) + 1
    checksum = hashlib.sha256(DESTINATION.read_bytes()).hexdigest()
    DESTINATION.with_suffix('.zip.sha256').write_text(checksum + '  ' + DESTINATION.name + '\n', encoding='utf-8')
    print(json.dumps({'archive': str(DESTINATION), 'bytes': DESTINATION.stat().st_size, 'sha256': checksum}, ensure_ascii=False))


if __name__ == '__main__':
    main()
