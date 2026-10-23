import express from 'express';
import { ModelConfigurationError } from './runtime.js';

/** Installed behind UI auth, before the generic OpenCode proxy. */
export const registerModelConfigurationRoutes = (app, { runtime }) => {
  const parseBody = express.json({ limit: '64kb' });
  app.use('/api/model-configuration', (request, response, next) => {
    parseBody(request, response, (error) => {
      if (error) {
        response.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'model_configuration_invalid_input', code: 'model_configuration_invalid_input' });
        return;
      }
      next();
    });
  });
  const route = (handler) => async (request, response) => {
    try { response.json(await handler(request)); }
    catch (error) {
      if (error instanceof ModelConfigurationError) response.status(error.status).json({ error: error.code, code: error.code });
      else response.status(500).json({ error: 'model_configuration_failed' });
    }
  };
  app.get('/api/model-configuration', route(() => runtime.getPublicConfiguration()));
  app.post('/api/model-configuration/connections', route((request) => runtime.saveConnection(request.body)));
  app.post('/api/model-configuration/connections/:id/test', route((request) => runtime.testConnection(request.params.id, request.body)));
  app.delete('/api/model-configuration/connections/:id', route((request) => runtime.removeConnection(request.params.id, request.body)));
  app.put('/api/model-configuration/bindings/:purpose', route((request) => runtime.saveBinding(request.params.purpose, request.body)));
  app.post('/api/model-configuration/bindings/:purpose/test', route((request) => runtime.testBinding(request.params.purpose, request.body)));
};
