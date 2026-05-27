import type { Config } from 'jest'

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        module: 'commonjs',
        moduleResolution: 'node',
        esModuleInterop: true,
        strict: true,
        target: 'ES2022',
        lib: ['ES2022'],
        skipLibCheck: true,
        types: ['node', 'jest'],
      },
    }],
  },
  testMatch: ['**/tests/**/*.test.ts'],
  testTimeout: 10000,
}

export default config
