const DEFAULT_REPOSITORY = 'https://github.com/NeoMei/embedded-knowledge';
const DEFAULT_REF = 'cd90b9a57abe85ad498e59b9be74e2748110c353';
const DEFAULT_COMMIT = 'cd90b9a57abe85ad498e59b9be74e2748110c353';

function knowledgeSourcePin(env = process.env) {
  const repository = env.OPENCHAMBER_EMBEDDED_KNOWLEDGE_REPO ?? DEFAULT_REPOSITORY;
  const ref = env.OPENCHAMBER_EMBEDDED_KNOWLEDGE_REF ?? DEFAULT_REF;
  const commit = env.OPENCHAMBER_EMBEDDED_KNOWLEDGE_COMMIT ?? DEFAULT_COMMIT;
  if (typeof repository !== 'string' || !repository.trim() || typeof ref !== 'string' || !ref.trim() || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error('Embedded-knowledge source requires a repository, ref and full lowercase 40-character commit');
  }
  return { repository, ref, commit };
}

module.exports = { knowledgeSourcePin };
