export class OpenChamberControlError extends Error {
  constructor(message, statusCode = 500, details = {}) {
    super(message);
    this.name = 'OpenChamberControlError';
    this.statusCode = statusCode;
    Object.assign(this, details);
  }
}

export const controlErrorFields = (cause) => (cause == null ? undefined : Object(cause));

export const asControlError = (error, fallbackMessage, fallbackStatus = 500) => {
  if (error instanceof OpenChamberControlError) return error;
  const message = error instanceof Error ? error.message : fallbackMessage;
  return new OpenChamberControlError(message || fallbackMessage, Number(error?.statusCode) || Number(error?.status) || fallbackStatus, {
    ...(error?.goalConfigured === true ? { goalConfigured: true } : {}),
  });
};
