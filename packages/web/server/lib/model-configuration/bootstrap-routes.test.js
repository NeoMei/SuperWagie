import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { registerModelBootstrapRoutes } from './bootstrap-routes.js';

describe('model bootstrap routes', () => {
  it('returns an explicit unsupported response when the runtime is absent', async () => {
    const app = express();
    registerModelBootstrapRoutes(app);
    const response = await request(app).post('/api/model-configuration/bootstrap/discover').send({ source: 'session' });
    expect(response.status).toBe(501);
    expect(response.body).toEqual({ error: 'model_configuration_bootstrap_unsupported', code: 'model_configuration_bootstrap_unsupported' });
  });

  it('rejects oversized or malformed input without echoing it', async () => {
    const app = express();
    registerModelBootstrapRoutes(app, { bootstrapRuntime: { discover: async () => ({}) } });
    const response = await request(app).post('/api/model-configuration/bootstrap/discover').send({ source: 'other', key: 'fixture-secret' });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain('fixture-secret');
  });

  it('keeps imported keys on the local owner and passes platform identity to session operations', async () => {
    const app = express();
    const seen = [];
    registerModelBootstrapRoutes(app, {
      resolveIdentity: async () => ({ type: 'session', token: 'runtime-identity' }),
      bootstrapRuntime: {
        discover: async (input) => { seen.push(input); return { discoveryId: 'd1', source: input.source, models: [] }; },
        issueKey: async (input) => { seen.push(input); return { discoveryId: 'd2', source: 'session', models: [] }; },
      },
    });
    await request(app).post('/api/model-configuration/bootstrap/discover').send({ source: 'imported-key', key: 'uh_key_fixture' }).expect(200);
    await request(app).post('/api/model-configuration/bootstrap/discover').send({ source: 'session' }).expect(200);
    await request(app).post('/api/model-configuration/bootstrap/issue-key').send({}).expect(200);
    expect(seen[0].identity).toBeUndefined();
    expect(seen[0].owner).toEqual({ type: 'session', token: 'runtime-identity' });
    expect(seen[1].identity).toEqual({ type: 'session', token: 'runtime-identity' });
    expect(seen[1].owner).toEqual({ type: 'session', token: 'runtime-identity' });
    expect(seen[2].identity).toEqual({ type: 'session', token: 'runtime-identity' });
    expect(seen[2].owner).toEqual({ type: 'session', token: 'runtime-identity' });
  });

  it('allows an imported key with only the local UI owner', async () => {
    const app = express();
    const seen = [];
    registerModelBootstrapRoutes(app, {
      resolveIdentity: async () => null,
      resolveOwner: async () => ({ type: 'session', token: 'local-ui-owner' }),
      bootstrapRuntime: { discover: async (input) => { seen.push(input); return { discoveryId: 'd3', source: input.source, models: [] }; } },
    });
    await request(app).post('/api/model-configuration/bootstrap/discover').send({ source: 'imported-key', key: 'uh_key_fixture' }).expect(200);
    expect(seen[0].identity).toBeUndefined();
    expect(seen[0].owner).toEqual({ type: 'session', token: 'local-ui-owner' });
  });
});
