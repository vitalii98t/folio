import { useEffect, useState } from 'react';
import type { AgentEvent, AgentRunSummary } from '../../shared/types';
import { useT } from '../i18n';
import { toolLabel } from './ToolCallBadge';
import styles from '../styles/AgentsPanel.module.css';

/** Live state of one subagent inside the current reply. */
export interface AgentRun {
  id: string;
  type: string;
  description: string;
  status: 'running' | 'done' | 'failed';
  tool?: string;
  toolCount: number;
  tokens?: number;
  startedAt: number;
  endedAt?: number;
}

/** Fold one AgentEvent from main into the list. Pure — safe for setState. */
export function applyAgentEvent(list: AgentRun[], ev: AgentEvent): AgentRun[] {
  if (ev.kind === 'start') {
    if (list.some(a => a.id === ev.id)) return list;
    return [...list, {
      id: ev.id, type: ev.type, description: ev.description,
      status: 'running', toolCount: 0, startedAt: ev.startedAt,
    }];
  }
  return list.map(a => {
    if (a.id !== ev.id) return a;
    if (ev.kind === 'progress') {
      return {
        ...a,
        tool: ev.tool ?? a.tool,
        // task_progress carries the authoritative count; a bare tool event
        // (older CLI) just bumps it.
        toolCount: ev.toolCount ?? (ev.tool && ev.tool !== a.tool ? a.toolCount + 1 : a.toolCount),
        tokens: ev.tokens ?? a.tokens,
      };
    }
    return {
      ...a,
      status: ev.ok ? 'done' : 'failed',
      tool: undefined,
      toolCount: ev.toolCount ?? a.toolCount,
      tokens: ev.tokens ?? a.tokens,
      endedAt: ev.endedAt,
    };
  });
}

export function summariseAgents(list: AgentRun[]): AgentRunSummary[] {
  return list.map(a => ({
    type: a.type,
    description: a.description,
    ok: a.status === 'done',
    toolCount: a.toolCount,
    durationMs: (a.endedAt ?? Date.now()) - a.startedAt,
  }));
}

/** Label for a subagent type — Folio's own agents are translated, anything
 *  else (general-purpose, future CLI agents) shows its raw name. */
export function useAgentTypeLabel() {
  const { t, has } = useT();
  return (type: string) => (has(`agents.type.${type}`) ? t(`agents.type.${type}`) : type);
}

const formatElapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

interface Props {
  agents: AgentRun[];
}

/** Compact live list of the subagents Claude launched for this reply. */
export function AgentsPanel({ agents }: Props) {
  const { t, has } = useT();
  const typeLabel = useAgentTypeLabel();
  const running = agents.filter(a => a.status === 'running').length;

  // Tick once a second while anything runs so elapsed times move.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (running === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  if (agents.length === 0) return null;

  return (
    <div className={styles.panel} aria-live="polite">
      <div className={styles.head}>
        <span className={styles.headIcon}>✦</span>
        {running > 0
          ? t('agents.headRunning', { running, total: agents.length })
          : t('agents.headDone', { total: agents.length })}
      </div>
      {agents.map(a => (
        <div key={a.id} className={`${styles.row} ${a.status !== 'running' ? styles.rowDone : ''}`}>
          <span className={`${styles.status} ${a.status === 'failed' ? styles.statusFailed : ''}`}>
            {a.status === 'running' ? <span className={styles.spinner} /> : a.status === 'done' ? '✓' : '✕'}
          </span>
          <span className={styles.type}>{typeLabel(a.type)}</span>
          <span className={styles.desc} title={a.description}>{a.description}</span>
          {a.status === 'running' && a.tool && (
            <span className={styles.tool}>{toolLabel(a.tool, t, has)}</span>
          )}
          <span className={styles.meta}>
            {a.toolCount > 0 ? `${t('agents.tools', { n: a.toolCount })} · ` : ''}
            {formatElapsed((a.endedAt ?? now) - a.startedAt)}
          </span>
        </div>
      ))}
    </div>
  );
}
