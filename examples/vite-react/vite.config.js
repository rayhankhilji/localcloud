import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Nothing localcloud-specific here on purpose: localcloud rewrites the Host/Origin headers to
// localhost, so Vite's allowedHosts check passes, and the HMR client connects back through
// the page's own (public) origin.
export default defineConfig({ plugins: [react()] });
