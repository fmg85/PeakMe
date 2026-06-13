import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import './index.css'
import { initSync } from './lib/offline/sync'
import { initInstall } from './lib/pwa/install'

// Auto-updating service worker (offline shell + image/API caching).
registerSW({ immediate: true })
// Offline sync reconciler + PWA install detection.
initSync()
initInstall()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
)
