export const mobileOfficialMode = (search: string): boolean => new URLSearchParams(search).get('view') === 'official';
export const mobileOfficialProject = (search: string): string | null => {
  const values = new URLSearchParams(search).getAll('projectId');
  if (values.length === 0) return null;
  const value = values[0];
  return values.length === 1 && value && value.length <= 200 && Array.from(value).every((character) => character.charCodeAt(0) >= 32) ? value : '';
};
