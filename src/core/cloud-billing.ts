/**
 * Cloud Billing helpers. Spark → Blaze is linking a billing account to the GCP project.
 * Creating a first billing account + card is console-only; linking an existing account is API.
 */

export const CLOUD_BILLING_API = "https://cloudbilling.googleapis.com/v1";

export type CloudBillingAccount = {
  name: string;
  displayName: string;
  open: boolean;
};

export type ProjectBillingInfo = {
  name: string;
  billingAccountName?: string;
  billingEnabled: boolean;
};

export type BillingFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type CloudBillingClientOptions = {
  getAccessToken: () => Promise<string>;
  /** Project used for API quota (`x-goog-user-project`). Prefer the target GCP project. */
  quotaProject?: string;
  fetchImpl?: BillingFetch;
};

export function cloudBillingLinkedAccountUrl(projectId: string): string {
  return `https://console.cloud.google.com/billing/linkedaccount?project=${encodeURIComponent(projectId)}`;
}

export function cloudBillingCreateUrl(projectId: string): string {
  return `https://console.cloud.google.com/billing/create?project=${encodeURIComponent(projectId)}`;
}

/** Firebase overlay — fallback when the Cloud Console link is blocked. */
export function firebaseBlazePurchaseUrl(projectId: string): string {
  return `https://console.firebase.google.com/project/${encodeURIComponent(projectId)}/overview?purchaseBillingPlan=metered`;
}

export function parseBillingAccounts(json: unknown): CloudBillingAccount[] {
  const raw = json as { billingAccounts?: unknown };
  const list = Array.isArray(raw.billingAccounts) ? raw.billingAccounts : [];
  const accounts: CloudBillingAccount[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as {
      name?: unknown;
      displayName?: unknown;
      open?: unknown;
    };
    if (
      typeof row.name !== "string" ||
      !row.name.startsWith("billingAccounts/")
    ) {
      continue;
    }
    accounts.push({
      name: row.name,
      displayName:
        typeof row.displayName === "string" && row.displayName.trim()
          ? row.displayName.trim()
          : row.name.replace(/^billingAccounts\//, ""),
      open: row.open !== false,
    });
  }
  return accounts;
}

export function openBillingAccounts(
  accounts: CloudBillingAccount[],
): CloudBillingAccount[] {
  return accounts.filter((account) => account.open);
}

export function parseProjectBillingInfo(
  json: unknown,
  projectId: string,
): ProjectBillingInfo {
  const row = (json ?? {}) as {
    name?: unknown;
    billingAccountName?: unknown;
    billingEnabled?: unknown;
  };
  return {
    name:
      typeof row.name === "string" && row.name
        ? row.name
        : `projects/${projectId}/billingInfo`,
    billingAccountName:
      typeof row.billingAccountName === "string" && row.billingAccountName
        ? row.billingAccountName
        : undefined,
    billingEnabled: row.billingEnabled === true,
  };
}

export type BillingLinkDecision =
  | { action: "skip" }
  | { action: "link"; accountName: string }
  | { action: "pick"; accounts: CloudBillingAccount[] }
  | { action: "browser" };

/**
 * Decide how to attach billing given current project state and the user's open accounts.
 * Headless (`yes`) still returns `pick` when several accounts exist — the caller must fail.
 */
export function decideBillingLink(input: {
  billingEnabled: boolean;
  accounts: CloudBillingAccount[];
  yes?: boolean;
}): BillingLinkDecision {
  if (input.billingEnabled) return { action: "skip" };
  const open = openBillingAccounts(input.accounts);
  if (open.length === 1) {
    return { action: "link", accountName: open[0]!.name };
  }
  if (open.length > 1) {
    return { action: "pick", accounts: open };
  }
  return { action: "browser" };
}

async function billingHeaders(
  options: CloudBillingClientOptions,
): Promise<Record<string, string>> {
  const token = await options.getAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (options.quotaProject) {
    headers["x-goog-user-project"] = options.quotaProject;
  }
  return headers;
}

async function readBillingError(response: Response): Promise<string> {
  const text = (await response.text()).trim();
  if (!text) return `HTTP ${response.status}`;
  try {
    const json = JSON.parse(text) as { error?: { message?: string } };
    return json.error?.message ?? text.slice(0, 400);
  } catch {
    return text.slice(0, 400);
  }
}

export class CloudBillingError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "CloudBillingError";
  }
}

export async function listOpenBillingAccounts(
  options: CloudBillingClientOptions,
): Promise<CloudBillingAccount[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = await billingHeaders(options);
  const response = await fetchImpl(`${CLOUD_BILLING_API}/billingAccounts`, {
    headers,
  });
  if (!response.ok) {
    throw new CloudBillingError(
      "Could not list Cloud Billing accounts",
      response.status,
      await readBillingError(response),
    );
  }
  const json: unknown = await response.json();
  return openBillingAccounts(parseBillingAccounts(json));
}

export async function getProjectBillingInfo(
  projectId: string,
  options: CloudBillingClientOptions,
): Promise<ProjectBillingInfo> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = await billingHeaders({
    ...options,
    quotaProject: options.quotaProject ?? projectId,
  });
  const response = await fetchImpl(
    `${CLOUD_BILLING_API}/projects/${encodeURIComponent(projectId)}/billingInfo`,
    { headers },
  );
  if (!response.ok) {
    throw new CloudBillingError(
      `Could not read billing status for ${projectId}`,
      response.status,
      await readBillingError(response),
    );
  }
  const json: unknown = await response.json();
  return parseProjectBillingInfo(json, projectId);
}

export async function linkProjectBilling(
  projectId: string,
  billingAccountName: string,
  options: CloudBillingClientOptions,
): Promise<ProjectBillingInfo> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = await billingHeaders({
    ...options,
    quotaProject: options.quotaProject ?? projectId,
  });
  const response = await fetchImpl(
    `${CLOUD_BILLING_API}/projects/${encodeURIComponent(projectId)}/billingInfo`,
    {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ billingAccountName }),
    },
  );
  if (!response.ok) {
    const detail = await readBillingError(response);
    const hint =
      response.status === 403
        ? "You need Billing Account User on the billing account and Owner on the project."
        : detail;
    throw new CloudBillingError(
      `Could not link billing to ${projectId}`,
      response.status,
      hint,
    );
  }
  const json: unknown = await response.json();
  return parseProjectBillingInfo(json, projectId);
}

export async function waitForProjectBilling(
  projectId: string,
  options: CloudBillingClientOptions & {
    timeoutMs?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<ProjectBillingInfo> {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const intervalMs = options.intervalMs ?? 5_000;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = Date.now();
  let last: ProjectBillingInfo | undefined;
  while (Date.now() - started < timeoutMs) {
    last = await getProjectBillingInfo(projectId, options);
    if (last.billingEnabled) return last;
    const accounts = await listOpenBillingAccounts(options).catch(
      () => [] as CloudBillingAccount[],
    );
    if (accounts.length === 1) {
      last = await linkProjectBilling(projectId, accounts[0]!.name, options);
      if (last.billingEnabled) return last;
    }
    await sleep(intervalMs);
  }
  throw new CloudBillingError(
    `Timed out waiting for billing on ${projectId}`,
    undefined,
    `Finish linking at ${cloudBillingLinkedAccountUrl(projectId)}`,
  );
}
