import { z } from 'zod';

const identifier = z.string().min(1).max(200);
const timestamp = z.string().max(50).datetime({ offset: true });
const upstreamKeysSchema = z.array(z.object({
  id: identifier,
  credential_kind: z.literal('api_key'),
  name: z.string().min(1).max(128),
  actor_id: identifier,
  account_id: identifier,
  origin_product_id: identifier,
  instance_id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  created_at: timestamp,
  expires_at: timestamp.nullable(),
  revoked_at: timestamp.nullable(),
})).max(500);

/** UniHub owns instance authorization. Only safe metadata for this actor is public. */
export const projectPlatformApiKeys = (raw, { accountId, userId }) => {
  const parsed = upstreamKeysSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    accountId,
    keys: parsed.data
      .filter((key) => key.account_id === accountId && key.actor_id === userId && key.origin_product_id === 'superwagie')
      .map((key) => ({ id: key.id, name: key.name, createdAt: key.created_at, expiresAt: key.expires_at, revokedAt: key.revoked_at })),
    // Finance roles receive account-wide rows. Filtering must not erase the upstream cap.
    incomplete: parsed.data.length === 500,
  };
};
