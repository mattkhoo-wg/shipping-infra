module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: { '^.+\.tsx?$': 'ts-jest' },
  collectCoverageFrom: ['lib/**/*.ts'],
  coverageThreshold: { global: { lines: 80, statements: 80 } },
};
