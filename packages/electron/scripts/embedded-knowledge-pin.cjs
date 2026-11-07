const DEFAULT_REPOSITORY = 'https://github.com/NeoMei/embedded-knowledge';
const DEFAULT_REF = '65c0786b6d01647d4329c053515a10ecba5f1fdc';
const DEFAULT_COMMIT = '65c0786b6d01647d4329c053515a10ecba5f1fdc';

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
