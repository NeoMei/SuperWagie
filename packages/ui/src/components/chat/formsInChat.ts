import React from 'react';

type FormDockMode = 'dock' | 'reading' | 'in-chat';

export const FormDockModeContext = React.createContext<FormDockMode>('dock');

export const resolveFormDockMode = (formsInChat: boolean, readingHistory: boolean): FormDockMode => {
    if (formsInChat) return 'in-chat';
    return readingHistory ? 'reading' : 'dock';
};

export const resolveFormsInChat = ({
    enabled,
    pinned,
    transcriptShown,
}: {
    enabled: boolean;
    pinned: boolean;
    transcriptShown: boolean;
}): boolean => enabled && !pinned && transcriptShown;
