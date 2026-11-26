/** Retired public services require an explicit opt-in for private instances and fixtures. */
export const isPlatformServiceEnabled = (env = process.env) =>
  env.OPENCHAMBER_UNIHUB_MODE === 'on' && env.OPENCHAMBER_UNIHUB_DISABLED !== '1';

export const hasPlatformOwnerPolicy = (env = process.env) =>
  env.OPENCHAMBER_UNIHUB_INSTANCE_OWNER_ISSUER !== undefined
  || env.OPENCHAMBER_UNIHUB_INSTANCE_OWNER_USER_ID !== undefined;
