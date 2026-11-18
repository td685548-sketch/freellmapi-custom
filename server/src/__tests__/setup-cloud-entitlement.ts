import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { beforeAll } from 'vitest';
import { ENV_AI_ACTIVATION_TOKEN } from '../custom/cloud-entitlement/constants.js';
import { refreshCloudEntitlementLease } from '../custom/cloud-entitlement/service.js';

function loadEnvTokenIfPresent(): void {
  if (process.env[ENV_AI_ACTIVATION_TOKEN]?.trim()) return;
  const candidateEnvFiles = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../.env'),
    path.resolve(process.cwd(), '../../../.env'),
  ];
  for (const envPath of candidateEnvFiles) {
    if (!fs.existsSync(envPath)) continue;
    try {
      const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
      const token = parsed[ENV_AI_ACTIVATION_TOKEN]?.trim();
      if (token) {
        process.env[ENV_AI_ACTIVATION_TOKEN] = token;
        return;
      }
    } catch {
      // Ignore unreadable candidate .env files
    }
  }
}

loadEnvTokenIfPresent();

beforeAll(async () => {
  if (process.env[ENV_AI_ACTIVATION_TOKEN]?.trim()) {
    await refreshCloudEntitlementLease();
  }
});
