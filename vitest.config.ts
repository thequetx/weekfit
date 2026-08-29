import { defineConfig } from 'vitest/config';

// Separate from any bundler config on purpose: these tests cover pure logic
// (src/lib) plus one placeholder React component, not a real app build.
//
// Everything under test that touches a `Date` is local-time by design — same
// as week-dashboard, which this port's src/lib came from — so a run has to
// pin one, or the DST tests would quietly pass anywhere that doesn't observe
// daylight saving. Sydney, because that's what week-dashboard's own
// vitest.config.ts pins and test/dst.test.ts asserts the timezone actually
// took (ported verbatim from there).
process.env.TZ = 'Australia/Sydney';

export default defineConfig({
  test: {
    env: { TZ: 'Australia/Sydney' },
    projects: [
      {
        test: {
          name: 'lib',
          include: ['test/**/*.test.ts'],
          environment: 'node',
          env: { TZ: 'Australia/Sydney' },
        },
      },
      {
        test: {
          name: 'components',
          include: ['test/**/*.test.tsx'],
          environment: 'jsdom',
          // Testing Library registers its own afterEach(cleanup) only when the
          // framework hooks are global. Without this every component test has
          // to remember an explicit cleanup, and the one that forgets leaks a
          // mounted tree into the next test in the same file.
          globals: true,
          env: { TZ: 'Australia/Sydney' },
        },
      },
    ],
  },
});
