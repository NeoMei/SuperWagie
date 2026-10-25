const SUMMARY_MAX_CHARS = 80;

/** Strip common markdown syntax so the header preview reads as plain text. */
const stripMarkdown = (text: string): string =>
    text
        .replace(/<!--\s*-->/g, '')
        .replace(/```[\w]*\n?([\s\S]*?)```/g, (_, inner: string) => inner.trim())
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
        .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^>\s?/gm, '')
        .replace(/^[-*_]{3,}\s*$/gm, '')
        .trim();

export const getReasoningSummary = (text: string): string => {
    const flat = stripMarkdown(text).replace(/\s+/g, ' ').trim();
    if (flat.length <= SUMMARY_MAX_CHARS) return flat;
    const cut = flat.lastIndexOf(' ', SUMMARY_MAX_CHARS);
    const end = cut > 0 ? cut : SUMMARY_MAX_CHARS;
    return `${flat.substring(0, end).trimEnd()}…`;
};

export const getCompactReasoningSummary = (text: string): string => {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (/^#{1,6}\s+\S/.test(lines[index])) return getReasoningSummary(lines[index]);
    }
    return getReasoningSummary(lines.at(-1) ?? '');
};
