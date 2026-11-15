import { createContext } from 'react';

export type CommandMemberStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'unknown'
    | 'waitingPermission' | 'waitingAnswer' | 'retrying' | 'stopping';

export type CommandMemberState = {
    status: CommandMemberStatus;
    start?: number;
    end?: number;
};

/** Members keep their runtime lifecycle mounted while the group owns disclosure. */
export const CommandGroupContext = createContext<{
    expanded: boolean;
    report: (id: string, state: CommandMemberState) => void;
} | null>(null);
