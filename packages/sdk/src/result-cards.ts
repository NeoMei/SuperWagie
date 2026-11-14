/** Passive results already present in the current project. They authorize no file operation. */
export type GuestResultCard = {
  title: string;
  text?: string;
  version?: string;
  path?: string;
  taskId?: string;
};
export type GuestResultCardsRequest = { directory: string; cards: GuestResultCard[] };
export const GUEST_RESULT_CARDS_MAX = 8;
