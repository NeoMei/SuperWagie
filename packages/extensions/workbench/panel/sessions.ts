import type { GuestProject, GuestSessionRecord } from '@openchamber/sdk';

/** The fixed root every creation work lives under; a work is its own project. */
const CREATION_ROOT = '/Documents/SuperWagie/';

export const isCreationProject = (project: GuestProject): boolean =>
  project.directory.replace(/\\/g, '/').includes(CREATION_ROOT);

export const creationProjectIds = (projects: readonly GuestProject[]): string[] =>
  projects.filter(isCreationProject).map((project) => project.id);

/** Live sessions of the open project plus the creation works' sessions, newest
 *  first and deduplicated by id. */
export const mergeSessions = (
  live: readonly GuestSessionRecord[],
  creation: readonly GuestSessionRecord[],
): GuestSessionRecord[] => {
  const byId = new Map<string, GuestSessionRecord>();
  for (const session of creation) byId.set(session.id, session);
  // The live subscription is authoritative for the open project: its copy wins
  // over a snapshot fetched at the same time.
  for (const session of live) byId.set(session.id, session);
  return [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt);
};
