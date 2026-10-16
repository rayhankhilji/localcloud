# SSE + WebSocket over localcloud (zero dependencies)

```sh
npx -y localcloud-cli run -- npm run dev     # or: node server.js, then npx -y localcloud-cli start 8080
```

Open the printed `https://…` URL. The Server-Sent Events box ticks every second (streamed, not
buffered), and the websocket box echoes whatever you send. `server.js` is plain Node — a raw
`upgrade` handler with a ~40-line RFC 6455 frame codec — so nothing is hidden behind a library.
