import { defineConfig } from "oxfmt";

export default defineConfig({
  semi: true,
  useTabs: false,
  printWidth: 120,
  trailingComma: "all",
  arrowParens: "always",
  objectWrap: "collapse",
  ignorePatterns: ["schema/**", "docs/evidence/**", "bun.lock"],
});
