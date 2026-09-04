export function validateExtensionManifest(manifest, expectedVersion) {
  const keys = ['id', 'network', 'permissions', 'type', 'version'];
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(expectedVersion ?? '')
    || !manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || Object.keys(manifest).sort().join('\0') !== keys.sort().join('\0')
    || manifest.id !== 'task5.fixture.skill' || manifest.type !== 'skill'
    || manifest.version !== expectedVersion
    || !Array.isArray(manifest.permissions) || manifest.permissions.length !== 1
    || manifest.permissions[0] !== 'artifact.read_metadata'
    || !Array.isArray(manifest.network) || manifest.network.length !== 0) {
    throw new Error('INSTALL_MANIFEST_REJECTED');
  }
}

export function isExactDocumentUrl(candidateUrl, expectedUrl) {
  try {
    const parsed = new URL(candidateUrl);
    parsed.search = '';
    parsed.hash = '';
    return parsed.href === expectedUrl;
  } catch { return false; }
}
