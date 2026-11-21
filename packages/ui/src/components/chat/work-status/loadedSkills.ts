import { z } from 'zod';
import type { Message } from '@/lib/opencode/model';
import { isSkillTool, toolDescription } from '@/lib/opencode/tools';
import type { State } from '@/sync/types';

type LoadedSkill = { id: string; name: string };
const skillInput = z.object({ id: z.string().trim().min(1) });

export const selectLoadedSkills = (messages: readonly Message[], state: Pick<State, 'part'>): LoadedSkill[] => {
  const loaded = new Map<string, LoadedSkill>();
  const add = (id: string, name: string): void => {
    const existing = loaded.get(id);
    if (!existing || existing.name === id) loaded.set(id, { id, name });
  };

  for (const message of messages) {
    if (message.role === 'skill') {
      add(message.skill, message.name.trim() || message.skill);
    } else if (message.role === 'assistant') {
      for (const part of state.part[message.id] ?? []) {
        if (part.type !== 'tool' || !isSkillTool(part.tool) || part.state.status !== 'completed' || part.executed === false) continue;
        const input = skillInput.safeParse(part.state.input);
        if (!input.success) continue;
        const description = toolDescription(part.tool, part.state.input, part.state.metadata);
        add(input.data.id, description?.kind === 'text' ? description.value : input.data.id);
      }
    }
  }
  return [...loaded.values()];
};

export const sameLoadedSkills = (left: readonly LoadedSkill[], right: readonly LoadedSkill[]): boolean => (
  left.length === right.length && left.every((skill, index) => skill.id === right[index].id && skill.name === right[index].name)
);
