/** Upstream error text may echo a server-owned credential or submitted content. */
export const configuredProviderError = (operation) => Object.assign(
  new Error(`The configured ${operation} service rejected the request or could not be reached. Check Model configuration and try again.`),
  { code: 'model_configuration_provider_failed', status: 502 },
);
