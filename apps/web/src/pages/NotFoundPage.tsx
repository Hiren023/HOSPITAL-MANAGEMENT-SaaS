import { Button } from '../components/ui/Button.js'

/**
 * 404 page for unmatched client-side routes.
 */
export function NotFoundPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-5 px-6 text-center">
      <p className="text-sm font-semibold uppercase tracking-widest text-brand-700">Error 404</p>

      <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
        We could not find that page
      </h1>

      <p className="text-base text-slate-600">
        The address may be mistyped, or the page may have moved. Nothing you entered has been shared
        or recorded.
      </p>

      <Button variant="secondary" onClick={() => window.location.assign('/')}>
        Back to home
      </Button>
    </main>
  )
}