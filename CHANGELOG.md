# Changelog

## 0.2.0

### New

- `init --display-name <name>` — the name the app shows, when it should differ
  from its directory. Without it the directory name is the display name, which
  is right at a terminal and wrong for tools that build in a temp directory.
- `init --plan-json <path>` — writes the resolved plan (chosen starter, theme,
  extra modules, and the follow-up prompt for whatever the starter does not
  cover) as JSON before anything is staged. For callers without a terminal.
- `init --translate-locales` and `add --translate-locales` — machine-translate
  every non-English locale. Previously only the AI interview could turn
  translation on, so `--locale en,fr` produced a `fr.json` that was a copy of
  `en.json`.
- `add --provider` / `--model`, for the translation above.
- `radiance translate` — sweeps hard-coded UI copy into `locales/en.json`,
  then translates every other locale, in an existing project. These are the
  two steps `init --translate-locales` ends with, as a command of their own:
  for a caller that writes more code after `init` (a follow-up prompt, added
  modules), the end of `init` is too early and the later strings stayed
  English.
- `init --no-i18n-sweep` — leaves the sweep to a later `radiance translate`,
  so a caller that writes more code after `init` does not pay for it twice.
- `translate --since <git-ref>` — sweeps only the UI files changed since that
  ref (committed, staged, unstaged or untracked), and skips the sweep and its
  LLM call when none did. When git cannot answer it sweeps everything, with a
  warning.
- `--translation-memory <dir>` on `translate`, `init` and `add` — where
  translations are remembered between runs and projects, so a string
  translated once is not sent to the model again. Defaults to
  `RADIANCE_TRANSLATION_MEMORY`, then `translation-memory/` in the cache
  directory.
- `RADIANCE_TIMINGS_FILE=<path>` — on exit, writes where the run spent its
  time as JSON: nested steps (`prompt/verify/typecheck`), every LLM call with
  its step, duration, sizes and token counts, and counters such as
  `translate.fromMemory`. Names and numbers only — never prompt text, file
  contents or keys. Without the variable nothing is recorded.
- `setup firebase --app-name <name>` — the GCP project's display name.

### Changed

- Locale translation is batched, concurrent and remembered. It sent the whole
  English catalogue in one call per locale, one locale after another, and
  asked for all of it back — about a minute per locale, and a large catalogue
  could be cut off at the token limit. Now only strings missing from the
  translation memory are sent, in batches of up to 60, four at a time across
  all locales (`RADIANCE_TRANSLATE_CONCURRENCY` to change it). A translation
  that loses a `{{placeholder}}`, `$t(…)` reference or `<0>` tag keeps the
  English, as does a batch that fails twice, and every locale file is rebuilt
  with exactly English's keys in English's order.

- `prompt --max-repairs <n>` — repair rounds after a failing typecheck
  (0–5), instead of the configured `maxFixIterations`. For callers that need a
  working result quickly more than a clean one: each round is a model call
  over the failing files, and a type error does not stop the app bundling.

### Fixed

- `init --prompt` could build on the bare scaffold — no screens at all — when
  no starter matched the description closely, so the app's first screen was a
  placeholder. A description now always gets a starter: the closest keyword
  match, or `productivity` (the most general one) when nothing is close. Only
  an explicit `--scaffold` produces a bare project.
- `init --demo` discarded `--theme-pack` and every unqualified `--option`,
  leaving the app in the theme module's default palette. `--demo` adds
  `demo-data` to the module list, and "no modules named" was being used to
  mean "this is `init`".
- `init --prompt` silently dropped `--option` for any module other than
  navigation, auth, firestore and theme — `--option search.backend=algolia`
  produced Firestore search. The option catalogue now covers every module.
- `--locale en,fr` set the default locale to the literal `"en,fr"` and wrote a
  `locales/en,fr.json` beside the real catalogues.
- `prompt --follow-up` ran the chained follow-up on the configured default
  provider instead of the `--provider` given, so it failed on machines with
  only one provider's key.
- `add --translate-locales` translates even when every requested module was
  already installed.
- `setup firebase`, headless: derives a valid GCP display name from the app
  name; enables the Firebase Management API before `addFirebase`; tolerates a
  409 for a project the caller already owns; sends no `x-goog-user-project`
  header for a project that cannot yet accept the bill; and fails the command
  on a provisioning error instead of printing a warning and exiting 0.
