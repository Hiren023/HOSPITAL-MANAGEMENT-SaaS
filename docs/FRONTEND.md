# Frontend architecture

How the web client is put together, and why. Read alongside `../AUTH.md` (server session
design) and `../ARCHITECTURE.md`.

---

## 1. The one rule that shapes everything

**The interface never decides who may see data. It only decides who is offered a control.**

Every permission decision in the client is presentation. The API re-derives the caller's
tenant and permissions from the token it issued and signed itself, and applies them to
every query (`SECURITY.md` R11). A user who edits the JavaScript to reveal a hidden menu
item gets a screen that renders — and 403s on every request behind it.

This is why the client has both a *navigation* filter and *route guards*, rather than one
or the other:

| Mechanism | Answers | If bypassed |
| --- | --- | --- |
| `navigationFor()` | "Which links should I show?" | A menu link appears that 403s |
| `RequirePermission` | "Should this route render?" | An empty shell renders |
| API middleware | "Is this request allowed?" | **Nothing. This is the boundary.** |

A menu offering a guaranteed-403 link is still a defect, because it tells a receptionist
the product believes they may read clinical notes. They may not.

---

## 2. Session handling

```
Page load
   │
   ├─ POST /auth/refresh   ← HttpOnly cookie the browser sends automatically
   │      200 → access token (10 min) held in memory
   │      401 → anonymous; render sign-in
   │
   ├─ access token ──► module-level variable in auth/token-store.ts
   │                   NOT localStorage, NOT sessionStorage, NOT a cookie
   │
   └─ Sign out → POST /auth/logout → server revokes the whole token family
```

**Why the access token is never persisted.** `localStorage` is readable by any script on
the page. One XSS bug there becomes full account takeover for the token's lifetime, which
is why it is held in a module variable that JavaScript in another bundle cannot reach
(`SECURITY.md` R6).

**Why that still survives a reload.** The durable credential is the refresh cookie, which
is `HttpOnly` — the browser attaches it and page scripts cannot read it. A reload
re-exchanges it for a fresh access token, so persistence is bought without exposing
anything.

**Three states, not two.** `restoring` exists because the exchange is asynchronous. If
there were only `authenticated` and `anonymous`, a reload would flash the sign-in screen
at someone who is already signed in and race their real sign-in. Every guard waits for
`restoring` to settle instead of redirecting immediately.

---

## 3. Layout

```
src/
├── auth/
│   ├── token-store.ts     In-memory access token. Nothing durable.
│   ├── session.ts         Typed API calls + permission predicates
│   ├── auth-context.tsx   AuthProvider: status, user, signIn, signOut
│   └── guards.tsx         RequireAuth / RequirePermission / RequirePlatform / RequireTenantScope
├── navigation/
│   └── navigation.ts      Role → menu, derived from PERMISSIONS
├── components/
│   ├── layout/            AppShell, Sidebar, Header, Breadcrumbs, BrandMark, PublicLayout
│   ├── ui/                Button, FormField, Input, Select, Textarea, Card, Badge,
│   │                      DataTable, SearchInput, Pagination, Modal, ConfirmDialog, Alert
│   └── states/            LoadingState, EmptyState, ErrorState
├── features/
│   ├── landing/           Public marketing page
│   ├── auth/              Login, hospital registration
│   ├── platform/          SUPER_ADMIN dashboard
│   └── dashboard/         Role-aware hospital dashboard
└── test/harness.tsx       fetch mock + provider wrapper
```

### Responsive strategy

| Viewport | Navigation | Rationale |
| --- | --- | --- |
| ≥ 1024px | Fixed sidebar | Persistent orientation; content scrolls independently |
| < 1024px | Overlay drawer | A 16rem rail beside a 20rem phone leaves no room for content |

The drawer is only **mounted** while open, so its links are never invisible-but-focusable
tab stops on desktop — the usual bug with off-canvas menus.

---

## 4. Design system

Tokens live in `src/index.css` under Tailwind's `@theme`.

**Palette: navy, blue, white.** A single blue accent (`--color-brand-*`) for actions,
links and focus. Navy (`--color-navy-*`) for the sidebar, headings and dark surfaces.

**Status colours are reserved.** Green means approved, red means suspended, amber means
pending — and never anything else. A red chip that once meant "popular link" teaches
users to ignore red chips, which is how someone misses a suspended tenant.

**Every status badge carries its own text.** Colour is never the sole signal. Roughly one
in twelve men has a red–green colour vision deficiency, which is precisely the
population most likely to be reading a triage board.

**Contrast.** Body text is `--color-ink` on white (≈ 13:1). Muted text is ≥ 4.5:1.
Status badge foregrounds are darkened from the base hue specifically to reach AA — the
raw token colours do not pass on their tinted backgrounds.

> The automated `axe-core` suite runs on every screen, but its `color-contrast` rule is
> disabled: jsdom performs no layout and cannot compute rendered colours. Contrast is
> verified by token review and by a real-browser pass in Phase 8, not claimed here.

---

## 5. Accessibility decisions worth knowing

| Decision | Why |
| --- | --- |
| Focus the **dialog container**, not a control inside it | The screen reader announces title and description on arrival. Focusing the first control would drop a keyboard user onto a confirmation dialog's **confirm** button, where a reflexive Enter performs an irreversible action. |
| Modal traps Tab and restores focus to the trigger | Otherwise focus falls to `<body>` and a keyboard user loses their place entirely. |
| Skip link on every layout | A marketing page is exactly where a keyboard user arrives from a search and wants the sign-in link. |
| `<caption>` on every table, `scope="col"` on headers | The caption is announced first; `scope` makes navigation say "Appointments, column 3 of 6". |
| Table scroll container has `tabindex="0"` | A table clipped by a phone viewport is otherwise content nobody can scroll. |
| `role="alert"` for failures, `role="status"` for neutral | Interrupting a screen reader to announce a save succeeded is hostile. |
| Form errors carry `role="alert"` and are wired via `aria-describedby` | A red border tells a sighted user something is wrong; only this tells a screen-reader user *what*. |
| Focus moves to the first invalid field on submit | Otherwise submission silently does nothing for a keyboard user. |
| Native `<select>` rather than a custom listbox | On a phone the native picker is faster and correctly accessible; on desktop it inherits keyboard behaviour for free. |
| FAQ uses `<details>`/`<summary>` | Real disclosure semantics with no JavaScript. |

**Dark mode is deliberately not present.** Colour is load-bearing for status here, and a
half-implemented dark palette risks a status colour landing at the wrong contrast. It is a
Phase 7 decision, not an oversight.

---

## 6. Data fetching

TanStack Query for server state. Defaults:

- `retry` is disabled for any 4xx — it will fail identically every time, and retrying
  wastes quota on a rate-limited endpoint;
- `staleTime` 30s, because clinical data must not be shown stale without a signal.

`fetch` is mocked **in tests**, not the API client module, so the envelope parser, header
attachment, error mapping and credential handling all execute for real
(`test/harness.tsx`).

> `ApiClient` resolves `globalThis.fetch` per request rather than capturing it in the
> constructor. Capturing it at construction made the client impossible to substitute at
> all, and silently ignored any later interception.

---

## 7. What is deliberately not built yet

Clinical modules (patients, appointments, consultations, billing…) route to
`ModulePlaceholder`, which states plainly that the module is not available and has no
backend.

They are **not** filled with sample patient records. Fabricated clinical data in a
production-shaped UI is dangerous in a specific way: during a demo or a drill someone
could mistake a fake patient count for a live one, and it conceals the fact that the
endpoint does not exist. The same reasoning applies to the demo-request form, which opens
the visitor's own mail client and says so, rather than posting to an endpoint that does
not exist and reporting a success that never happened.

`LandingPage.test.tsx` asserts that no link on the marketing page points at an
unimplemented route, so a dead control cannot be introduced quietly.