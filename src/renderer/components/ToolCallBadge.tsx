import { useT } from '../i18n';
import styles from '../styles/ToolCallBadge.module.css';

const MUTATION_PREFIXES = ['create_', 'update_', 'patch_', 'delete_', 'upsert_', 'save_'];

function stripPrefix(name: string): string {
  const match = name.match(/^mcp__.+?__(.+)$/);
  return match ? match[1] : name;
}

/** Human label for a tool name. Labels live in toolBadge.tool.*; unknown
 *  tools show the raw name. Shared with the agent cards. */
export function toolLabel(name: string, t: (k: string) => string, has: (k: string) => boolean): string {
  const bare = stripPrefix(name);
  return has(`toolBadge.tool.${bare}`) ? t(`toolBadge.tool.${bare}`) : bare.replace(/_/g, ' ');
}

interface Props {
  name: string;
}

export function ToolCallBadge({ name }: Props) {
  const { t, has } = useT();
  const bare = stripPrefix(name);
  const label = toolLabel(name, t, has);
  const isMutation = MUTATION_PREFIXES.some(p => bare.startsWith(p)) || bare === 'toggle_integration';

  return (
    <span className={`${styles.badge} ${isMutation ? styles.mutation : styles.readonly}`}>
      <span className={styles.dot} />
      {label}
    </span>
  );
}
