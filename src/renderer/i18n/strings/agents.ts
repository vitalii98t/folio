import type { StringBundle } from '../index';

const strings: StringBundle = {
  uk: {
    'agents.headRunning': 'Агенти працюють: {running} з {total}',
    'agents.headDone': 'Агенти завершили: {total}',
    'agents.tools': 'тулів: {n}',
    'agents.type.finmap-analyst': 'Аналітик Finmap',
    'agents.type.statement-reconciler': 'Звірка виписки',
    'agents.type.web-researcher': 'Веб-дослідник',
    'agents.type.general-purpose': 'Загальний агент',
    'agents.used': 'агентів: {n}',
    'agents.summaryLine': '{status} {type} — {description} ({tools}, {duration})',
  },
  en: {
    'agents.headRunning': 'Agents running: {running} of {total}',
    'agents.headDone': 'Agents finished: {total}',
    'agents.tools': 'tools: {n}',
    'agents.type.finmap-analyst': 'Finmap analyst',
    'agents.type.statement-reconciler': 'Statement reconciler',
    'agents.type.web-researcher': 'Web researcher',
    'agents.type.general-purpose': 'General agent',
    'agents.used': 'agents: {n}',
    'agents.summaryLine': '{status} {type} — {description} ({tools}, {duration})',
  },
};

export default strings;
