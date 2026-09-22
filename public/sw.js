self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Dados operacionais e páginas autenticadas permanecem sempre online. O
// service worker existe para instalação da PWA, sem servir números antigos.
self.addEventListener("fetch", () => undefined);
