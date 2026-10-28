import { serveGiantSite } from "../tests/browser/giant-site.ts";

// Serves the test pages of fixtures/giant-website for trying them by hand: bun run serve:giant [port]
const port = Number(process.argv[2] ?? 4173);
const server = serveGiantSite(port);
console.log(`Giant website: ${server.url}`);
console.log(`Pages: ${server.url}index.html (login for the popup: demo / s3cret!)`);
console.log("Listens on 127.0.0.1 only. Press Ctrl+C to stop.");
