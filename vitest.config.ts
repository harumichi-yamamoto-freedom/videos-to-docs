import { fileURLToPath, URL } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
        },
    },
    test: {
        // e2e/ は Playwright (別ランナー・別 package.json)。vitest が spec を拾うと @playwright/test の import で落ちる
        exclude: [...configDefaults.exclude, 'e2e/**'],
    },
});
