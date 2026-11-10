"""Build the reviewed macOS ground station in a fresh directory; never write to the source project."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import runpy
import sys


def sha(file: Path) -> str:
    result = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def contained(root: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def verify_sources(project: Path, manifest: dict) -> None:
    for name, record in manifest['sources'].items():
        relative = PurePosixPath(name)
        source = project.joinpath(*relative.parts)
        if relative.is_absolute() or '..' in relative.parts or not contained(project, source):
            raise RuntimeError('Source manifest points outside its project')
        if not source.is_file() or sha(source) != record['sha256']:
            raise RuntimeError('Source changed during packaging: ' + name)


def build(project: Path, job: Path, expected_builder: str) -> dict:
    project, job = project.resolve(strict=True), job.resolve(strict=True)
    if contained(project, job):
        raise RuntimeError('Job directory must be outside the original project')
    # Exclusive marker prevents accidental overwrite or reuse of an earlier build.
    with (job / 'build.lock').open('x', encoding='utf-8') as stream:
        stream.write(str(os.getpid()))
    builder = project / '地面站/packaging/macos/build_macos.py'
    if not contained(project, builder) or sha(builder) != expected_builder:
        raise RuntimeError('Builder differs from the reviewed version')
    module = runpy.run_path(str(builder), run_name='bridges_isolated_builder')
    context = module['stage'].__globals__
    # Functions share this namespace. Override their output locations in memory only.
    stage = job / 'stage'
    dist = job / 'dist'
    package = stage / (context['NAME'] + 'Mac版')
    app = package / (context['NAME'] + '.app')
    resource = app / 'Contents/Resources'
    context.update(STAGE=stage, DIST=dist, PACKAGE=package, APP=app, RES=resource,
                   BUNDLED_PROJECT=resource / 'project', COPIED={})
    manifest = context['stage']()
    if not manifest.get('sources'):
        raise RuntimeError('No source manifest was produced')
    verify_sources(project, manifest)
    context['archive'](manifest)
    verify_sources(project, manifest)
    if sha(builder) != expected_builder:
        raise RuntimeError('Builder changed during packaging')
    archives = list(dist.glob('*.zip'))
    if len(archives) != 1 or archives[0].name.endswith('.partial.zip'):
        raise RuntimeError('Expected one complete deployment archive')
    archive = archives[0]
    receipt = {
        'schema': 1, 'artifact': archive.relative_to(job).as_posix(),
        'sha256': sha(archive), 'bytes': archive.stat().st_size,
        'version': context['VERSION'], 'architecture': 'arm64',
        'builder_sha256': expected_builder, 'source_count': len(manifest['sources']),
        'sources_verified': True, 'original_project_written': False,
        'mac_tested': False, 'hardware_tested': False,
    }
    (job / 'source-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    (job / 'receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project-root', type=Path, required=True)
    parser.add_argument('--job-dir', type=Path, required=True)
    parser.add_argument('--builder-sha256', required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.project_root, args.job_dir, args.builder_sha256), ensure_ascii=False))


if __name__ == '__main__':
    main()
