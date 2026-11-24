import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import type { Session } from '@/lib/opencode/model';
import { isLeadSession, leadParentId, leadTargets } from '@/lib/sessionLead';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { mutateLead, useLeadAvailability, useLeadStrings } from '@/sync/session-lead';

export function SessionLeadMenu({ session, directory, open, Item, Sub, SubTrigger, SubContent }: {
  session: Session;
  directory: string;
  open: boolean;
  Item: React.ElementType;
  Sub: React.ElementType;
  SubTrigger: React.ElementType;
  SubContent: React.ElementType;
}) {
  const text = useLeadStrings();
  const available = useLeadAvailability(open && Boolean(directory) && !isSpaceDirectory(directory));
  const sessions = useGlobalSessionsStore((state) => available ? state.activeSessions : undefined);
  if (!available) return null;

  const leading = isLeadSession(session);
  const parent = leadParentId(session);
  const targets = parent || leading ? [] : leadTargets(sessions ?? [], { ...session, directory });
  const run = (action: Parameters<typeof mutateLead>[2]) => {
    void mutateLead(session.id, directory, action).catch((error: Error) => {
      toast.error(text['sessions.sidebar.session.lead.failed'], { description: error.message });
    });
  };
  return (
    <>
      <Item onClick={() => run({ action: parent ? 'takeOver' : leading ? 'unmark' : 'mark' })}>
        <Icon name="team" className="me-1 size-4" />
        {parent ? text.takeOver : text[leading ? 'sessions.sidebar.session.menu.stopLead' : 'sessions.sidebar.session.menu.makeLead']}
      </Item>
      {targets.length > 0 ? (
        <Sub>
          <SubTrigger>
            <Icon name="route" className="me-1 size-4" />
            {text['sessions.sidebar.session.menu.handToLead']}
          </SubTrigger>
          <SubContent>
            {targets.map((target) => (
              <Item key={target.id} onClick={() => run({ action: 'handover', leadId: target.id })}>
                <span dir="auto" className="truncate">{target.title}</span>
              </Item>
            ))}
          </SubContent>
        </Sub>
      ) : null}
    </>
  );
}
