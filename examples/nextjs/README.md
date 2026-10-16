# Next.js over localcloud

```sh
npm install
npx -y localcloud-cli run -- npm run dev     # or: npm run dev, then npx -y localcloud-cli start 3000
```

Open the printed `https://…` URL. Fast Refresh works over the tunnel's websocket, and the server
action works without `allowedDevOrigins` / `serverActions.allowedOrigins`, because localcloud
rewrites `Host` and `Origin` to `localhost:3000`. The page shows the public URL from the
`X-Localcloud-Url` request header localcloud adds.
