import React from 'react';

type CommandDisclosure = {
    id: string;
    expanded: boolean;
    onToggle: (id: string) => void;
};

/** Each command follows its own run until the reader chooses its disclosure. */
export const useCommandDisclosure = ({ id, expanded: externalExpanded, onToggle }: CommandDisclosure) => {
    const [choice, setChoice] = React.useState<{
        id: string;
        externalExpanded: boolean;
        expanded: boolean | undefined;
    }>(() => ({ id, externalExpanded, expanded: externalExpanded ? true : undefined }));
    let selected = choice;
    if (choice.id !== id || choice.externalExpanded !== externalExpanded) {
        selected = { id, externalExpanded, expanded: choice.id === id ? externalExpanded : externalExpanded ? true : undefined };
        setChoice(selected);
    }
    const toggle = React.useCallback((expanded: boolean) => {
        const next = !expanded;
        setChoice({ id, externalExpanded, expanded: next });
        if (next !== externalExpanded) onToggle(id);
    }, [externalExpanded, id, onToggle]);
    return { choice: selected.expanded, toggle };
};
