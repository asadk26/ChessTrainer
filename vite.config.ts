import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { coachApiPlugin } from './server/coachPlugin.ts';

export default defineConfig(({ mode }) => {
  // Load ALL env vars (not just VITE_*) for the server-side LLM proxy only.
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), '') };
  return {
    plugins: [react(), coachApiPlugin(env)],
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts'],
      testTimeout: 120_000,
    },
  };
});
