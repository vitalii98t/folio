import { useT, type I18n } from '../i18n';
import styles from '../styles/ConfirmationBar.module.css';

interface Props {
  toolName: string;
  input: Record<string, unknown>;
  /** How many more confirmations are queued behind this one */
  queueCount?: number;
  onConfirm: () => void;
  onReject: () => void;
}

/** Just the lookup half of the i18n context — what the formatting helpers need */
type Lookup = Pick<I18n, 't' | 'has'>;

/** Extract bare tool name from MCP prefixed name: mcp__finmap__create_operation → create_operation */
function stripPrefix(toolName: string): string {
  const match = toolName.match(/^mcp__.+?__(.+)$/);
  return match ? match[1] : toolName;
}

/** Human-readable type name (confirm.type.*); unknown types fall back to the raw value */
function typeLabel({ t, has }: Lookup, type: unknown): string {
  const name = String(type);
  return has(`confirm.type.${name}`) ? t(`confirm.type.${name}`) : name;
}

function formatDetails(i18n: Lookup, toolName: string, input: Record<string, unknown>): string {
  const { t } = i18n;
  const parts: string[] = [];
  const bare = stripPrefix(toolName);

  // For operations — show type + amount + comment
  if (bare.includes('operation')) {
    if (input.type !== undefined) parts.push(typeLabel(i18n, input.type));
    if (input.amount !== undefined) parts.push(t('confirm.details.amount', { amount: String(input.amount) }));
    if (input.comment) parts.push(`«${String(input.comment)}»`);
    if (input.id && bare !== 'create_operation') parts.push(t('confirm.details.id', { id: String(input.id).slice(-6) }));
  }
  // For categories/tags/projects/counterparties — show label and type
  else if (bare.includes('category') || bare.includes('tag') || bare.includes('project') || bare.includes('counterparty')) {
    if (input.type !== undefined) parts.push(typeLabel(i18n, input.type));
    if (input.label) parts.push(`«${String(input.label)}»`);
    if (input.id && !bare.startsWith('create_')) parts.push(t('confirm.details.id', { id: String(input.id).slice(-6) }));
  }
  // For invoices
  else if (bare.includes('invoice')) {
    if (input.invoiceNumber) parts.push(t('confirm.details.invoiceNumber', { n: String(input.invoiceNumber) }));
    if (input.label) parts.push(`«${String(input.label)}»`);
    if (input.id && !bare.startsWith('create_')) parts.push(t('confirm.details.id', { id: String(input.id).slice(-6) }));
  }
  // For exchange rates
  else if (bare.includes('exchange_rate')) {
    if (input.from && input.to) parts.push(`${input.from} → ${input.to}`);
    if (input.rate) parts.push(t('confirm.details.rate', { rate: String(input.rate) }));
  }
  // For webhooks
  else if (bare.includes('webhook')) {
    if (input.name) parts.push(`«${String(input.name)}»`);
    if (input.url) parts.push(String(input.url));
  }
  // For integrations
  else if (bare.includes('integration')) {
    if (input.serviceName) parts.push(`«${String(input.serviceName)}»`);
  }
  // For http_request
  else if (bare === 'http_request') {
    if (input.method) parts.push(String(input.method));
    if (input.url) parts.push(String(input.url));
  }

  return parts.join(' · ');
}

export function ConfirmationBar({ toolName, input, queueCount = 0, onConfirm, onReject }: Props) {
  const { t, has } = useT();
  const bare = stripPrefix(toolName);
  // Human-readable labels for all mutation tools live in confirm.tool.*; unknown tools show the raw name
  const label = has(`confirm.tool.${bare}`) ? t(`confirm.tool.${bare}`) : bare.replace(/_/g, ' ');
  const details = formatDetails({ t, has }, toolName, input);
  const isDelete = bare.includes('delete');

  return (
    <div className={`${styles.bar} ${isDelete ? styles.danger : ''}`}>
      <div className={styles.info}>
        <span className={styles.label}>{label}</span>
        {details && <span className={styles.details}>{details}</span>}
        {queueCount > 0 && (
          <span className={styles.details} title={t('confirm.queuedTitle')}>
            {t('confirm.queued', { n: queueCount })}
          </span>
        )}
      </div>
      <div className={styles.actions}>
        <button className={styles.confirmBtn} onClick={onConfirm}>
          {t('confirm.confirmBtn')}
        </button>
        <button className={styles.rejectBtn} onClick={onReject}>
          {t('confirm.rejectBtn')}
        </button>
      </div>
    </div>
  );
}
