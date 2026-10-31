import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

/**
 * Worker / Durable Object 測試 config（PLAN §5.5）。
 * 用 @cloudflare/vitest-plugin：測試喺 workerd 執行，`SELF.fetch()` 直接 call Worker，
 * `env.LIVE_SHARE` 係真 DO binding，WebSocket 經 `SELF.fetch(..., { headers: { Upgrade } })`。
 *
 * 同前端 jsdom 測試分開跑（見 package.json `test:worker`）—— runtime 唔同，唔可以混。
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.jsonc' },
    }),
  ],
  test: {
    include: ['worker/**/*.test.ts'],
  },
});
