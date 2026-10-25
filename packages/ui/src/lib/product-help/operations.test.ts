import { describe, expect, test } from 'bun:test';
import { runProductHelpOperation, type ProductHelpOperationDependencies } from './operations';

function setup() {
  let current = true;
  let saved: Parameters<ProductHelpOperationDependencies['save']>[0] = { locale: 'zh-CN', themeId: 'light', themeVariant: 'light', useSystemTheme: false };
  const writes: Array<Parameters<ProductHelpOperationDependencies['save']>[0]> = [];
  const applied: string[] = [];
  const dependencies: ProductHelpOperationDependencies = {
    isCurrent: () => current,
    isSupported: () => true,
    theme: { lightThemeId: 'light', darkThemeId: 'dark', systemVariant: 'dark' },
    save: async (patch) => { writes.push(patch); saved = { ...saved, ...patch }; return { ok: true }; },
    read: async () => saved,
    applyLanguage: (locale) => { applied.push(locale); },
    applyTheme: (mode) => { applied.push(mode); },
  };
  return { dependencies, writes, applied, switchRuntime: () => { current = false; } };
}

describe('product help operations', () => {
  test('saves and reads the chosen language before applying it', async () => {
    const { dependencies, writes, applied } = setup();
    expect(await runProductHelpOperation('language-en', dependencies)).toBe('completed');
    expect(writes).toEqual([{ locale: 'en' }]);
    expect(applied).toEqual(['en']);
  });

  test('uses the registered dark theme and verifies its saved selection', async () => {
    const { dependencies, writes, applied } = setup();
    expect(await runProductHelpOperation('theme-dark', dependencies)).toBe('completed');
    expect(writes).toEqual([{ themeId: 'dark', themeVariant: 'dark', useSystemTheme: false, lightThemeId: 'light', darkThemeId: 'dark' }]);
    expect(applied).toEqual(['dark']);
  });

  test('system mode preserves both theme preferences', async () => {
    const { dependencies, writes, applied } = setup();
    expect(await runProductHelpOperation('theme-system', dependencies)).toBe('completed');
    expect(writes).toEqual([{ themeId: 'dark', themeVariant: 'dark', useSystemTheme: true, lightThemeId: 'light', darkThemeId: 'dark' }]);
    expect(applied).toEqual(['system']);
  });

  test('a failed save cannot report completion or change the interface', async () => {
    const { dependencies, applied } = setup();
    dependencies.save = async () => ({ ok: false });
    expect(await runProductHelpOperation('language-en', dependencies)).toBe('failed');
    expect(applied).toEqual([]);
  });

  test('a newer different saved value is not overwritten by late completion', async () => {
    const { dependencies, applied } = setup();
    dependencies.read = async () => ({ locale: 'zh-CN' });
    expect(await runProductHelpOperation('language-en', dependencies)).toBe('failed');
    expect(applied).toEqual([]);
  });

  test('runtime switches prevent subsequent reads and interface changes', async () => {
    const { dependencies, applied, switchRuntime } = setup();
    let reads = 0;
    dependencies.save = async () => { switchRuntime(); return { ok: true }; };
    dependencies.read = async () => { reads++; return { locale: 'en' }; };
    expect(await runProductHelpOperation('language-en', dependencies)).toBe('failed');
    expect(reads).toBe(0);
    expect(applied).toEqual([]);
  });

  test('unsupported runtimes do not write settings', async () => {
    const { dependencies, writes } = setup();
    dependencies.isSupported = () => false;
    expect(await runProductHelpOperation('theme-light', dependencies)).toBe('unsupported');
    expect(writes).toEqual([]);
  });

  test('rejects an invented operation at the execution boundary', async () => {
    const { dependencies, writes } = setup();
    expect(await runProductHelpOperation('execute-shell', dependencies)).toBe('unsupported');
    expect(writes).toEqual([]);
  });
});
