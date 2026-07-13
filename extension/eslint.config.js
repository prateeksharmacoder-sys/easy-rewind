/**
 * ESLint flat config for easy-rewind extension
 */
module.exports = [
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        // Browser & Extension
        console: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        window: 'readonly',
        document: 'readonly',
        chrome: 'readonly',
        fetch: 'readonly',
        DOMParser: 'readonly',
        URL: 'readonly',
        Blob: 'readonly',
        FormData: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        location: 'readonly',
        navigator: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      semi: ['warn', 'always'],
      'no-var': 'warn',
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'smart'],
      'no-throw-literal': 'warn',
      'prefer-promise-reject-errors': 'warn',
      'no-prototype-builtins': 'warn',
    },
    ignores: ['node_modules/', 'tests/'],
  },
];
