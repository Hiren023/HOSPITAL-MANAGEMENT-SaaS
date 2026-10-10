import { Activity, CalendarDays, ClipboardList, CreditCard, FileText, ShieldCheck, Stethoscope, Users } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * Public landing page.
 *
 * Two constraints shaped this page:
 *  - No dead controls (docs/PROJECT_PROPOSAL.md rule 16). Every link is an in-page
 *    anchor or a real route. Sign-in is deliberately absent until Phase 1 delivers it,
 *    rather than shipping a button that leads to an unimplemented page.
 *  - Honest status. Each module is labelled with its real delivery status, so nobody
 *    mistakes a planned capability for a working one.
 */

interface ModuleCard {
  icon: ReactNode
  title: string
  description: string
  status: 'Available now' | 'In development' | 'Planned'
}

const MODULES: ModuleCard[] = [
  {
    icon: <Stethoscope aria-hidden="true" className="size-5" />,
    title: 'Multi-tenant isolation',
    description:
      'Every hospital is a separate tenant with enforced data boundaries. Tenant scope is resolved on the server and can never be supplied by the browser.',
    status: 'Available now',
  },
  {
    icon: <Users aria-hidden="true" className="size-5" />,
    title: 'Departments, doctors & staff',
    description:
      'Model your hospital structure, invite staff, and assign roles with least-privilege permissions.',
    status: 'In development',
  },
  {
    icon: <ClipboardList aria-hidden="true" className="size-5" />,
    title: 'Patients & appointments',
    description:
      'Patient registration with unique hospital identifiers, search, and conflict-free scheduling.',
    status: 'In development',
  },
  {
    icon: <Activity aria-hidden="true" className="size-5" />,
    title: 'Consultations & prescriptions',
    description:
      'Clinical notes with draft and final states, plus printable prescriptions generated as PDFs.',
    status: 'Planned',
  },
  {
    icon: <CalendarDays aria-hidden="true" className="size-5" />,
    title: 'Staff attendance',
    description: 'Daily check-in and check-out with monthly review and approval.',
    status: 'Planned',
  },
  {
    icon: <CreditCard aria-hidden="true" className="size-5" />,
    title: 'Billing & payments',
    description: 'Invoices, discounts, tax, receipts, and outstanding balance tracking.',
    status: 'Planned',
  },
  {
    icon: <FileText aria-hidden="true" className="size-5" />,
    title: 'Reports & audit logs',
    description: 'Operational reporting plus an append-only trail of who accessed which record.',
    status: 'Planned',
  },
  {
    icon: <ShieldCheck aria-hidden="true" className="size-5" />,
    title: 'Privacy by design',
    description:
      'Least privilege, encryption in transit and at rest, full audit trails, and protected health information kept out of application logs.',
    status: 'Available now',
  },
]

const STATUS_STYLES: Record<ModuleCard['status'], string> = {
  'Available now': 'bg-brand-100 text-brand-800 ring-brand-300',
  'In development': 'bg-status-warning/10 text-status-warning ring-status-warning/40',
  Planned: 'bg-slate-100 text-slate-600 ring-slate-300',
}

export function LandingPage() {
  return (
    <div className="min-h-screen bg-white">
      <a href="#main" className="skip-link">
        Skip to main content
      </a>

      <header className="sticky top-0 z-40 border-b border-border-subtle bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-6">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="grid size-9 place-items-center rounded-lg bg-brand-700 font-bold text-white"
            >
              IG
            </span>
            <div className="leading-tight">
              <p className="text-sm font-semibold text-slate-900">Infinigrow Hospital Cloud</p>
              <p className="text-xs text-slate-500">Infinigrow Softech</p>
            </div>
          </div>

          <nav aria-label="Page sections">
            <ul className="flex items-center gap-6 text-sm font-medium text-slate-600">
              <li>
                <a className="rounded hover:text-brand-700" href="#modules">
                  Modules
                </a>
              </li>
              <li>
                <a className="rounded hover:text-brand-700" href="#security">
                  Security
                </a>
              </li>
              <li>
                <a className="rounded hover:text-brand-700" href="#about">
                  About
                </a>
              </li>
            </ul>
          </nav>
        </div>
      </header>

      <main id="main">
        {/* Hero */}
        <section className="border-b border-border-subtle bg-gradient-to-b from-brand-50 to-white">
          <div className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
            <p className="inline-flex items-center rounded-full bg-brand-100 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-brand-800">
              Cloud hospital management
            </p>

            <h1 className="mt-5 max-w-3xl text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
              Run your hospital on infrastructure built for care, not for guesswork.
            </h1>

            <p className="mt-5 max-w-2xl text-lg leading-relaxed text-slate-600">
              Infinigrow Hospital Cloud is a multi-tenant platform for clinics, small hospitals and
              large multispecialty facilities — with strict tenant isolation, role-based access and a
              complete audit trail from the first record.
            </p>

            <p className="mt-6 text-lg font-medium italic text-brand-800">
              &ldquo;Ideas grow without limits.&rdquo;
            </p>

            <div className="mt-9 flex flex-wrap gap-3">
              <a
                href="#modules"
                className="inline-flex h-11 items-center rounded-lg bg-brand-700 px-6 text-sm font-medium text-white transition-colors hover:bg-brand-800"
              >
                See what&rsquo;s included
              </a>
              <a
                href="#security"
                className="inline-flex h-11 items-center rounded-lg bg-white px-6 text-sm font-medium text-slate-800 ring-1 ring-slate-300 transition-colors hover:bg-slate-50"
              >
                How we protect patient data
              </a>
            </div>

            <p className="mt-4 text-xs text-slate-500">
              This release is the foundation phase. Sign-in and hospital dashboards are delivered in
              the next release; nothing on this page links to an unfinished screen.
            </p>
          </div>
        </section>

        {/* Modules */}
        <section id="modules" className="scroll-mt-20 border-b border-border-subtle">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <h2 className="text-3xl font-bold tracking-tight text-slate-900">What&rsquo;s included</h2>
            <p className="mt-3 max-w-2xl text-base text-slate-600">
              Each capability below is labelled with its real status. We would rather show you an
              honest roadmap than a polished demo of features that do not exist yet.
            </p>

            <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {MODULES.map((module) => (
                <li
                  key={module.title}
                  className="flex flex-col gap-3 rounded-card border border-border-subtle bg-white p-6"
                >
                  <span className="grid size-10 place-items-center rounded-lg bg-brand-50 text-brand-700">
                    {module.icon}
                  </span>

                  <h3 className="text-base font-semibold text-slate-900">{module.title}</h3>

                  <p className="flex-1 text-sm leading-relaxed text-slate-600">
                    {module.description}
                  </p>

                  <span
                    className={`inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${STATUS_STYLES[module.status]}`}
                  >
                    {module.status}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Security */}
        <section id="security" className="scroll-mt-20 border-b border-border-subtle bg-slate-50">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <div className="grid gap-12 lg:grid-cols-2">
              <div>
                <h2 className="text-3xl font-bold tracking-tight text-slate-900">
                  Security is structural, not a policy document
                </h2>
                <p className="mt-4 text-base leading-relaxed text-slate-600">
                  Patient records are among the most sensitive data a hospital holds. Infinigrow
                  Hospital Cloud is designed so that the safe path is the default path.
                </p>
              </div>

              <ul className="space-y-4">
                {[
                  {
                    title: 'Tenant scope is never trusted from the browser',
                    body: 'The hospital a request applies to is resolved from a verified membership on the server. Any hospital identifier sent by a client is ignored and recorded in the audit log.',
                  },
                  {
                    title: 'Least privilege by role',
                    body: 'Front-desk staff cannot read clinical notes. Finance staff cannot read consultations. Permissions are enforced by the API, not by hiding buttons.',
                  },
                  {
                    title: 'Access is recorded',
                    body: 'Every read and write of a patient record produces an append-only audit entry with the actor, time and origin.',
                  },
                  {
                    title: 'Health data stays out of logs',
                    body: 'Structured logging with mandatory redaction of credentials and patient identifiers, verified by automated tests.',
                  },
                ].map((item) => (
                  <li key={item.title} className="flex gap-3">
                    <ShieldCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-brand-700" />
                    <div>
                      <h3 className="text-sm font-semibold text-slate-900">{item.title}</h3>
                      <p className="mt-1 text-sm leading-relaxed text-slate-600">{item.body}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      </main>

      <footer id="about" className="scroll-mt-20">
        <div className="mx-auto max-w-6xl px-6 py-12">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-900">Infinigrow Hospital Cloud</p>
              <p className="mt-1 text-sm text-slate-500">
                A product of Infinigrow Softech &mdash; Ideas grow without limits.
              </p>
            </div>
            <p className="text-xs text-slate-500">
              Designed with reference to the Digital Personal Data Protection framework. Regulatory
              compliance requires qualified legal review.
            </p>
          </div>
        </div>
      </footer>
    </div>
  )
}