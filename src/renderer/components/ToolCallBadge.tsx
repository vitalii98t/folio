import styles from '../styles/ToolCallBadge.module.css';

const TOOL_LABELS: Record<string, string> = {
  // Read
  get_accounts: 'Рахунки',
  get_operations: 'Пошук операцій',
  get_operation_details: 'Деталі операції',
  get_categories: 'Категорії',
  get_counterparties: 'Контрагенти',
  get_projects: 'Проекти',
  get_tags: 'Теги',
  get_currencies: 'Валюти',
  get_exchange_rates: 'Курси валют',
  get_invoices: 'Інвойси',
  get_invoice_details: 'Деталі інвойсу',
  get_invoice_goods: 'Товари/послуги',
  get_invoice_companies: 'Компанії для інвойсів',
  get_webhooks: 'Вебхуки',
  list_integrations: 'Інтеграції',
  http_request: 'Зовнішній запит',
  // Mutations
  create_operation: 'Створення операції',
  patch_operation: 'Зміна операції',
  delete_operation: 'Видалення операції',
  create_category: 'Створення категорії',
  update_category: 'Зміна категорії',
  delete_category: 'Видалення категорії',
  create_tag: 'Створення тегу',
  update_tag: 'Зміна тегу',
  delete_tag: 'Видалення тегу',
  create_project: 'Створення проекту',
  update_project: 'Зміна проекту',
  delete_project: 'Видалення проекту',
  create_counterparty: 'Створення контрагента',
  update_counterparty: 'Зміна контрагента',
  delete_counterparty: 'Видалення контрагента',
  create_invoice: 'Створення інвойсу',
  update_invoice: 'Зміна інвойсу',
  delete_invoice: 'Видалення інвойсу',
  create_invoice_good: 'Створення товару',
  update_invoice_good: 'Зміна товару',
  delete_invoice_good: 'Видалення товару',
  create_invoice_company: 'Створення компанії',
  update_invoice_company: 'Зміна компанії',
  delete_invoice_company: 'Видалення компанії',
  upsert_exchange_rate: 'Збереження курсу',
  delete_exchange_rate: 'Видалення курсу',
  create_webhook: 'Створення вебхука',
  update_webhook: 'Зміна вебхука',
  delete_webhook: 'Видалення вебхука',
  save_integration: 'Збереження інтеграції',
  toggle_integration: 'Перемикання інтеграції',
  delete_integration: 'Видалення інтеграції',
};

const MUTATION_PREFIXES = ['create_', 'update_', 'patch_', 'delete_', 'upsert_', 'save_'];

function stripPrefix(name: string): string {
  const match = name.match(/^mcp__[^_]+__(.+)$/);
  return match ? match[1] : name;
}

interface Props {
  name: string;
}

export function ToolCallBadge({ name }: Props) {
  const bare = stripPrefix(name);
  const label = TOOL_LABELS[bare] ?? bare.replace(/_/g, ' ');
  const isMutation = MUTATION_PREFIXES.some(p => bare.startsWith(p)) || bare === 'toggle_integration';

  return (
    <span className={`${styles.badge} ${isMutation ? styles.mutation : styles.readonly}`}>
      <span className={styles.dot} />
      {label}
    </span>
  );
}
