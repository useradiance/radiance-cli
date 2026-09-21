import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cloudBillingCreateUrl,
  cloudBillingLinkedAccountUrl,
  decideBillingLink,
  firebaseBlazePurchaseUrl,
  openBillingAccounts,
  parseBillingAccounts,
  parseProjectBillingInfo,
} from "../src/core/cloud-billing.js";

describe("cloud billing URLs", () => {
  it("points at Cloud Console link/create, not Firebase usage/details", () => {
    assert.equal(
      cloudBillingLinkedAccountUrl("my-app"),
      "https://console.cloud.google.com/billing/linkedaccount?project=my-app",
    );
    assert.equal(
      cloudBillingCreateUrl("my-app"),
      "https://console.cloud.google.com/billing/create?project=my-app",
    );
    assert.match(
      firebaseBlazePurchaseUrl("my-app"),
      /purchaseBillingPlan=metered/,
    );
  });
});

describe("parseBillingAccounts", () => {
  it("keeps open accounts and drops malformed rows", () => {
    const accounts = parseBillingAccounts({
      billingAccounts: [
        {
          name: "billingAccounts/AAAAAA-BBBBBB-CCCCCC",
          displayName: "My card",
          open: true,
        },
        {
          name: "billingAccounts/CLOSED1-CLOSED2-CLOSED3",
          displayName: "Old",
          open: false,
        },
        { displayName: "no name" },
      ],
    });
    assert.equal(accounts.length, 2);
    assert.deepEqual(openBillingAccounts(accounts), [
      {
        name: "billingAccounts/AAAAAA-BBBBBB-CCCCCC",
        displayName: "My card",
        open: true,
      },
    ]);
  });
});

describe("parseProjectBillingInfo", () => {
  it("treats missing billingEnabled as not billed", () => {
    assert.deepEqual(parseProjectBillingInfo({}, "p"), {
      name: "projects/p/billingInfo",
      billingAccountName: undefined,
      billingEnabled: false,
    });
  });

  it("reads a linked account", () => {
    const info = parseProjectBillingInfo(
      {
        name: "projects/p/billingInfo",
        billingAccountName: "billingAccounts/AAAAAA-BBBBBB-CCCCCC",
        billingEnabled: true,
      },
      "p",
    );
    assert.equal(info.billingEnabled, true);
    assert.equal(info.billingAccountName, "billingAccounts/AAAAAA-BBBBBB-CCCCCC");
  });
});

describe("decideBillingLink", () => {
  const a = {
    name: "billingAccounts/A",
    displayName: "A",
    open: true,
  };
  const b = {
    name: "billingAccounts/B",
    displayName: "B",
    open: true,
  };

  it("skips when already billed", () => {
    assert.deepEqual(
      decideBillingLink({ billingEnabled: true, accounts: [a] }),
      { action: "skip" },
    );
  });

  it("auto-links a single open account", () => {
    assert.deepEqual(
      decideBillingLink({ billingEnabled: false, accounts: [a] }),
      { action: "link", accountName: a.name },
    );
  });

  it("asks to pick when several accounts exist", () => {
    assert.deepEqual(
      decideBillingLink({ billingEnabled: false, accounts: [a, b], yes: true }),
      { action: "pick", accounts: [a, b] },
    );
  });

  it("opens the browser when the user has no billing account", () => {
    assert.deepEqual(
      decideBillingLink({ billingEnabled: false, accounts: [] }),
      { action: "browser" },
    );
  });
});
