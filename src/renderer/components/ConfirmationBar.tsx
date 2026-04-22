import styles from '../styles/ConfirmationBar.module.css';

interface Props {
  toolName: string;
  input: Record<string, unknown>;
  onConfirm: () => void;
  onReject: () => void;
}

/** Human-readable labels for all mutation tools */
const ACTION_LABELS: Record<string, string> = {
  // Operations
  create_operation: 'Створити операцію',
  patch_operation: 'Змінити операцію',
  delete_operation: 'Видалити операцію',
  // Categories
  create_category: 'Створити категорію',
  update_category: 'Змінити категорію',
  delete_category: 'Видалити категорію',
  // Tags
  create_tag: 'Створити тег',
  update_tag: 'Змінити тег',
  delete_tag: 'Видалити тег',
  // Projects
  create_project: 'Створити проект',
  update_project: 'Змінити проект',
  delete_project: 'Видалити проект',
  // Counterparties
  create_counterparty: 'Створити контрагента',
  update_counterparty: 'Змінити контрагента',
  delete_counterparty: 'Видалити контрагента',
  // Invoices
  create_invoice: 'Створити інвойс',
  update_invoice: 'Змінити інвойс',
  delete_invoice: 'Видалити інвойс',
  create_invoice_good: 'Створити товар/послугу',
  update_invoice_good: 'Змінити товар/послугу',
  delete_invoice_good: 'Видалити товар/послугу',
  create_invoice_company: 'Створити компанію для інвойсів',
  update_invoice_company: 'Змінити компанію для інвойсів',
  delete_invoice_company: 'Видалити компанію для інвойсів',
  // Exchange rates
  upsert_exchange_rate: 'Зберегти курс валют',
  delete_exchange_rate: 'Видалити курс валют',
  // Webhooks
  create_webhook: 'Створити вебхук',
  update_webhook: 'Змінити вебхук',
  delete_webhook: 'Видалити вебхук',
  // Integrations
  save_integration: 'Зберегти інтеграцію',
  delete_integration: 'Видалити інтеграцію',
  toggle_integration: 'Перемкнути інтеграцію',
  // HTTP
  http_request: 'Зовнішній запит',
};

/** Extract bare tool name from MCP prefixed name: mcp__finmap__create_operation → create_operation */
function stripPrefix(toolName: string): string {
  const match = toolName.match(/^mcp__[^_]+__(.+)$/);
  return match ? match[1] : toolName;
}

/** Human-readable type name */
function typeLabel(type: unknown): string {
  switch (String(type)) {
    case 'income': return 'Дохід';
    case 'expense': return 'Витрата';
    case 'transfer': return 'Переказ';
    case 'suppliers': return 'Постачальник';
    case 'creditors': return 'Кредитор';
    case 'debitors': return 'Дебітор';
    case 'investors': return 'Інвестор';
    case 'employees': return 'Співробітник';
    case 'owners': return 'Власник';
    case 'tax-organisations': return 'Податковий орган';
    default: return String(type);
  }
}

function formatDetails(toolName: string, input: Record<string, unknown>): string {
  const parts: string[] = [];
  const bare = stripPrefix(toolName);

  // For operations — show type + amount + comment
  if (bare.includes('operation')) {
    if (input.type !== undefined) parts.push(typeLabel(input.type));
    if (input.amount !== undefined) parts.push(`${input.amount} ₴`);
    if (input.comment) parts.push(`«${String(input.comment)}»`);
    if (input.id && bare !== 'create_operation') parts.push(`ID: ${String(input.id).slice(-6)}`);
  }
  // For categories/tags/projects/counterparties — show label and type
  else if (bare.includes('category') || bare.includes('tag') || bare.includes('project') || bare.includes('counterparty')) {
    if (input.type !== undefined) parts.push(typeLabel(input.type));
    if (input.label) parts.push(`«${String(input.label)}»`);
    if (input.id && !bare.startsWith('create_')) parts.push(`ID: ${String(input.id).slice(-6)}`);
  }
  // For invoices
  else if (bare.includes('invoice')) {
    if (input.invoiceNumber) parts.push(`№ ${String(input.invoiceNumber)}`);
    if (input.label) parts.push(`«${String(input.label)}»`);
    if (input.id && !bare.startsWith('create_')) parts.push(`ID: ${String(input.id).slice(-6)}`);
  }
  // For exchange rates
  else if (bare.includes('exchange_rate')) {
    if (input.from && input.to) parts.push(`${input.from} → ${input.to}`);
    if (input.rate) parts.push(`курс ${input.rate}`);
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

export function ConfirmationBar({ toolName, input, onConfirm, onReject }: Props) {
  const bare = stripPrefix(toolName);
  const label = ACTION_LABELS[bare] ?? bare.replace(/_/g, ' ');
  const details = formatDetails(toolName, input);
  const isDelete = bare.includes('delete');

  return (
    <div className={`${styles.bar} ${isDelete ? styles.danger : ''}`}>
      <div className={styles.info}>
        <span className={styles.label}>{label}</span>
        {details && <span className={styles.details}>{details}</span>}
      </div>
      <div className={styles.actions}>
        <button className={styles.confirmBtn} onClick={onConfirm}>
          Підтвердити
        </button>
        <button className={styles.rejectBtn} onClick={onReject}>
          Скасувати
        </button>
      </div>
    </div>
  );
}
