import { defineConfig } from "oxlint";

export default defineConfig({
  categories: { correctness: "warn" },
  plugins: ["typescript", "unicorn", "oxc"],
  rules: { "eslint/no-unused-vars": "error" },
});
