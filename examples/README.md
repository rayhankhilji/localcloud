# Examples

Tiny dev servers that show localcloud working with the things that usually break behind a tunnel:
HMR websockets, framework host checks, Server-Sent Events and raw websocket upgrades.

| Example | What it shows |
| --- | --- |
| [`vite-react/`](vite-react/) | Vite + React with HMR — no `server.allowedHosts` / `hmr.clientPort` config needed |
| [`nextjs/`](nextjs/) | Next.js App Router dev server with Fast Refresh and a server action |
| [`express-sse-websocket/`](express-sse-websocket/) | Zero-dependency Node server: SSE stream + websocket echo |

Each one runs with:

```sh
npx -y localcloud-cli run -- npm run dev
```

(`localcloud run` starts the command and shares whatever port it opens. Needs a relay:
`--relay https://…`, `LOCALCLOUD_RELAY`, or a `localcloud.json`.)
