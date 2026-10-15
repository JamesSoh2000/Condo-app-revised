import globals from "globals";
import pluginJs from "@eslint/js";
import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks";
import pluginUnusedImports from "eslint-plugin-unused-imports";
import tseslint from "typescript-eslint";

// New and migrated code must reach the API through src/api, never Base44 (ADR-0011). One regex covers
// the SDK, the legacy client and its re-exporting barrels (entities, integrations), with any path prefix
// (`@/`, `../`) and with or without a file extension.
const BASE44_SOURCE = "^(@base44/|(.*/)?api/(base44Client|entities|integrations)(\\.[cm]?[jt]sx?)?$)";
const BASE44_MESSAGE = "New code uses the typed client in src/api, not Base44 (ADR-0011).";
const noBase44Imports = ["error", { patterns: [{ regex: BASE44_SOURCE, message: BASE44_MESSAGE }] }];
// no-restricted-imports only sees static imports/exports; dynamic import() and require() need this.
// esquery regex literals can't contain "/", even escaped, so it is written as \x2F.
const esqueryBase44 = `/${BASE44_SOURCE.replaceAll("/", "\\x2F")}/`;
const noBase44DynamicImports = [
  "error",
  { selector: `ImportExpression[source.value=${esqueryBase44}]`, message: BASE44_MESSAGE },
  {
    selector: `CallExpression[callee.name="require"][arguments.0.value=${esqueryBase44}]`,
    message: BASE44_MESSAGE,
  },
];

export default [
  {
    files: [
      "src/components/**/*.{js,mjs,cjs,jsx}",
      "src/pages/**/*.{js,mjs,cjs,jsx}",
      "src/Layout.jsx",
    ],
    ignores: ["src/lib/**/*", "src/components/ui/**/*"],
    ...pluginJs.configs.recommended,
    ...pluginReact.configs.flat.recommended,
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    plugins: {
      react: pluginReact,
      "react-hooks": pluginReactHooks,
      "unused-imports": pluginUnusedImports,
    },
    rules: {
      "no-unused-vars": "off",
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "error",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],
      "react/prop-types": "off",
      "react/react-in-jsx-scope": "off",
      "react/no-unknown-property": [
        "error",
        { ignore: ["cmdk-input-wrapper", "toast-close", "jsx"] },
      ],
      "react-hooks/rules-of-hooks": "error",
    },
  },
  // TypeScript files (new and migrated code, ADR-0015).
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["src/**/*.{ts,tsx}"],
  })),
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": pluginReactHooks },
    rules: { "react-hooks/rules-of-hooks": "error" },
  },
  {
    files: ["src/features/**/*.{js,jsx,ts,tsx}", "src/app/**/*.{js,jsx,ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-restricted-imports": noBase44Imports,
      "no-restricted-syntax": noBase44DynamicImports,
    },
  },
];
