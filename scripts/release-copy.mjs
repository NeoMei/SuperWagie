const PROHIBITED_NAME = /openchamber|opencode/i;

export const assertSuperWagieReleaseCopy = (text, source) => {
  const match = PROHIBITED_NAME.exec(text);
  if (!match) return;
  const line = text.slice(0, match.index).split('\n').length;
  throw new Error(`${source}:${line} contains the prohibited name "${match[0]}". Describe the change in SuperWagie terms.`);
};
