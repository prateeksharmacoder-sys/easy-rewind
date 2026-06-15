/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  transform: {},
  // Suppress deprecation warnings from better-sqlite3
  testPathIgnorePatterns: ['/node_modules/'],
  // Ensure tests don't time out
  testTimeout: 30000,
};
