# Vite + React over localcloud

```sh
npm install
npx -y localcloud-cli run -- npm run dev     # or: npm run dev, then npx -y localcloud-cli start 5173
```

Open the printed `https://…` URL, edit `src/App.jsx`, save: the page hot-updates and the counter
keeps its state. No `server.host`, `server.allowedHosts` or `server.hmr` settings are needed —
localcloud presents every request to Vite as coming from `localhost:5173`.
