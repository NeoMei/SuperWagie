// Source-build receipt contract. These values identify reviewed input and the
// deterministic patch; a manifest carrying them does not attest binary origin.
const ANYDOC_SOURCE_POLICY = Object.freeze({
  version: '0.2.4',
  sourceSha256: 'cf0d78e4cfe3654eb3ea04422ec5a94352000ee56e97902125e68e51f7527062',
  patchedTreeSha256: 'a9641c5da12abbc3f492e75f6140d7e2c57a78edd012110c57ed6836cb221cde',
});

function matchesAnyDocSourcePolicy(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 3
    && Object.entries(ANYDOC_SOURCE_POLICY).every(([key, expected]) => Object.hasOwn(value, key) && value[key] === expected);
}

// The previously audited Windows artifact predates source receipts. This is an
// exception for those exact bytes and source labels, never a manifest opt-out.
function isPinnedWindowsKnowledgePrebuilt(manifest, platform, architecture, actualBinarySha256) {
  return platform === 'win32' && architecture === 'x64'
    && actualBinarySha256 === 'bed12a528363cccbab302db63d27f5e60d780faa08623ba94b6bd4560fc4c162'
    && manifest?.repository === 'https://github.com/NeoMei/embedded-knowledge'
    && manifest?.ref === 'embedded-knowledge'
    && manifest?.commit === 'f5adb9eac166e7d3da7dceed7aa50049d4c4db1f'
    && manifest?.binary === 'embedded-knowledge-server.exe'
    && !Object.hasOwn(manifest, 'anydocSource')
    && manifest?.windowsPatch?.target === 'x86_64-pc-windows-gnu'
    && manifest?.windowsPatch?.sha256 === 'cd7d7a4a296acfe0ec5766b51682ff076e84f3938208823605f51e1e6f2ece71';
}

module.exports = { ANYDOC_SOURCE_POLICY, matchesAnyDocSourcePolicy, isPinnedWindowsKnowledgePrebuilt };
