# radiance-cli

Build Expo + Firebase apps from the [Radiance template catalogue](https://github.com/useradiance/radiance-templates),
with an AI harness that reuses the catalogue before it writes any code.

```bash
npm i -g radiance-cli

radiance init my-app --template social-app --pm pnpm   # offers Firebase setup
# or describe the app and let Radiance interview for the rest:
radiance init shop --prompt "an online store with Stripe and Google sign-in"
cd my-app
pnpm start
```

Skip cloud setup with `--no-firebase` or `-y`. Run `radiance setup firebase` later to login,
link a project, and write `.env`. Use `--pm npm|yarn|pnpm|bun` (or
`radiance config set packageManager <name>`) to choose a package manager.

With `--prompt`, Radiance extracts what it can from your description, then asks follow-up
questions until every required init setting is set (starter, theme, locale, package manager,
and module options like navigation shell / auth providers). Pass `-y` with `--prompt` to
autofill remaining slots from defaults after one extraction pass.

## Why the catalogue comes first

Most AI scaffolding tools generate a fresh answer to every question. Radiance does the opposite:
a request is matched against maintained modules first, and only what is genuinely new gets
generated — inside the conventions the templates already established.

```
radiance prompt "let people upload a profile picture"
  → matches the `storage` module (image-upload, avatars)
  → installs it, wires the provider, merges rules, locales and dependencies
  → generates only the screen that uses it
  → typechecks, repairs, then shows you the diff
```

That keeps generated projects on a single set of patterns however long you keep prompting.

## Commands

| Command | What it does |
| --- | --- |
| `radiance init <name>` | Create an app from a starter, or `--scaffold` for tooling only. `--prompt` runs an AI interview that fills init settings from natural language. `--demo` seeds optional sample content. |
| `radiance setup firebase` | Login, link a Firebase project, and write `.env`. If already linked, keep-and-retry or switch projects. |
| `radiance add <modules...>` | Install catalogue modules (deps resolved; options + required env prompted when interactive). `demo-data` also sets `EXPO_PUBLIC_SEED_DEMO=true`. |
| `radiance remove <module>` | Uninstall a module (files + tagged wiring). npm deps and locale keys are left as orphans to review. |
| `radiance prompt "<request>"` | Plan, install, generate, verify, apply; redeploys rules/indexes/functions when those files change. `-y --follow-up` auto-runs one residual prompt. |
| `radiance preview` | Start Expo web (`--export` writes `dist/`). |
| `radiance update` | Refresh the template cache within the current major |
| `radiance upgrade` | Move to the newest release, majors included |
| `radiance templates list` | Show starters and modules, marking what is installed |
| `radiance templates outdated` | Compare the cache with published releases |
| `radiance templates prune` | Delete cached releases nothing is using |
| `radiance doctor` | Check the toolchain, cache, and project wiring |
| `radiance explain` | Print this project's RADIANCE.md constitution |
| `radiance destroy` | Tear down Firebase resources and/or the local project |
| `radiance build` | Export web and/or build native binaries (EAS) into local artifacts |
| `radiance deploy` | Hosting, security rules, functions; optional mobile via App Distribution, EAS, or local artifacts |
| `radiance config set <key> <value>` | Change a setting |

`update` and `upgrade` take `--project` to sync the modules in the current app. Files you have
edited are reported as conflicts and left alone.

### Build and mobile deploy

```bash
# Local artifacts (web → dist/, native → .radiance/artifacts/<stamp>/)
radiance build                  # web + android + ios (EAS cloud by default)
radiance build --web
radiance build --android --ios --profile preview
radiance build --android --local   # eas build --local

# Firebase backend / web (unchanged defaults)
radiance deploy
radiance deploy --web --rules

# Mobile distribution (requires --android and/or --ios plus exactly one target)
radiance deploy --android --ios --app-distribution --groups qa
radiance deploy --android --eas --submit
radiance deploy --ios --local
radiance deploy --android --app-distribution --from .radiance/artifacts/2026-…
```

App Distribution needs `FIREBASE_ANDROID_APP_ID` / `FIREBASE_IOS_APP_ID` in `.env`
(written by `radiance setup firebase`). Native binaries use EAS profiles from `eas.json`.

## How a change is applied

Nothing is written until you accept it. Every command stages its work in an in-memory
workspace, prints a summary, and offers to apply everything, review file by file, or cancel.

1. **Match** — the request is scored against module capabilities.
2. **Adapt** — matched modules are installed: files, providers, security rules, indexes,
   locales, dependencies, environment variables.
3. **Plan** — the model returns a bounded plan (at most 8 files, no protected paths).
4. **Edit** — each file is written in full, given the project's own files as reference.
5. **Diff** — you approve the change.
6. **Verify** — `tsc --noEmit` runs; failures go back to the model up to `maxFixIterations` times.

Runs are recorded under `.radiance/runs/` so you can see what a prompt decided and why.

Multi-step commands (`init`, `add`, `prompt`, `update`, `upgrade`, `build`, `deploy`, `destroy`,
`setup firebase`) always write a step log under `.radiance/logs/` (or the global cache logs
dir before a project exists). Pass `--verbose` to echo those steps to the terminal as well.
The log path is printed when the command finishes.

## Configuration

Settings live in `~/.config/radiance/config.json` (`radiance config list` prints the path).

| Key | Default | Purpose |
| --- | --- | --- |
| `provider` | `anthropic` | `ollama`, `openai`, `anthropic` or `cursor` |
| `model` | provider default | Model used by `radiance prompt` |
| `ollamaHost` | `http://localhost:11434` | Where to reach a local Ollama |
| `packageManager` | — | Default for `radiance init`: `npm`, `yarn`, `pnpm` or `bun` |
| `templatesRepo` | useradiance/radiance-templates | Where releases are fetched from |
| `templatesChannel` | `latest` | Pin to a version to freeze the catalogue |
| `templatesPath` | — | Local checkout, for developing the catalogue |
| `gitAutoCommit` | `false` | Commit after a successful prompt |
| `verify` | `true` | Run the typecheck after applying |
| `maxFixIterations` | `2` | How many repair rounds a failing typecheck gets |

API keys come from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CURSOR_API_KEY`)
or the OS keychain. Env wins when both are set. Store a key with
`radiance config set-key <provider>` (prompted, or pass the value as the second argument);
remove it with `radiance config unset-key <provider>`. Ollama needs no key.

## Project layout

`radiance.json` records the starter, the templates release, and every installed module with its
version. `RADIANCE.md` is the constitution: stack, conventions, and the capabilities currently
installed. Both are read by the harness on every prompt, which is why generated code keeps
matching the rest of the project.

## Developing the CLI

```bash
yarn install
yarn build
yarn test                                        # unit tests, no network
RADIANCE_TEMPLATES_PATH=../radiance-templates \
  node dist/index.js init /tmp/demo -t social-app

# Init every starter + the bare scaffold, install, typecheck; apps stay on disk
yarn bootstrap:starters
yarn bootstrap:starters -- --starter social-app
yarn bootstrap:starters -- --project my-radiance-e2e
yarn bootstrap:starters -- --only social-app,e-commerce --clean
yarn bootstrap:starters -- --out .bootstrapped --no-install --no-firebase
```

`RADIANCE_TEMPLATES_PATH` points the CLI at a catalogue checkout instead of the release cache,
which is how the two repositories are developed together. `yarn bootstrap:starters` uses that
path (or the sibling `../radiance-templates` checkout) and writes apps to `~/tmp/radiance-starters`
by default. It is not part of `yarn test`.

Firebase setup is on by default (`firebase login` required). Each starter gets its own project
named `<starter>-<timestamp>` and created automatically. Pass `--project <id>` (or
`RADIANCE_FIREBASE_PROJECT`) to share one existing project instead; add `--create-project` if
that id does not exist yet. Use `--plan free` (the default) so Auth/Firestore hit the cloud and
Storage/Functions use emulators. `--no-firebase` skips linking.

## Requirements

Node 22.13+, a Node package manager (npm, yarn, pnpm or bun), and git.
`firebase-tools` is needed for `radiance deploy` (Firebase targets / App Distribution) and the emulators.
`eas-cli` is needed for mobile builds (`radiance build` / `radiance deploy --eas`).
