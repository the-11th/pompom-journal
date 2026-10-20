"""Refresh only Datapom's existing Dock tile after its app bundle is renamed."""
from copy import deepcopy
from pathlib import Path
import plistlib
import subprocess


def renamed_tiles(tiles):
    result = deepcopy(tiles)
    paths = {f'file:///Applications/{name}.app/' for name in ('TodoPom', 'TodoPup', 'Datapom')}
    for item in result:
        tile = item.get('tile-data', {})
        file = tile.get('file-data', {})
        if file.get('_CFURLString', '').rstrip('/') + '/' not in paths:
            continue
        file['_CFURLString'] = 'file:///Applications/Datapom.app/'
        tile['file-label'] = 'Datapom'
        # The Dock regenerates its bookmark from the new URL. Keep the tile's
        # GUID, position, bundle identifier and all other custom properties.
        tile.pop('book', None)
    return result


def refresh_dock():
    if not Path('/Applications/Datapom.app').is_dir():
        raise SystemExit('Install Datapom before updating the Dock shortcut.')
    read = lambda: plistlib.loads(subprocess.check_output(['/usr/bin/defaults', 'export', 'com.apple.dock', '-']))
    original = read().get('persistent-apps', [])
    updated = renamed_tiles(original)
    if updated == original:
        print('The Dock shortcut is already current.')
        return
    values = [plistlib.dumps(item).decode() for item in updated]
    subprocess.run(['/usr/bin/defaults', 'write', 'com.apple.dock', 'persistent-apps', '-array', *values], check=True)
    if read().get('persistent-apps') != updated:
        raise SystemExit('The Dock preference did not verify; its process has not been restarted.')
    print('Datapom Dock shortcut updated in its existing position.')


if __name__ == '__main__':
    refresh_dock()
