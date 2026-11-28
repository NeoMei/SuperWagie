import path from 'node:path';

export const WINDOWS_REGISTRY_PATH_KEYS = [
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  'HKCU\\Environment',
];

export const windowsRegistryPathQuery = (key) => ({
  command: path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'),
  args: ['query', key, '/v', 'Path'],
});

export const expandWindowsEnvReferences = (value) => (
  value.replace(/%([^%]+)%/g, (reference, name) => process.env[name] ?? reference)
);

export const parseWindowsRegistryPath = (stdout) => {
  const [, type = '', value = ''] = /^[ \t]*Path[ \t]+(REG_\S+)[ \t]+(.+?)\s*$/im.exec(stdout) ?? [];
  return { type, value };
};
