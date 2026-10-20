#!/usr/bin/env python3
"""Install the official PMTiles extractor used by Datapom's Mac download manager."""
from pathlib import Path
import hashlib
import io
import platform
import urllib.request
import zipfile

VERSION = '1.31.2'
# Release asset digests published by GitHub's official Protomaps release API.
DIGESTS = {
    'arm64': '40528f7f616fcbf91207cd48c8fc023d213f6d86c0cbf1f748732803d1880f3d',
    'x86_64': '1f0dc02eee6c58312dd6c509faee1b5c32f0596568af1bf51f1b034e7a88a65b',
}

def install(root=None):
    root = Path(root or Path(__file__).resolve().parents[1] / 'data')
    if platform.system() != 'Darwin':
        raise SystemExit('This installer is for the Mac that downloads map packs.')
    arch = 'arm64' if platform.machine() == 'arm64' else 'x86_64'
    name = f'go-pmtiles-{VERSION}_Darwin_{arch}.zip'
    base = f'https://github.com/protomaps/go-pmtiles/releases/download/v{VERSION}/'
    with urllib.request.urlopen(base + name, timeout=60) as response:
        archive = response.read()
    if hashlib.sha256(archive).hexdigest() != DIGESTS[arch]:
        raise SystemExit('Downloader checksum did not match; nothing was installed.')
    binary = zipfile.ZipFile(io.BytesIO(archive)).read('pmtiles')
    destination = root / 'tools' / 'pmtiles'
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix('.tmp'); temporary.write_bytes(binary); temporary.chmod(0o755); temporary.replace(destination)
    print('Map downloader installed. Use Photos & places → Offline map downloads.')

if __name__ == '__main__':
    install()
