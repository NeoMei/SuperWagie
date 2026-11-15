import { createContext } from 'react';

export type CommandMemberStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';

export type CommandMemberState = {
    status: CommandMemberStatus;
};

/** Members keep their runtime lifecycle mounted while the group owns disclosure. */
export const CommandGroupContext = createContext<{
    expanded: boolean;
    renderOutput: boolean;
    report: (id: string, state: CommandMemberState) => void;
} | null>(null);
