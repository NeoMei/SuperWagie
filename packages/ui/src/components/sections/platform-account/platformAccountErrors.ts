import type { I18nKey } from '@/lib/i18n';
import { PlatformAccountError } from '@/lib/platformAccount';

export const platformAccountErrorKey = (error: PlatformAccountError | null, fallback: I18nKey = 'platformAccount.failed'): I18nKey => {
  if (!error) return fallback;
  switch (error.code) {
    case 'invalid_credentials': case 'invalid_password': return 'platformAccount.error.credentials';
    case 'interaction_required': return 'platformAccount.error.interaction';
    case 'rate_limited': return 'platformAccount.error.rateLimited';
    case 'registration_conflict': return 'platformAccount.error.registrationConflict';
    case 'authorization_result_unknown': return 'platformAccount.error.authorizationUnknown';
    case 'platform_registration_unknown': return 'platformAccount.registrationUnknown';
    case 'platform_session_expired': case 'unauthenticated': return 'platformAccount.expired';
    case 'platform_account_changed': case 'platform_session_changed': return 'platformAccount.error.accountChanged';
    case 'platform_billing_forbidden': case 'platform_account_forbidden': case 'forbidden': return 'platformAccount.error.forbidden';
    case 'platform_scope_required': return 'platformAccount.error.scope';
    case 'platform_operation_pending': case 'operation_pending': return 'platformAccount.error.operationPending';
    case 'insufficient_funds': case 'insufficient_credits': return 'platformAccount.error.insufficientFunds';
    case 'platform_amount_invalid': return 'platformAccount.error.amount';
    case 'platform_offer_unavailable': case 'unsupported_plan_change': return 'platformAccount.error.offer';
    case 'platform_membership_active': return 'platformAccount.membershipActive';
    case 'payment_not_configured': return 'platformAccount.paymentUnconfigured';
    case 'invalid_request': case 'platform_request_invalid': return 'platformAccount.error.invalidRequest';
    case 'platform_idempotency_conflict': case 'idempotency_conflict': return 'platformAccount.error.idempotency';
    case 'platform_headless_unconfigured': case 'client_not_enabled': return 'platformAccount.error.headless';
    case 'platform_password_unknown': return 'platformAccount.profilePasswordFailed';
    default: return fallback;
  }
};
