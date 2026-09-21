import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { substitute } from "../src/core/apply/engine.js";
import { pickTarget } from "../src/core/cache.js";
import { deriveVars } from "../src/core/install.js";
import { RadianceError } from "../src/core/logger.js";
import {
  resolveModuleOrder,
  type Registry,
  type ModuleOptionDef,
} from "../src/core/registry.js";
import {
  extractExportContracts,
  mergeContracts,
} from "../src/harness/contracts.js";
import { extractJson } from "../src/harness/llm.js";
import { offerFollowUpPrompt } from "../src/harness/follow-up-offer.js";
import {
  PlanSchema,
  renderPlan,
  validatePlan,
  type Plan,
} from "../src/harness/plan.js";
import {
  matchModules,
  matchStarters,
  contractSourceFiles,
  anchorFiles,
} from "../src/harness/retrieval.js";
import { parseFailingFiles } from "../src/harness/verify.js";
import {
  heuristicExtract,
  parseInitExtractResponse,
} from "../src/harness/init-interview.js";
import {
  applyDefaultsForYes,
  applyFlagOverrides,
  emptyPlan,
  isPlanComplete,
  lockedSlotsFromFlags,
  mergePlanUpdates,
  missingSlots,
  type OptionCatalog,
} from "../src/harness/init-slots.js";
function registry(): Registry {
  const module = (id: string, requires: string[], capabilities: string[]) => ({
    id,
    path: `modules/${id}`,
    version: "0.1.0",
    title: id,
    description: `${id} module`,
    side: "app",
    capabilities,
    requires,
    conflicts: [],
  });

  return {
    version: "0.1.0",
    expoSdk: 57,
    scaffold: {
      id: "expo-app",
      path: "scaffold/expo-app",
      version: "0.1.0",
      requiredModules: ["i18n", "theme", "navigation"],
    },
    starters: [
      {
        id: "e-commerce",
        path: "starters/e-commerce",
        version: "0.1.0",
        extends: "expo-app",
        title: "Storefront",
        description: "Product catalogue and Stripe checkout.",
        modules: ["i18n", "theme", "navigation", "firestore", "auth", "stripe"],
        capabilities: [
          "e-commerce",
          "storefront",
          "shopping-cart",
          "checkout",
          "stripe",
        ],
        defaults: { themePack: "contrast" },
      },
      {
        id: "productivity",
        path: "starters/productivity",
        version: "0.1.0",
        extends: "expo-app",
        title: "Productivity app",
        description: "Projects and tasks.",
        modules: ["i18n", "theme", "navigation", "firestore", "auth"],
        capabilities: ["tasks", "todo", "projects", "productivity"],
        defaults: { themePack: "neutral" },
      },
    ],
    modules: [
      module("i18n", [], ["i18n", "translations"]),
      module("theme", ["i18n"], ["theme", "dark-mode"]),
      module("navigation", [], ["navigation", "tabs", "drawer"]),
      module("firestore", [], ["database", "offline-first"]),
      module("auth", ["firestore"], ["auth", "login"]),
      module("storage", ["auth"], ["storage", "image-upload", "avatars"]),
      module("stripe", [], ["stripe", "checkout", "payments"]),
    ],
  };
}

function optionCatalog(): OptionCatalog {
  const single = (choices: string[], fallback: string): ModuleOptionDef => ({
    type: "single",
    choices,
    default: fallback,
    min: 1,
  });
  const multi = (choices: string[], fallback: string[]): ModuleOptionDef => ({
    type: "multi",
    choices,
    default: fallback,
    min: 1,
  });

  return {
    "navigation.shell": single(["tabs", "drawer", "stack"], "tabs"),
    "auth.providers": multi(
      ["email", "google", "apple", "anonymous"],
      ["email", "google", "apple"],
    ),
    "auth.enforceEmailVerification": single(["true", "false"], "false"),
    "firestore.nativePersistence": single(["memory", "rnfirebase"], "memory"),
    "theme.pack": single(
      [
        "neutral",
        "contrast",
        "branded",
        "ocean",
        "ink",
        "hearth",
        "bloom",
        "flare",
        "paper",
        "grove",
        "violet",
        "citrus",
        "custom",
      ],
      "neutral",
    ),
  };
}

describe("module resolution", () => {
  it("installs dependencies before their dependants", () => {
    const order = resolveModuleOrder(registry(), ["storage"]);

    assert.deepEqual(order, ["firestore", "auth", "storage"]);
  });

  it("skips modules that are already installed", () => {
    const order = resolveModuleOrder(
      registry(),
      ["storage"],
      ["firestore", "auth"],
    );

    assert.deepEqual(order, ["storage"]);
  });

  it("rejects unknown modules", () => {
    assert.throws(
      () => resolveModuleOrder(registry(), ["payments"]),
      RadianceError,
    );
  });

  it("does not install anything twice", () => {
    const order = resolveModuleOrder(registry(), [
      "auth",
      "storage",
      "firestore",
    ]);

    assert.deepEqual(order, ["firestore", "auth", "storage"]);
  });
});

describe("template variables", () => {
  it("derives a slug, scheme and bundle id from the app name", () => {
    const vars = deriveVars("My Great App");

    assert.equal(vars.slug, "my-great-app");
    assert.equal(vars.scheme, "mygreatapp");
    assert.equal(vars.bundleId, "com.radiance.mygreatapp");
  });

  it("substitutes placeholders and leaves unknown ones alone", () => {
    const vars = deriveVars("Demo");
    const result = substitute(
      "name={{radiance.appName}} other={{radiance.nope}}",
      vars,
    );

    assert.equal(result, "name=Demo other={{radiance.nope}}");
  });
});

describe("cache version selection", () => {
  it("stays within the current major by default", () => {
    assert.equal(
      pickTarget(["2.0.0", "1.3.0", "1.2.0"], "1.2.0", false),
      "1.3.0",
    );
  });

  it("moves to the newest release when a major bump is allowed", () => {
    assert.equal(pickTarget(["2.0.0", "1.3.0"], "1.2.0", true), "2.0.0");
  });

  it("keeps the current version when nothing newer shares its major", () => {
    assert.equal(pickTarget(["2.0.0"], "1.2.0", false), "1.2.0");
  });
});

describe("catalogue matching", () => {
  it("ranks the module that owns the requested capability first", () => {
    const matches = matchModules(
      registry(),
      "let people upload an avatar image to their profile",
      new Set(),
    );

    assert.equal(matches[0]?.id, "storage");
  });

  it("marks modules that are already installed", () => {
    const matches = matchModules(
      registry(),
      "dark mode theme",
      new Set(["theme"]),
    );

    assert.equal(matches[0]?.id, "theme");
    assert.equal(matches[0]?.installed, true);
  });

  it("returns nothing for a request the catalogue does not cover", () => {
    assert.deepEqual(
      matchModules(registry(), "render a 3d globe", new Set()),
      [],
    );
  });

  it("maps pay language onto the stripe module", () => {
    const matches = matchModules(
      registry(),
      "let people pay for this",
      new Set(),
    );
    assert.equal(matches[0]?.id, "stripe");
  });
});

describe("starter matching", () => {
  it("ranks the storefront starter for a Stripe shop request", () => {
    const matches = matchStarters(
      registry(),
      "an online store with Stripe checkout",
    );

    assert.equal(matches[0]?.id, "e-commerce");
  });

  it("ranks productivity for a tasks request", () => {
    const matches = matchStarters(
      registry(),
      "a todo list for projects and tasks",
    );

    assert.equal(matches[0]?.id, "productivity");
  });

  it("surfaces bare scaffold for from-scratch tooling", () => {
    const matches = matchStarters(
      registry(),
      "bare scaffold from scratch with minimal tooling",
    );

    assert.equal(matches[0]?.id, null);
  });
});

describe("init plan completeness", () => {
  it("reports core slots missing on an empty plan", () => {
    const missing = missingSlots(emptyPlan(), registry());

    assert.ok(missing.includes("name"));
    assert.ok(missing.includes("starterId"));
    assert.ok(missing.includes("packageManager"));
    assert.ok(missing.includes("themePack"));
    assert.ok(missing.includes("locale"));
    assert.equal(missing.includes("auth.providers"), false);
  });

  it("requires auth options only after an auth-bearing starter is chosen", () => {
    const plan = {
      ...emptyPlan(),
      name: "shop",
      starterId: "e-commerce" as string | null,
      packageManager: "npm" as const,
      themePack: "contrast" as const,
      locale: "en",
      locales: ["en"],
    };

    const missing = missingSlots(plan, registry());

    assert.ok(missing.includes("navigation.shell"));
    assert.ok(missing.includes("auth.providers"));
    assert.ok(missing.includes("firestore.nativePersistence"));
  });

  it("does not require auth options for bare scaffold", () => {
    const plan = {
      ...emptyPlan(),
      name: "bare",
      starterId: null as string | null,
      packageManager: "npm" as const,
      themePack: "neutral" as const,
      locale: "en",
      locales: ["en"],
      options: { "navigation.shell": "tabs" },
    };

    const { ok, missing } = isPlanComplete(plan, registry());

    assert.equal(ok, true);
    assert.deepEqual(missing, []);
  });

  it("lets CLI flags lock slots so NL cannot overwrite them", () => {
    const flags = {
      template: "productivity",
      themePack: "branded",
      pm: "pnpm",
    };
    const locked = lockedSlotsFromFlags(flags);
    let plan = applyFlagOverrides(emptyPlan(), flags, registry());
    plan = mergePlanUpdates(
      plan,
      {
        starterId: "e-commerce",
        themePack: "contrast",
        packageManager: "npm",
        name: "from-nl",
      },
      locked,
    );

    assert.equal(plan.starterId, "productivity");
    assert.equal(plan.themePack, "branded");
    assert.equal(plan.packageManager, "pnpm");
    assert.equal(plan.name, "from-nl");
  });

  it("autofills remaining required slots under -y", () => {
    const plan = applyDefaultsForYes(
      { ...emptyPlan(), name: "shop", starterId: "e-commerce" },
      registry(),
      optionCatalog(),
      "yarn",
    );

    assert.equal(plan.themePack, "contrast");
    assert.equal(plan.locale, "en");
    assert.deepEqual(plan.locales, ["en"]);
    assert.equal(plan.packageManager, "yarn");
    assert.ok(plan.options["auth.providers"]);
    assert.equal(isPlanComplete(plan, registry()).ok, true);
  });

  it("heuristic extract picks drawer shell and google auth", () => {
    const updates = heuristicExtract(
      "a shop with Stripe, drawer navigation, Google-only auth",
      registry(),
    );

    assert.equal(updates.starterId, "e-commerce");
    assert.equal(updates.options?.["navigation.shell"], "drawer");
    assert.deepEqual(updates.options?.["auth.providers"], ["google"]);
  });

  it("tolerates nulls and invalid enums from model extract JSON", () => {
    const parsed = parseInitExtractResponse({
      updates: {
        name: null,
        starterId: "social-app",
        themePack: null,
        locale: null,
        packageManager: "cargo",
        bundleId: null,
        options: { "navigation.shell": "tabs" },
      },
      rationale: null,
      followUpPrompt: null,
    });

    assert.equal(parsed.updates.name, undefined);
    assert.equal(parsed.updates.starterId, "social-app");
    assert.equal(parsed.updates.themePack, undefined);
    assert.equal(parsed.updates.packageManager, undefined);
    assert.equal(parsed.followUpPrompt, undefined);
    assert.equal(parsed.updates.options?.["navigation.shell"], "tabs");
  });
});

describe("plan validation", () => {
  const context = {
    root: "/app",
    project: {} as never,
    source: { root: "/t", version: "0.1.0", registry: registry(), local: true },
    constitution: "",
    files: [],
  };

  const plan = (overrides: Partial<Plan>): Plan => ({
    summary: "do a thing",
    modules: [],
    files: [],
    locales: [],
    rules: null,
    risks: [],
    deferred: [],
    followUpPrompt: null,
    ...overrides,
  });

  it("defaults deferred and followUpPrompt when the model omits them", () => {
    const parsed = PlanSchema.parse({ summary: "install auth" });
    assert.deepEqual(parsed.deferred, []);
    assert.equal(parsed.followUpPrompt, null);
  });

  it("renders deferred work and the next prompt", () => {
    const text = renderPlan(
      plan({
        deferred: ["threaded comments", "push notifications"],
        followUpPrompt:
          "Add comments under posts/{id}/comments and a notification preference toggle.",
      }),
    );

    assert.match(text, /Left for later:/);
    assert.match(text, /threaded comments/);
    assert.match(text, /Next prompt:/);
    assert.match(text, /Add comments under posts/);
  });

  it("drops files outside the project and files Radiance owns", () => {
    const validated = validatePlan(
      plan({
        files: [
          {
            path: "app/index.tsx",
            action: "modify",
            intent: "ok",
            typeContracts: null,
          },
          {
            path: "../../etc/passwd",
            action: "modify",
            intent: "no",
            typeContracts: null,
          },
          {
            path: "package.json",
            action: "modify",
            intent: "no",
            typeContracts: null,
          },
          {
            path: "node_modules/x/index.js",
            action: "modify",
            intent: "no",
            typeContracts: null,
          },
        ],
      }),
      context,
    );

    assert.deepEqual(
      validated.files.map((file) => file.path),
      ["app/index.tsx"],
    );
  });

  it("rejects modules that are not in the catalogue", () => {
    assert.throws(
      () => validatePlan(plan({ modules: ["payments"] }), context),
      RadianceError,
    );
  });

  it("rejects plans that touch too many files", () => {
    const files = Array.from({ length: 9 }, (_, index) => ({
      path: `app/file-${index}.tsx`,
      action: "create" as const,
      intent: "x",
      typeContracts: null,
    }));

    assert.throws(() => validatePlan(plan({ files }), context), RadianceError);
  });
});

describe("follow-up offer", () => {
  it("does not run when yes is true", async () => {
    let ran = false;
    await offerFollowUpPrompt("Add comments under posts", {
      yes: true,
      heading: "Remaining work",
      confirmMessage: "Apply now?",
      run: async () => {
        ran = true;
      },
    });
    assert.equal(ran, false);
  });

  it("runs once when yes and chain are true", async () => {
    let ran = false;
    await offerFollowUpPrompt("Add comments under posts", {
      yes: true,
      chain: true,
      heading: "Remaining work",
      confirmMessage: "Apply now?",
      run: async () => {
        ran = true;
      },
    });
    assert.equal(ran, true);
  });

  it("no-ops on blank follow-up text", async () => {
    let ran = false;
    await offerFollowUpPrompt("   \n  ", {
      yes: false,
      heading: "Remaining work",
      confirmMessage: "Apply now?",
      run: async () => {
        ran = true;
      },
    });
    assert.equal(ran, false);
  });
});

describe("model output parsing", () => {
  it("reads JSON out of a fenced block", () => {
    const value = extractJson<{ summary: string }>(
      'Sure!\n```json\n{"summary":"hi"}\n```\n',
    );

    assert.equal(value.summary, "hi");
  });

  it("reads a reply that is only a fenced JSON block", () => {
    const value = extractJson<{ summary: string }>(
      '```json\n{"summary":"hi"}\n```',
    );

    assert.equal(value.summary, "hi");
  });

  it("does not treat fences inside JSON string values as wrappers", () => {
    const raw = JSON.stringify({
      contents:
        '```typescript\nimport {\n  collection,\n} from "firebase/firestore";\n```',
      notes: null,
    });

    const value = extractJson<{ contents: string; notes: null }>(raw);
    assert.match(value.contents, /^```typescript/);
    assert.match(value.contents, /collection/);
  });

  it("reads bare JSON surrounded by prose", () => {
    const value = extractJson<{ a: number }>(
      'Here you go: {"a": 1} — hope that helps.',
    );

    assert.equal(value.a, 1);
  });

  it("fails loudly when there is no JSON at all", () => {
    try {
      extractJson("I cannot do that.");
      assert.fail("expected extractJson to throw");
    } catch (error) {
      assert.ok(error instanceof RadianceError);
      assert.equal(error.message, "The model did not return JSON");
      assert.match(error.hint ?? "", /Response preview:/);
      assert.match(error.hint ?? "", /I cannot do that/);
    }
  });

  it("includes a response preview when JSON is malformed", () => {
    try {
      // Trailing comma — braces present, JSON.parse fails.
      extractJson('{ "summary": "hi", }');
      assert.fail("expected extractJson to throw");
    } catch (error) {
      assert.ok(error instanceof RadianceError);
      assert.equal(error.message, "The model returned malformed JSON");
      assert.match(error.hint ?? "", /Response preview:/);
      assert.match(error.hint ?? "", /"summary"/);
    }
  });
});

describe("harness failure dumps", () => {
  it("writes a failure record under .radiance/runs", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { writeHarnessFailure } =
      await import("../src/harness/diagnostics.js");

    const root = await mkdtemp(join(tmpdir(), "radiance-dump-"));
    try {
      const relative = await writeHarnessFailure(root, {
        stage: "edit",
        path: "lib/posts.ts",
        provider: "ollama",
        model: "qwen2.5-coder:14b",
        request: "Add geo fields",
        error: "The model returned malformed JSON",
        raw: '{ "contents": ',
      });

      assert.match(relative, /\.radiance\/runs\/.*-failure\.json$/);
      const record = JSON.parse(
        await readFile(join(root, relative), "utf8"),
      ) as {
        path: string;
        raw: string;
        provider: string;
      };
      assert.equal(record.path, "lib/posts.ts");
      assert.equal(record.provider, "ollama");
      assert.equal(record.raw, '{ "contents": ');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("typecheck output", () => {
  it("orders failing files by error count", () => {
    const output = [
      "app/a.tsx(1,1): error TS2304: Cannot find name 'x'.",
      "app/b.tsx(2,1): error TS2304: Cannot find name 'y'.",
      "app/a.tsx(3,1): error TS2304: Cannot find name 'z'.",
      "Found 3 errors.",
    ].join("\n");

    assert.deepEqual(parseFailingFiles(output), ["app/a.tsx", "app/b.tsx"]);
  });

  it("returns nothing for a clean run", () => {
    assert.deepEqual(parseFailingFiles(""), []);
  });
});

describe("extractExportContracts", () => {
  it("infers hook return shapes and type aliases", () => {
    const source = `
export type MapRegion = {
  latitude: number;
  longitude: number;
};

export function useUserLocation(initial: MapRegion = DEFAULT_REGION) {
  const [region, setRegion] = useState(initial);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const requestPermission = useCallback(async () => null, []);
  return { region, setRegion, error, isLoading, requestPermission };
}
`;
    const contracts = extractExportContracts(source, "lib/maps.ts");
    assert.match(contracts, /export type MapRegion/);
    assert.match(contracts, /useUserLocation/);
    assert.match(contracts, /region/);
    assert.match(contracts, /isLoading/);
    assert.match(contracts, /requestPermission/);
    assert.doesNotMatch(contracts, /\blocation\b/);
    assert.doesNotMatch(contracts, /requestOnMount/);
  });

  it("extracts spacing token keys so invented keys like xxs are visible as absent", () => {
    const source = `
export const spacing = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
};
`;
    const contracts = extractExportContracts(source, "lib/theme/tokens.ts");
    assert.match(contracts, /export const spacing/);
    assert.match(contracts, /xs/);
    assert.match(contracts, /xxxl/);
    assert.doesNotMatch(contracts, /\bxxs\b/);
  });

  it("extracts StateViewProps kind union", () => {
    const source = `
export type StateViewProps = {
  kind: 'loading' | 'empty' | 'error';
  title?: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
};

export function StateView({ kind }: StateViewProps) {
  return null;
}
`;
    const contracts = extractExportContracts(
      source,
      "components/ui/StateView.tsx",
    );
    assert.match(contracts, /StateViewProps/);
    assert.match(contracts, /kind: 'loading' \| 'empty' \| 'error'/);
  });

  it("merges project and planner contracts", () => {
    assert.equal(mergeContracts(null, null), null);
    assert.equal(mergeContracts("a", null), "a");
    assert.equal(mergeContracts("a", "b"), "a\n\nb");
  });

  it("extracts IconButton props including icon alias", () => {
    const source = `
export type IconButtonProps = {
  name?: string;
  icon?: string;
  accessibilityLabel: string;
};

export function IconButton({ name, icon }: IconButtonProps) {
  return null;
}
`;
    const contracts = extractExportContracts(
      source,
      "components/ui/IconButton.tsx",
    );
    assert.match(contracts, /IconButtonProps/);
    assert.match(contracts, /\bicon\??:/);
    assert.match(contracts, /\bname\??:/);
  });

  it("extracts UploadResult path + storagePath alias", () => {
    const source = `
export type UploadResult = {
  path: string;
  storagePath: string;
  downloadUrl: string;
};

export async function uploadFileFromUri(uri: string, path: string): Promise<UploadResult> {
  return { path, storagePath: path, downloadUrl: '' };
}
`;
    const contracts = extractExportContracts(source, "lib/storage.ts");
    assert.match(contracts, /UploadResult/);
    assert.match(contracts, /storagePath/);
    assert.match(contracts, /downloadUrl/);
  });

  it("extracts generic hooks like useDocument (types + factory signature)", () => {
    const source = `
export type DocumentResult<T> = {
  data: T | null;
  isLoading: boolean;
};

export type DocumentRefFactory<T> = () => DocumentReference<T> | DocumentReference<DocumentData>;

export function useDocument<T = DocumentData>(
  refFactory: DocumentRefFactory<T>,
  key: string | null,
): DocumentResult<T> {
  return { data: null, isLoading: false };
}
`;
    const contracts = extractExportContracts(source, "hooks/useDocument.ts");
    assert.match(contracts, /DocumentResult/);
    assert.match(contracts, /DocumentRefFactory/);
    assert.match(contracts, /useDocument/);
    assert.match(contracts, /DocumentRefFactory<T>/);
  });
});

describe("contractSourceFiles / anchorFiles", () => {
  it("includes storage and IconButton surfaces so edit prompts ground those shapes", () => {
    const files = [
      "lib/storage.ts",
      "components/ui/IconButton.tsx",
      "hooks/useStorageUrl.ts",
      "components/UploadButton.tsx",
      "hooks/useDocument.ts",
      "lib/posts.ts",
    ];
    const contracts = contractSourceFiles(files);
    assert.ok(contracts.includes("lib/storage.ts"));
    assert.ok(contracts.includes("components/ui/IconButton.tsx"));
    assert.ok(contracts.includes("hooks/useStorageUrl.ts"));
    assert.ok(contracts.includes("lib/posts.ts"));

    const anchors = anchorFiles(files);
    assert.ok(anchors.includes("lib/storage.ts"));
    assert.ok(anchors.includes("components/ui/IconButton.tsx"));
  });
});
