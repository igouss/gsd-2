import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "dist/**",
      "dist-test/**",
      "node_modules/**",
      "native/**",
      "web/**",
      "studio/**",
      "scripts/**",
      "packages/*/dist/**",
    ],
  },
  {
    rules: {
      // TypeScript handles these better than ESLint
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Reasonable defaults for a TS codebase
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
