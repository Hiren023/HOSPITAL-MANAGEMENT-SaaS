import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { App } from './App.js'
import './index.css'

/**
 * Application entry point.
 */

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Clinical data must not be shown stale without a clear signal.
      staleTime: 30_000,
      retry: (failureCount, error) => {
        // Never retry a client error: it will fail identically every time, and
        // retrying wastes quota on a rate-limited endpoint.
        const status = (error as { status?: number }).status
        if (typeof status === 'number' && status >= 400 && status < 500) return false
        return failureCount < 2
      },
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
})

const container = document.getElementById('root')

if (!container) {
  throw new Error('Root container #root was not found in index.html')
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)