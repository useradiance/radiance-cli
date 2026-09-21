# Radiance CLI — end-to-end testing guide

Manual E2E checklist for `radiance-cli` against the local `radiance-templates`
catalogue (Expo SDK 57, registry **0.3.0**, **13 starters / 47+ modules**).

Use a **scratch directory** outside your monorepo so generated apps do not pollute git.
Expect each full pass to take a few hours if you exercise Firebase emulators, native builds,
and the AI harness.

---

## 0. Prerequisites

| Tool           | Requirement                                                       |
| -------------- | ----------------------------------------------------------------- |
| Node           | `>= 22.13`                                                        |
| yarn           | installed globally                                                |
| git            | for template cache / `init --git`                                 |
| firebase-tools | for emulators + `radiance deploy`                                 |
| Expo tooling   | `npx expo` works (dev client for MMKV / RNFirebase / maps / push) |
| LLM (optional) | Anthropic / OpenAI key, or Ollama for `radiance prompt`           |

### Point the CLI at your local catalogue

```bash
# From the Radiance monorepo
cd radiance-cli && yarn build && yarn link   # or: node dist/index.js …

export RADIANCE_TEMPLATES_PATH="/Users/gordan/Documents/GitHub/Radiance/radiance-templates"
# equivalently:
radiance config set templatesPath "/Users/gordan/Documents/GitHub/Radiance/radiance-templates"
```

Confirm:

```bash
radiance -v
radiance doctor
radiance templates list
```

**Pass if:** doctor shows Node/yarn OK; templates list shows **13 starters** and **47+ modules**;
path shows `(local checkout)`.

Scratch root:

```bash
export RADIANCE_E2E="$HOME/tmp/radiance-e2e-$(date +%Y%m%d)"
mkdir -p "$RADIANCE_E2E" && cd "$RADIANCE_E2E"
```

---

## 1. Global CLI surface

### 1.1 Help and version

```bash
radiance --help
radiance -v
radiance init --help
radiance add --help
radiance prompt --help
radiance update --help
radiance upgrade --help
radiance templates --help
radiance config --help
radiance deploy --help
```

**Pass if:** every command listed in help matches: `init`, `add`, `prompt`, `update`,
`upgrade`, `templates` (+ `list` / `outdated` / `prune`), `config` (+ `list` / `get` / `set` / `set-key` / `unset-key`),
`deploy`, `compile`, `doctor`, `explain`.

### 1.2 Config

```bash
radiance config list
radiance config get provider
radiance config set provider ollama
radiance config get provider          # expect ollama
radiance config set provider anthropic
radiance config set maxFixIterations 2
radiance config set verify true
radiance config set gitAutoCommit false
# invalid key / value should fail cleanly:
radiance config set notAKey foo       # expect RadianceError
radiance config set maxFixIterations 99  # expect validation error
# API keys (OS keychain; values never printed by `config list`):
radiance config set-key anthropic 'sk-test-not-real'
radiance config list                  # expect anthropic → keychain
radiance config unset-key anthropic
radiance config set-key ollama        # expect error — ollama needs no key
```

**Keys to verify exist:** `templatesRepo`, `templatesPath`, `templatesChannel`, `provider`,
`model`, `ollamaHost`, `gitAutoCommit`, `verify`, `maxFixIterations`.
Also verify `set-key` / `unset-key` for `anthropic`, `openai`, `cursor`.

### 1.3 Doctor

```bash
radiance doctor
# With missing firebase-tools: expect warn, not fail
# With Node < 22.13: expect fail
# Inside a project (later): expect project checks (radiance.json, features)
```

### 1.4 Templates cache commands

```bash
radiance templates list
radiance templates outdated   # with local checkout: "version checks do not apply"
# Without templatesPath (optional second machine / unset path):
#   radiance update
#   radiance upgrade
#   radiance templates prune
```

**Pass if:** with `templatesPath` set, `outdated` explains local checkout; `list` marks
installed modules with `●` when run inside a project.

---

## 2. `radiance init` matrix

Create each app in `$RADIANCE_E2E`. Prefer `--no-install` first to validate file composition
quickly, then run `yarn` once per “deep” app.

### 2.0 Automated init + typecheck

From `radiance-cli` after `yarn build`, this runs the real `radiance init -y` CLI for the bare
scaffold and every starter, links a Firebase project, installs, typechecks, and leaves the
apps on disk:

```bash
cd radiance-cli
export RADIANCE_TEMPLATES_PATH="/Users/gordan/Documents/GitHub/Radiance/radiance-templates"
firebase login   # once
yarn bootstrap:starters
# a single starter (creates social-app-<timestamp>):
yarn bootstrap:starters -- --starter social-app
# share one existing Firebase project instead:
yarn bootstrap:starters -- --project my-radiance-e2e
yarn bootstrap:starters -- --project my-radiance-e2e --create-project
# subset / custom out / skip cloud:
yarn bootstrap:starters -- --only e-commerce,social-app --out "$RADIANCE_E2E" --clean
yarn bootstrap:starters -- --no-firebase
```

Default output is `$HOME/tmp/radiance-starters` (`summary.json` + `logs/` plus one folder per
target). Without `--project`, each app gets its own Firebase project named `<starter>-<timestamp>`.
Free plan (default) uses cloud Auth/Firestore and emulators for Storage/Functions. Re-run with
`--force` to re-init an existing folder. This does **not** replace the manual overlay checks below.

### 2.1 Bare scaffold

```bash
cd "$RADIANCE_E2E"
radiance init bare-app --scaffold -y --no-install
```

**Assert:**

- [ ] Directory created; `radiance.json` present
- [ ] Required modules applied: `i18n`, `theme`, `navigation`
- [ ] Scaffold files: `lib/platform.ts`, `lib/logger.ts`, `lib/events.ts`, `lib/env.ts`,
  ```
  `eas.json`, `jest.config.js`, `.firebaserc` with `staging` / `prod`
  ```
- [ ] No starter overlay screens (no feed / cart / projects)
- [ ] `--no-git` / `--no-install` / `--no-firebase` respected when passed
- [ ] Without `-y` / `--no-firebase`, init offers Firebase setup (can decline)

### 2.2 Each starter

```bash
radiance init shop -t e-commerce -y --no-install
radiance init social -t social-app -y --no-install
radiance init tasks -t productivity -y --no-install
```

| Starter        | Must include modules                                                                            | Theme default | Spot-check overlay            |
| -------------- | ----------------------------------------------------------------------------------------------- | ------------- | ----------------------------- |
| `e-commerce`   | firestore, forms, auth, storage, analytics, hosting, callable-client, **functions**, **stripe** | contrast      | catalogue, cart, **checkout** |
| `social-app`   | firestore, forms, auth, storage, callable-client, functions, analytics, hosting                 | branded       | feed / posts / profile        |
| `productivity` | firestore, forms, auth, callable-client, functions, hosting                                     | neutral       | projects / tasks              |

**Assert per starter:**

- [ ] `radiance.json` → `features[]` matches starter modules (+ required foundation)
- [ ] `RADIANCE.md` capabilities block filled
- [ ] Markers intact (`radiance:*:start/end`)
- [ ] `yarn` (when installed) + `yarn typecheck` succeeds (may need env stubs — see §8)

For a full 12-starter + scaffold init/install/typecheck pass, use §2.0 instead of repeating
`radiance init` by hand. Keep this table for overlay spot-checks.

### 2.3 Init options

```bash
radiance init themed -t social-app --theme-pack contrast --locale en \
  --bundle-id com.example.themed \
  --option providers=email,anonymous \
  --option enforceEmailVerification=true \
  --option shell=tabs \
  -y --no-install

radiance init drawer-app -t productivity --option shell=drawer -y --no-install
radiance init stack-app --scaffold --option shell=stack -y --no-install
```

**Assert:**

- [ ] `app.config` / `radiance.json` reflect bundle id / scheme / theme pack
- [ ] Auth config placeholders resolved (`authProviders`, anonymous, enforce flag)
- [ ] Navigation shell files match option (`(tabs)` vs drawer vs stack routes)
- [ ] Rejects non-empty existing directory
- [ ] Interactive starter pick works when `-t` omitted and `-y` not set
- [ ] Interactive opening asks to describe the app; blank falls back to starter browse

### 2.4 Init from `--prompt` (NL interview)

LLM optional — without keys/Ollama the CLI falls back to starter/option heuristics, then asks
for anything still missing (unless `-y`).

```bash
# Non-interactive: extract + autofill defaults (name required)
radiance init shop-ai --prompt "online store with Stripe, drawer nav, Google auth" \
  -y --pm npm --no-install --no-firebase

# Interactive interview (omit -y): expect follow-up questions for any unset required slots
# radiance init --prompt "a productivity app for team tasks"
```

**Assert:**

- [ ] `-y --prompt` picks `e-commerce` (or documents heuristic fallback) and writes files
- [ ] `radiance.json` / options reflect extracted shell / providers when heuristics or LLM fill them
- [ ] Without `-y`, CLI asks until name, starter, theme, locale, pm, and conditional options are set
- [ ] Explicit flags win over extracted values (`-t productivity --prompt "shop with stripe"` stays productivity)
- [ ] Missing name with `-y --prompt` errors clearly
- [ ] `--provider` / `--model` accepted on init

---

## 3. `radiance add` — every module

Use a dedicated app and add modules in dependency-friendly waves. Dry-run first.

```bash
cd "$RADIANCE_E2E"
radiance init modular --scaffold -y
cd modular
yarn   # once
```

### 3.1 Flags

```bash
radiance add maps --dry-run
radiance add maps -y
radiance add maps          # expect "Already installed"
radiance add maps --force -y
```

**Pass if:** dry-run writes nothing; second add no-ops; `--force` reapplies.

### 3.2 Module install matrix

Install each module at least once (alone or as implied dep). Check `radiance.json`,
`package.json` merges, providers in `lib/registry/providers.tsx`, and any Firebase fragments.

| Module               | Command / options                                                                        | Smoke checks                                     |
| -------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `i18n`               | (required)                                                                               | `t('…')` works; locales merge                    |
| `theme`              | `--option pack=branded` / `--pack contrast`                                              | tokens, `useResponsive`, MMKV dep                |
| `navigation`         | `--option shell=tabs                                                                     | drawer                                           |
| `forms`              | `radiance add forms -y`                                                                  | RHF+Zod in package.json; FormField               |
| `firestore`          | default; then `--force --option nativePersistence=rnfirebase`                            | hooks + SyncBanner; RNFirebase deps on option    |
| `auth`               | `--option providers=email,google,apple,anonymous --option enforceEmailVerification=true` | screens RHF; deleteAccount wiring; session       |
| `callable-client`    | (often implied by auth)                                                                  | `call()`, contracts markers                      |
| `storage`            | after auth                                                                               | upload helpers; `useStorageUrl`                  |
| `functions`          | `radiance add functions -y`                                                              | `functions/` yarn project; ping + cleanup sample |
| `deep-linking`       | `radiance add deep-linking -y`                                                           | DeepLinkProvider wired                           |
| `maps`               | `radiance add maps -y`                                                                   | MapView + `.web.tsx`; expo-location `~57`        |
| `stripe`             | needs functions + callable-client                                                        | createCheckoutSession + webhook files            |
| `hosting`            | `radiance add hosting -y`                                                                | firebase hosting config + scripts                |
| `push-notifications` | after auth                                                                               | sendPush self-only; FCM helper; plugin marker    |
| `analytics`          | `radiance add analytics -y`                                                              | web + `.native.ts`; RNFirebase ^26               |
| `app-check`          | `radiance add app-check -y`                                                              | web + `.native.tsx`                              |
| `crashlytics`        | `radiance add crashlytics -y`                                                            | RNFirebase plugins; ErrorBoundary                |

**Also assert:**

- [ ] Dependency order: adding `auth` pulls `forms`, `callable-client`, etc.
- [ ] Settings markers get `AccountSettingsSection` on both
  ```
  `app/(app)/(tabs)/settings.tsx`, `app/(app)/(drawer)/settings.tsx`, and `app/(app)/settings.tsx` when present
  ```
- [ ] Functions markers export `deleteAccount` / `sendPushToUser` / stripe when modules added
- [ ] `.env.example` gains module env keys
- [ ] User-owned edits outside markers survive `--force` where designed

### 3.3 Option edge cases

```bash
radiance add auth --option providers=email -y --force
radiance add auth --option providers= -y          # expect validation error
radiance add navigation --option shell=drawer -y --force
radiance add firestore --option nativePersistence=rnfirebase -y --force
radiance add theme --option pack=neutral -y --force
```

---

## 4. Generated app quality gates (per major app)

Pick **one** deep app (recommend `e-commerce` init with install) and run:

```bash
cd "$RADIANCE_E2E/shop"   # or modular after adds
radiance setup firebase   # or: cp .env.example .env and fill EXPO_PUBLIC_FIREBASE_*
# Emulators-only: skip setup and see §5

yarn
yarn typecheck
yarn lint                 # if configured
yarn test                 # jest-expo scaffold + module tests that landed in tree
```

**Pass if:** typecheck clean with valid env; tests for platform/env/logger (scaffold) and any
copied module `__tests__` run.

Optional Expo:

```bash
yarn start
# web: press w — sign-in, theme, one domain screen
# iOS/Android simulator: same
# Dev client required for: MMKV, maps native, RNFirebase, push, Crashlytics
```

### 4.1 Catalogue SDK pins and native compile

After catalogue edits that touch `expo-*` packages or native modules:

```bash
# Cheap, Linux-friendly — fails if a module still pins SDK 54-era expo-camera 17, etc.
cd radiance-templates && yarn registry:check && yarn test

# Generate a starter (or one module on the scaffold) and actually compile it.
cd radiance-cli && yarn build
export RADIANCE_TEMPLATES_PATH="/Users/gordan/Documents/GitHub/Radiance/radiance-templates"
radiance compile --starter warehouse
radiance compile --module barcode --platforms web
radiance compile --starter warehouse --platforms web,ios,android
```

Inside an existing app:

```bash
cd "$RADIANCE_E2E/shop"
radiance compile --platforms web
```

**Pass if:** `registry:check` is clean; `radiance compile` finishes `expo install --check`, `tsc`, web export, and (when requested) iOS `xcodebuild` / Android `assembleDebug`.

Notes:

- Compile with `--no-firebase` writes stub `GoogleService-Info.plist` / `google-services.json` so Expo prebuild can copy them. Real files from `radiance setup firebase` are left alone.
- iOS compile needs macOS + Xcode. `--platforms ios` on Linux fails instead of skipping.
- Android compile needs `ANDROID_HOME` or `ANDROID_SDK_ROOT`.
- Default platforms: `web`, plus `ios` on macOS, plus `android` when the SDK is present.
- Do not compile every starter on every `yarn test`. This command is opt-in (and a later CI smoke job for `warehouse` + `saas`).

---

## 5. Firebase / emulator path

```bash
cd "$RADIANCE_E2E/shop"
# .env (free plan / selective emulators):
# EXPO_PUBLIC_USE_FIREBASE_EMULATORS=true
# EXPO_PUBLIC_FIREBASE_EMULATOR_HOST=localhost  # or LAN IP for device
# EXPO_PUBLIC_EMULATOR_AUTH=false
# EXPO_PUBLIC_EMULATOR_FIRESTORE=false
# EXPO_PUBLIC_EMULATOR_FUNCTIONS=true
# EXPO_PUBLIC_EMULATOR_STORAGE=true

yarn start   # boots Storage/Functions emulators + Expo when flags are set
# or keep emulators in a separate terminal:
# yarn emulators
# yarn start:app
```

**Manual flows:**

- [ ] Auth: email sign-up / sign-in / forgot password / guest (if enabled)
- [ ] Email verification banner vs enforce option
- [ ] Firestore list/detail + optimistic write + SyncBanner offline
- [ ] Storage upload + URL cache (`useStorageUrl`)
- [ ] Callable `ping` via `call('ping', {})`
- [ ] `deleteAccount` from settings (Auth user removed in emulator)
- [ ] e-commerce: cart → checkout callable (Stripe secrets may fail without keys — assert error path)
- [ ] Selective emulator: set `EXPO_PUBLIC_EMULATOR_FUNCTIONS=false` and confirm only others connect

---

## 6. Feature-specific deep checks

### 6.1 Navigation shells

Three small apps or `--force` reapply:

| Shell  | Expect                                                                                    |
| ------ | ----------------------------------------------------------------------------------------- |
| tabs   | `(app)/(tabs)/_layout.tsx`, tab registry                                                  |
| drawer | `(app)/(drawer)/_layout.tsx` + stack parent; gesture-handler + reanimated + worklets deps |
| stack  | Stack-only home/settings under `(app)/`                                                   |

- [ ] Signed-out → AuthGate redirects to sign-in
- [ ] Signed-in on auth routes → GuestGate redirects to `/(app)`
- [ ] Loading session shows `StateView` loading (not flash of wrong screen)

### 6.2 Auth maturity

- [ ] Providers subset correctly stubs/hides Google/Apple
- [ ] Anonymous button when `anonymous` selected
- [ ] `enforceEmailVerification=true` → `session.isEmailSatisfied` / banner copy
- [ ] Dual bootstrap: client `ensureUserProfile` + functions `onUserCreated` (idempotent)
- [ ] Delete account row calls callable then signs out

### 6.3 Forms

- [ ] Sign-in / sign-up / forgot use `FormField` + Zod (invalid email blocked)

### 6.4 Theme / platform

- [ ] Appearance preference persists (MMKV) across reload (dev client)
- [ ] `useResponsive` breakpoint changes with window width (web)
- [ ] Code imports `@/lib/platform` (`isWeb` / `native()`) instead of raw `Platform.OS` in modules

### 6.5 Maps / deep-linking / push

- [ ] Maps: native MapView + web Google Maps (needs API key)
- [ ] Deep link: `Linking` URL and `appEvents.emit('DeepLink', { path })` navigate
- [ ] Push: notification tap with `deeplink` / `url` navigates; `sendPushToUser` only self

### 6.6 Stripe (e-commerce)

- [ ] Without secrets: callable fails with clear error
- [ ] With Stripe test secrets + webhook: Checkout URL opens; webhook marks order `paid`
- [ ] Client cannot forge totals (change price in client — server uses Firestore)

### 6.7 Platform Firebase modules

- [ ] Analytics web events; native uses RNFirebase file under Metro
- [ ] App Check web reCAPTCHA; native init path
- [ ] Crashlytics only on native build

### 6.8 EAS / variants (scaffold)

- [ ] `APP_VARIANT=development` → name suffix `(Dev)`, bundle id `.dev`
- [ ] `eas.json` profiles `development` / `preview` / `production` exist

---

## 7. `radiance prompt` (AI harness)

Requires provider config (`radiance config set provider …` + key via env / `radiance config set-key` / Ollama).

```bash
radiance config set-key anthropic          # prompts; stores in OS keychain
radiance config set-key cursor "$CURSOR_API_KEY"
radiance config unset-key openai
```

Env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CURSOR_API_KEY`) override the keychain when set.

```bash
cd "$RADIANCE_E2E/tasks"   # any project

radiance prompt "Add a settings row that shows the app version" --plan-only
radiance prompt "Add a settings row that shows the app version" --dry-run
radiance prompt "Install push notifications and wire them" -y
radiance prompt "Rename the home title copy" --no-verify -y
```

**Assert:**

- [ ] Plan prefers catalogue modules when request matches capabilities
- [ ] Combined diff includes module install + generated edits
- [ ] `--plan-only` / `--dry-run` write nothing
- [ ] Verify loop typechecks and repairs within `maxFixIterations` (unless `--no-verify`)
- [ ] `radiance explain` prints project `RADIANCE.md`

Providers to try at least once: `anthropic`, `openai`, `ollama`, `cursor`.

---

## 8. Update / upgrade / deploy

### 8.1 Cache refresh

```bash
# With remote repo (temporarily unset templatesPath):
radiance config set templatesPath ""
radiance update
radiance upgrade
radiance templates outdated
radiance templates prune
```

With local path, update/upgrade should no-op download and say local checkout.

### 8.2 Project sync

```bash
cd "$RADIANCE_E2E/shop"
radiance update --project --dry-run
radiance update --project -y    # only when you intend to reapply catalogue onto project
```

**Pass if:** confirms diff; preserves user edits outside markers; bumps `registryVersion` in
`radiance.json`.

### 8.3 Deploy (real Firebase project)

```bash
firebase login
firebase use staging   # or --project
radiance deploy --rules
radiance deploy --functions
radiance deploy --web
radiance deploy          # all applicable
```

**Pass if:** missing hosting/functions modules error clearly when forced; successful deploy
prints `Deployed.`

### 8.4 Destroy / teardown

Interactive (pick what to remove):

```bash
cd demo
radiance destroy
```

Non-interactive (E2E scratch projects) — requires explicit targets; `--force` skips typed confirms:

```bash
# Deletes the GCP project via Cloud Resource Manager (uses your `firebase login` token)
radiance destroy --firebase-project --unlink --local --force

# Or tear down resources without deleting the GCP project
radiance destroy --hosting --functions --firestore --unlink --force
```

**Pass if:** multiselect offers Firebase targets only when linked; typing the wrong project id
aborts; `--yes` alone without targets errors; local directory is gone after `--local`.

---

## 9. Negative / error paths

- [ ] `radiance add` outside project → error asking to run init
- [ ] `radiance init` into non-empty dir → error
- [ ] Unknown module id → error
- [ ] Conflicting / invalid `--option` → validation error with choices
- [ ] `RADIANCE_DEBUG=1` shows stack on unexpected errors and live LLM request/response traces for `radiance prompt`
- [ ] Malformed model JSON prints a response preview and writes `.radiance/runs/*-failure.json`
- [ ] Marker missing → note/warn, not silent corrupt file

---

## 10. Suggested day plan

| Block | Focus                                                  |
| ----- | ------------------------------------------------------ |
| A     | §0–1 tooling, config, doctor, templates list           |
| B     | §2.0 `yarn bootstrap:starters` + overlay/option shells |
| C     | §3 add every module on `modular` app                   |
| D     | §4–5 yarn typecheck/test + emulators happy path        |
| E     | §6 deep features (auth, maps, stripe, push)            |
| F     | §7 prompt harness                                      |
| G     | §8 deploy + destroy + update (if remote tags exist)    |

---

## 11. Sign-off checklist

Copy and fill:

```text
Date:
CLI version:
Templates path / version:
Node / yarn / firebase-tools:

[ ] doctor clean (or known warns only)
[ ] init: scaffold + 13 starters (`yarn bootstrap:starters` or manual §2)
[ ] add: modules exercised (auth, stripe, landing, demo-data, …)
[ ] options: auth providers, shell, theme pack, firestore persistence
[ ] typecheck + tests on at least one full app
[ ] emulator auth + firestore + one callable
[ ] prompt plan-only + one applied change
[ ] deploy dry-run or staging (optional)

Blockers / bugs found:
…
```

---

## Quick command cheat sheet

```bash
export RADIANCE_TEMPLATES_PATH="/Users/gordan/Documents/GitHub/Radiance/radiance-templates"

radiance doctor
radiance templates list
radiance compile --starter warehouse --platforms web
radiance init demo -t social-app -y
cd demo && yarn && yarn typecheck

# or from radiance-cli, every starter + scaffold + Firebase:
# yarn bootstrap:starters

radiance add maps deep-linking -y
radiance add navigation --option shell=drawer --force -y
radiance prompt "Add an empty About screen" --plan-only
radiance explain
radiance destroy
```
