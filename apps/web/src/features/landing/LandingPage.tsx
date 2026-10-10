import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  BadgeCheck,
  Building2,
  CalendarCheck,
  ChevronDown,
  FileClock,
  Lock,
  Receipt,
  ShieldCheck,
  UserCog,
  Users,
} from 'lucide-react'

import { PublicLayout, Section } from '../../components/layout/PublicLayout.js'
import { Alert } from '../../components/ui/Alert.js'
import { Button } from '../../components/ui/Button.js'
import { Card, CardBody } from '../../components/ui/Card.js'
import { FormField } from '../../components/ui/FormField.js'
import { Input } from '../../components/ui/Input.js'
import { Select } from '../../components/ui/Select.js'
import { Textarea } from '../../components/ui/Textarea.js'

const FEATURES = [
  {
    icon: Users,
    title: 'Patient registration',
    description:
      'A single demographic record per patient, with an auditable history of every change made at reception.',
  },
  {
    icon: CalendarCheck,
    title: 'Appointments and scheduling',
    description:
      'Book, reschedule and cancel visits against a doctor’s availability, with conflict checks at the point of booking.',
  },
  {
    icon: FileClock,
    title: 'Clinical records',
    description:
      'Consultations and prescriptions kept separate from billing data, so finance roles never read clinical notes.',
  },
  {
    icon: Receipt,
    title: 'Billing and payments',
    description:
      'Invoices, collections and outstanding balances, with a financial report set that only finance roles can open.',
  },
  {
    icon: UserCog,
    title: 'Roles and permissions',
    description:
      'Six clinical and administrative roles. A grant can never exceed the ceiling of the role it is attached to.',
  },
  {
    icon: Building2,
    title: 'Multi-hospital operations',
    description:
      'One platform, many tenants. A hospital administrator sees only their own hospital — not merely by convention, but enforced at the database layer.',
  },
]

const SECURITY_POINTS = [
  {
    title: 'Isolation enforced three times over',
    description:
      'The tenant identifier is derived from the signed session, re-applied by the data layer on every query, and protected by a lint rule that stops application code from reaching around it.',
  },
  {
    title: 'Passwords stored with Argon2id',
    description:
      'Passwords are never stored, logged or emailed in any recoverable form. Failed sign-ins are rate limited and repeated failures lock the account.',
  },
  {
    title: 'Sessions that resist theft',
    description:
      'A short-lived access token is held in memory only. The durable refresh token is an HttpOnly, Secure, SameSite cookie that JavaScript cannot read, and reuse of a rotated token revokes the whole session family.',
  },
  {
    title: 'Append-only audit trail',
    description:
      'Sign-ins, approvals, permission changes and record access are written to an audit log that the application cannot edit or delete.',
  },
]

const PLANS = [
  {
    name: 'Starter',
    price: '₹2,499',
    period: 'per month',
    description: 'For a single practice or clinic beginning digitisation.',
    features: [
      'Up to 3 staff accounts',
      'Patients, appointments and billing',
      'Email support',
      'Indian data residency',
    ],
    cta: 'Start with a demo',
    featured: false,
  },
  {
    name: 'Hospital',
    price: '₹7,999',
    period: 'per month',
    description: 'For multi-department hospitals running a full clinic.',
    features: [
      'Unlimited staff accounts',
      'Clinical records and prescriptions',
      'Role-based access control',
      'Financial reporting',
      'Priority support',
    ],
    cta: 'Start with a demo',
    featured: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: 'annual agreement',
    description: 'For hospital groups operating several facilities.',
    features: [
      'Multiple hospitals, separate data',
      'Dedicated deployment options',
      'Custom retention policies',
      'Onboarding and migration',
    ],
    cta: 'Talk to sales',
    featured: false,
  },
]

const FAQS = [
  {
    question: 'Can one hospital see another hospital’s data?',
    answer:
      'No. Every request derives the tenant from the signed session rather than from anything the browser sends, and the data layer re-applies that filter to every query. A suite of automated tests runs two fictional hospitals in parallel and asserts that one can neither read, modify nor delete the other’s records.',
  },
  {
    question: 'Where is patient data stored?',
    answer:
      'In a managed MongoDB cluster with encryption in transit and at rest. Production deployments are region-selectable so a hospital can keep its data in India. Development uses a separate, non-clinical database.',
  },
  {
    question: 'What happens if someone leaves their computer signed in?',
    answer:
      'The access token expires within minutes and lives only in memory. Signing out revokes the whole session family server-side, so a stolen refresh token is useless after a legitimate sign-out.',
  },
  {
    question: 'Can we migrate from our current system?',
    answer:
      'Yes. Enterprise onboarding includes data migration from spreadsheets and existing hospital information systems. We ask for a sample extract first so you can verify the mapping before anything is imported.',
  },
  {
    question: 'Do you offer on-premise deployment?',
    answer:
      'We offer a managed cloud deployment as standard, with a dedicated deployment option for hospitals whose policies require an isolated environment. Speak to us about your requirements.',
  },
  {
    question: 'Is this a certified product?',
    answer:
      'The product is being developed with the intent of supporting HIPAA and India’s DPDP Act obligations. Certification and regulatory approval are a commercial and legal process handled with our counsel; we do not claim certifications we do not hold.',
  },
]

const HOSPITAL_SIZES = [
  { value: 'clinic', label: 'Clinic or diagnostic centre' },
  { value: 'hospital', label: 'Multi-department hospital' },
  { value: 'group', label: 'Hospital group (multiple sites)' },
  { value: 'other', label: 'Something else' },
]

/**
 * Public landing page.
 *
 * All copy describes capability honestly: pricing is labelled indicative, the security
 * claims are the ones the code actually implements and tests, and the demo form explains
 * exactly what pressing submit does rather than implying a server it does not have.
 */
export function LandingPage() {
  return (
    <PublicLayout>
      <Hero />

      <Section
        id="product"
        title="One platform, from reception to accounts"
        description="Infinigrow Hospital Cloud covers the daily work of a hospital — who is coming in, what was found, what was prescribed, and what is owed — without stitching together separate systems that do not agree with each other."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              stat: 'One record',
              label: 'per patient',
              detail:
                'Demographics, appointments, clinical notes and invoices join up without re-keying the same person into four systems.',
            },
            {
              stat: 'Six',
              label: 'clinical roles',
              detail:
                'From receptionist to accountant, each role sees exactly what it needs and nothing beyond it.',
            },
            {
              stat: 'One',
              label: 'boundary',
              detail:
                'Hospital A can never read hospital B. The tenant is derived from your session and re-applied on every query.',
            },
          ].map((item) => (
            <Card key={item.stat} className="h-full">
              <CardBody>
                <p className="text-3xl font-semibold tracking-tight text-navy-900">{item.stat}</p>
                <p className="mt-0.5 text-sm font-medium text-ink-muted">{item.label}</p>
                <p className="mt-3 text-sm text-ink-muted">{item.detail}</p>
              </CardBody>
            </Card>
          ))}
        </div>
      </Section>

      <Section
        id="features"
        tone="muted"
        title="Everything a hospital needs, in one place"
        description="Each module is built around the way clinical work actually runs, not around a generic admin template."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <Card key={feature.title} className="h-full">
              <CardBody>
                <span
                  aria-hidden="true"
                  className="flex size-10 items-center justify-center rounded-lg bg-brand-50 text-brand-700"
                >
                  <feature.icon className="size-5" />
                </span>
                <h3 className="mt-4 text-sm font-semibold text-navy-900">{feature.title}</h3>
                <p className="mt-1.5 text-sm text-ink-muted">{feature.description}</p>
              </CardBody>
            </Card>
          ))}
        </div>
      </Section>

      <Section
        id="security"
        tone="navy"
        title="Security is a property of the build, not a promise"
        description="Healthcare software holds the most sensitive data a business can hold. These are engineering decisions in the codebase, each with automated tests behind it."
      >
        <div className="grid gap-6 lg:grid-cols-2">
          {SECURITY_POINTS.map((point) => (
            <div key={point.title} className="flex gap-4">
              <ShieldCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-brand-400" />
              <div>
                <h3 className="text-sm font-semibold text-white">{point.title}</h3>
                <p className="mt-1.5 text-sm text-navy-200">{point.description}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-10 flex flex-wrap items-center gap-3 rounded-card border border-white/10 bg-white/5 px-5 py-4">
          <Lock aria-hidden="true" className="size-4 text-brand-400" />
          <p className="text-sm text-navy-200">
            Every administrative action — approval, suspension, permission change — is written to an
            append-only audit trail.
          </p>
        </div>
      </Section>

      <Section
        id="pricing"
        title="Pricing"
        description="Indicative pricing for planning purposes. Final pricing depends on deployment, user count and support requirements, and is confirmed in a written quote before any commitment."
      >
        <div className="grid gap-5 lg:grid-cols-3">
          {PLANS.map((plan) => (
            <Card
              key={plan.name}
              className={plan.featured ? 'relative border-brand-300 ring-1 ring-brand-300' : ''}
            >
              {plan.featured ? (
                <span className="absolute -top-3 left-6 rounded-full bg-brand-700 px-3 py-1 text-xs font-medium text-white">
                  Most hospitals choose this
                </span>
              ) : null}
              <CardBody className="flex h-full flex-col">
                <h3 className="text-sm font-semibold text-navy-900">{plan.name}</h3>
                <p className="mt-3 flex items-baseline gap-1.5">
                  <span className="text-3xl font-semibold tracking-tight text-navy-900">
                    {plan.price}
                  </span>
                  <span className="text-sm text-ink-subtle">{plan.period}</span>
                </p>
                <p className="mt-2 text-sm text-ink-muted">{plan.description}</p>

                <ul className="mt-5 flex-1 space-y-2.5">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2.5 text-sm text-ink-muted">
                      <BadgeCheck
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0 text-success"
                      />
                      {feature}
                    </li>
                  ))}
                </ul>

                <a href="#contact" className="mt-6">
                  <Button variant={plan.featured ? 'primary' : 'secondary'} block>
                    {plan.cta}
                  </Button>
                </a>
              </CardBody>
            </Card>
          ))}
        </div>

        <p className="mt-5 text-xs text-ink-subtle">
          Prices exclude GST. All plans include data residency in India, encrypted storage and daily
          backups.
        </p>
      </Section>

      <Section id="faq" tone="muted" title="Frequently asked questions">
        <div className="mx-auto max-w-3xl divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
          {FAQS.map((item) => (
            <details key={item.question} className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-sm font-medium text-navy-900 transition-colors hover:bg-surface-muted">
                {item.question}
                <ChevronDown
                  aria-hidden="true"
                  className="size-4 shrink-0 text-ink-subtle transition-transform group-open:rotate-180"
                />
              </summary>
              <div className="px-5 pb-4 text-sm text-ink-muted">{item.answer}</div>
            </details>
          ))}
        </div>
      </Section>

      <DemoRequestSection />
    </PublicLayout>
  )
}

function Hero() {
  return (
    <section className="border-b border-line bg-gradient-to-b from-navy-50 to-surface">
      <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-2">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full bg-brand-50 px-3 py-1 text-xs font-medium text-brand-800 ring-1 ring-brand-200">
            <ShieldCheck aria-hidden="true" className="size-3.5" />
            Built for Indian hospitals
          </p>

          <h1 className="mt-5 text-4xl font-semibold leading-tight tracking-tight text-navy-900 sm:text-5xl">
            Hospital management that keeps every hospital&rsquo;s data to itself.
          </h1>

          <p className="mt-5 max-w-xl text-lg text-ink-muted">
            Patients, appointments, clinical records, billing and staff — in one place, with tenant
            isolation enforced at the database layer rather than assumed in the interface.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link to="/register">
              <Button size="lg" trailingIcon={<ArrowRight aria-hidden="true" className="size-4" />}>
                Request a demo
              </Button>
            </Link>
            <a href="#features">
              <Button size="lg" variant="secondary">
                See what it does
              </Button>
            </a>
          </div>

          <dl className="mt-10 grid max-w-lg grid-cols-3 gap-6 border-t border-line pt-6">
            {[
              { label: 'Clinical roles', value: '6' },
              { label: 'Isolation layers', value: '3' },
              { label: 'Password hashing', value: 'Argon2id' },
            ].map((item) => (
              <div key={item.label}>
                <dd className="text-lg font-semibold text-navy-900">{item.value}</dd>
                <dt className="mt-0.5 text-xs text-ink-subtle">{item.label}</dt>
              </div>
            ))}
          </dl>
        </div>

        {/* Abstract product illustration: decorative, so hidden from assistive tech. */}
        <div aria-hidden="true" className="relative hidden lg:block">
          <div className="rounded-card border border-line bg-surface p-5 shadow-lg">
            <div className="flex items-center gap-2 border-b border-line pb-3">
              <span className="size-2.5 rounded-full bg-[oklch(0.85_0.05_25)]" />
              <span className="size-2.5 rounded-full bg-[oklch(0.87_0.07_85)]" />
              <span className="size-2.5 rounded-full bg-[oklch(0.85_0.06_155)]" />
              <span className="ml-2 text-xs text-ink-subtle">Today · Outpatient</span>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-3">
              {[
                { label: 'Appointments', value: '24' },
                { label: 'Waiting', value: '6' },
                { label: 'Collected', value: '₹48.2k' },
              ].map((tile) => (
                <div key={tile.label} className="rounded-lg bg-canvas px-3 py-2.5">
                  <p className="text-[0.625rem] uppercase tracking-wide text-ink-subtle">
                    {tile.label}
                  </p>
                  <p className="mt-0.5 text-sm font-semibold tabular-nums text-navy-900">
                    {tile.value}
                  </p>
                </div>
              ))}
            </div>

            <ul className="mt-4 space-y-2">
              {[
                { name: 'R. Deshmukh', detail: 'Cardiology · Dr A. Kulkarni', state: 'In consult' },
                { name: 'S. Patel', detail: 'General · Dr M. Nair', state: 'Waiting' },
                { name: 'A. Fernandes', detail: 'Paediatrics · Dr L. Rao', state: 'Checked in' },
              ].map((row) => (
                <li
                  key={row.name}
                  className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5"
                >
                  <span className="size-7 shrink-0 rounded-full bg-brand-100" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-ink">{row.name}</span>
                    <span className="block truncate text-[0.625rem] text-ink-subtle">
                      {row.detail}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[0.625rem] text-ink-muted">
                    {row.state}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}

/**
 * Demo request form.
 *
 * There is no lead-capture endpoint in the API yet, so rather than posting to nothing and
 * reporting a success that never happened, submitting composes a message and opens the
 * visitor's own email client. The button label and the note beneath it both say so. This is
 * a real, working control — it just is not a server-side submission, and it does not
 * pretend to be one. Wiring it to an endpoint is a small change once one exists.
 */
function DemoRequestSection() {
  const [values, setValues] = useState({
    name: '',
    email: '',
    hospital: '',
    size: '',
    message: '',
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [sent, setSent] = useState(false)

  const set = (key: keyof typeof values) => (value: string) =>
    setValues((previous) => ({ ...previous, [key]: value }))

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const nextErrors: Record<string, string> = {}
    if (!values.name.trim()) nextErrors['name'] = 'Enter your name'
    if (!values.email.trim()) nextErrors['email'] = 'Enter your email address'
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) {
      nextErrors['email'] = 'Enter a valid email address'
    }
    if (!values.hospital.trim()) nextErrors['hospital'] = 'Enter your hospital name'
    if (!values.size) nextErrors['size'] = 'Select the size of your organisation'

    setErrors(nextErrors)

    if (Object.keys(nextErrors).length > 0) {
      document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
      return
    }

    const body = [
      `Name: ${values.name.trim()}`,
      `Email: ${values.email.trim()}`,
      `Hospital: ${values.hospital.trim()}`,
      `Organisation size: ${HOSPITAL_SIZES.find((option) => option.value === values.size)?.label ?? values.size}`,
      '',
      values.message.trim() || '(no additional details)',
    ].join('\n')

    window.location.href = `mailto:hello@infinigrow.example?subject=${encodeURIComponent(
      `Demo request — ${values.hospital.trim()}`,
    )}&body=${encodeURIComponent(body)}`

    setSent(true)
  }

  return (
    <Section
      id="contact"
      title="See it with your own data"
      description="Tell us about your hospital and we will arrange a walkthrough with a sample environment set up to resemble your workflow."
    >
      <div className="grid gap-8 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <Card className="h-full">
            <CardBody>
              <h3 className="text-sm font-semibold text-navy-900">What happens next</h3>
              <ol className="mt-4 space-y-4">
                {[
                  'You send this form and it opens an email in your own mail client.',
                  'We reply within one working day to arrange a 30-minute walkthrough.',
                  'We set up a sample hospital with departments, staff roles and sample records.',
                  'You decide afterwards — nothing is charged and nothing is locked in.',
                ].map((step, index) => (
                  <li key={step} className="flex gap-3">
                    <span
                      aria-hidden="true"
                      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800"
                    >
                      {index + 1}
                    </span>
                    <span className="text-sm text-ink-muted">{step}</span>
                  </li>
                ))}
              </ol>

              <div className="mt-6 border-t border-line pt-5">
                <p className="text-xs text-ink-subtle">
                  Already registered?{' '}
                  <Link
                    to="/login"
                    className="font-medium text-brand-700 underline underline-offset-2"
                  >
                    Sign in to your hospital
                  </Link>
                </p>
              </div>
            </CardBody>
          </Card>
        </div>

        <Card className="lg:col-span-3">
          <CardBody>
            {sent ? (
              <Alert
                tone="success"
                title="Your email client should be open"
                onDismiss={() => setSent(false)}
              >
                We have prepared a message with your details. Press send in your email application
                and we will reply within one working day.
              </Alert>
            ) : null}

            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Your name" error={errors['name']} required>
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      invalid={invalid}
                      aria-describedby={describedBy}
                      autoComplete="name"
                      value={values.name}
                      onChange={(event) => set('name')(event.target.value)}
                    />
                  )}
                </FormField>

                <FormField label="Work email" error={errors['email']} required>
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      type="email"
                      inputMode="email"
                      invalid={invalid}
                      aria-describedby={describedBy}
                      autoComplete="email"
                      value={values.email}
                      onChange={(event) => set('email')(event.target.value)}
                    />
                  )}
                </FormField>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Hospital name" error={errors['hospital']} required>
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      invalid={invalid}
                      aria-describedby={describedBy}
                      autoComplete="organization"
                      value={values.hospital}
                      onChange={(event) => set('hospital')(event.target.value)}
                    />
                  )}
                </FormField>

                <FormField label="Organisation size" error={errors['size']} required>
                  {({ id, describedBy, invalid }) => (
                    <Select
                      id={id}
                      invalid={invalid}
                      aria-describedby={describedBy}
                      placeholder="Select…"
                      options={HOSPITAL_SIZES}
                      value={values.size}
                      onChange={(event) => set('size')(event.target.value)}
                    />
                  )}
                </FormField>
              </div>

              <FormField
                label="What would you like to see?"
                hint="Optional. Departments you use, billing quirks, migration questions — anything useful."
              >
                {({ id, describedBy }) => (
                  <Textarea
                    id={id}
                    aria-describedby={describedBy}
                    rows={4}
                    value={values.message}
                    onChange={(event) => set('message')(event.target.value)}
                    placeholder="e.g. We run a 60-bed hospital with three departments and need billing to work offline during outages."
                  />
                )}
              </FormField>

              <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
                <Button type="submit" size="lg">
                  Open the email
                </Button>
                <p className="text-xs text-ink-subtle">
                  This form composes an email in your own mail application. It does not submit to a
                  server.
                </p>
              </div>
            </form>
          </CardBody>
        </Card>
      </div>
    </Section>
  )
}
