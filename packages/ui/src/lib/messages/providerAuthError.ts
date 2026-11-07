type ModelErrorSummaryKey = 'chat.assistantError.modelNotConfigured' | 'chat.assistantError.modelAuthenticationFailed'
  | 'chat.assistantError.freeUsageLimited' | 'chat.assistantError.rateLimited';

const isLikelyProviderAuthFailure = (value: string): boolean => {
  const detail = value.toLowerCase().trim();
  if (!detail) {
    return false;
  }

  if (
    detail.includes("token refresh failed") ||
    detail.includes("unauthorized") ||
    detail.includes("invalid token") ||
    detail.includes("expired token") ||
    detail.includes("invalid api key") ||
    detail.includes("incorrect api key") ||
    detail.includes("authentication failed for this provider")
  ) {
    return true;
  }

  const hasOauth = detail.includes("oauth");
  const hasOauthFailure =
    detail.includes("failed") || detail.includes("invalid") || detail.includes("expired");
  if (hasOauth && hasOauthFailure) {
    return true;
  }

  const has401 = /\b401\b/.test(detail);
  const hasAuthContext =
    detail.includes("auth") || detail.includes("token") || detail.includes("unauthorized");

  return has401 && hasAuthContext;
};

/** Known model failures; rate limits stay distinct from credentials, and unrelated errors stay unclassified. */
export const modelErrorSummaryKey = (name: string | undefined, detail: string, status?: number): ModelErrorSummaryKey | null => {
  const normalized = detail.toLowerCase();
  if (normalized.includes('free usage limit reached')) {
    return 'chat.assistantError.freeUsageLimited';
  }
  if (status === 429 || /\brate[ _-]?limit(?:ed| exceeded)?\b|\btoo many requests\b/.test(normalized)) {
    return 'chat.assistantError.rateLimited';
  }
  if (/\b(?:no|missing) api[ _-]?key\b|\bapi[ _-]?key (?:is )?(?:missing|required|not (?:found|configured))\b/.test(normalized)) {
    return 'chat.assistantError.modelNotConfigured';
  }
  if (name === 'ProviderAuthError' || isLikelyProviderAuthFailure(detail)) {
    return 'chat.assistantError.modelAuthenticationFailed';
  }
  return null;
};
