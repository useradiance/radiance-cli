/**
 * Maps Radiance module auth provider ids (`password`, `google.com`, …) to the
 * `firebase.json` → `auth.providers` shape that `firebase deploy --only auth` understands.
 *
 * Apple Sign-In is not yet configurable through firebase-tools auth deploy.
 */
export function buildAuthProvidersConfig(
  providerIds: string[],
  meta: { displayName: string; supportEmail?: string },
): { providers: Record<string, unknown> } | null {
  const unique = [...new Set(providerIds)];
  const providers: Record<string, unknown> = {};

  if (unique.includes("password")) providers.emailPassword = true;
  if (unique.includes("anonymous")) providers.anonymous = true;

  if (unique.includes("google.com") && meta.supportEmail) {
    providers.googleSignIn = {
      oAuthBrandDisplayName: meta.displayName,
      supportEmail: meta.supportEmail,
    };
  }

  return Object.keys(providers).length > 0 ? { providers } : null;
}

/** Provider ids the Firebase CLI auth deploy cannot enable yet. */
export function unsupportedAuthProviders(providerIds: string[]): string[] {
  return [...new Set(providerIds)].filter((id) => id === "apple.com");
}

/** Convert radiance auth option choices (`email`, `google`, …) to Identity Toolkit ids. */
export function authChoicesToProviderIds(choices: string[]): string[] {
  const map: Record<string, string> = {
    email: "password",
    google: "google.com",
    apple: "apple.com",
    anonymous: "anonymous",
  };
  return choices.map((choice) => map[choice] ?? choice).filter(Boolean);
}
