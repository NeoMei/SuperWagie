import React from 'react';
import { FilesView } from './FilesView';

interface CommitControls {
  setVisible: (visible: boolean) => void;
  commitNext: (run: () => void) => void;
}

interface CommitBoundaryProps {
  mode: React.ComponentProps<typeof FilesView>['mode'];
  receiveControls: (controls: CommitControls) => void;
}

export function FilesViewCommitBoundary({ mode, receiveControls }: CommitBoundaryProps) {
  const [visible, setVisible] = React.useState(true);
  const [action, setAction] = React.useState<{ run: () => void } | null>(null);
  receiveControls({ setVisible, commitNext: (run) => setAction({ run }) });
  React.useLayoutEffect(() => { action?.run(); }, [action]);
  return <FilesView mode={mode} visible={visible} />;
}
