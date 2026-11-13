import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./useProviderLogo.ts', import.meta.url), 'utf8');

describe('provider logo aliases', () => {
    test('maps rotating exe.dev proxy provider IDs to the local exe.dev logo', () => {
        expect(source).toContain("compact.startsWith('exe-') ? 'exe-dev' : undefined");
        expect(source).toContain('const candidates = [prefixAlias,');
    });

    test('aliases the copilot provider id to the bundled github-copilot logo', () => {
        expect(source).toContain("['copilot', 'github-copilot']");
    });

    test('uses the product mark for every account-backed SuperWagie provider', () => {
        expect(source).toContain("const SUPERWAGIE_PROVIDER_PREFIX = 'superwagie-account-';");
        expect(source).toContain("import productMarkUrl from '@/assets/provider-logos/superwagie.png?url'");
        expect(source).toContain('const SUPERWAGIE_LOGO_SRC = productMarkUrl;');
        expect(source).toContain("normalized === 'superwagie' || normalized.startsWith(SUPERWAGIE_PROVIDER_PREFIX)");
    });
});
