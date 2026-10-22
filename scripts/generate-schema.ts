import { testJsonSchema } from "../src/editor-schema.ts";

await Bun.write(
  new URL("../schema/test.schema.json", import.meta.url),
  JSON.stringify(testJsonSchema(), null, 2) + "\n",
);
