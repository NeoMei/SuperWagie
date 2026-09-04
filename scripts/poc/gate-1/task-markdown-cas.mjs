export function createRevisionedMarkdown({ read, write, initialRevision = 1 }) {
  let revision = initialRevision;

  return Object.freeze({
    get revision() { return revision; },

    externalWrite(content) {
      write(content);
      revision += 1;
      return revision;
    },

    submit({ expectedRevision, update }) {
      if (expectedRevision !== revision) {
        return Object.freeze({
          ok: false,
          code: 'SW_WORKSPACE_REVISION_CONFLICT',
          currentRevision: revision,
        });
      }
      const current = read();
      const next = update(current);
      if (typeof next !== 'string') throw new TypeError('Markdown update must return a string');
      write(next);
      revision += 1;
      return Object.freeze({ ok: true, revision });
    },
  });
}
