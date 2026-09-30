import type { StringBundle } from '../index';

const strings: StringBundle = {
  uk: {
    // Operations
    'confirm.tool.create_operation': 'Створити операцію',
    'confirm.tool.patch_operation': 'Змінити операцію',
    'confirm.tool.delete_operation': 'Видалити операцію',
    // Categories
    'confirm.tool.create_category': 'Створити категорію',
    'confirm.tool.update_category': 'Змінити категорію',
    'confirm.tool.delete_category': 'Видалити категорію',
    // Tags
    'confirm.tool.create_tag': 'Створити тег',
    'confirm.tool.update_tag': 'Змінити тег',
    'confirm.tool.delete_tag': 'Видалити тег',
    // Projects
    'confirm.tool.create_project': 'Створити проект',
    'confirm.tool.update_project': 'Змінити проект',
    'confirm.tool.delete_project': 'Видалити проект',
    // Counterparties
    'confirm.tool.create_counterparty': 'Створити контрагента',
    'confirm.tool.update_counterparty': 'Змінити контрагента',
    'confirm.tool.delete_counterparty': 'Видалити контрагента',
    // Invoices
    'confirm.tool.create_invoice': 'Створити інвойс',
    'confirm.tool.update_invoice': 'Змінити інвойс',
    'confirm.tool.delete_invoice': 'Видалити інвойс',
    'confirm.tool.create_invoice_good': 'Створити товар/послугу',
    'confirm.tool.update_invoice_good': 'Змінити товар/послугу',
    'confirm.tool.delete_invoice_good': 'Видалити товар/послугу',
    'confirm.tool.create_invoice_company': 'Створити компанію для інвойсів',
    'confirm.tool.update_invoice_company': 'Змінити компанію для інвойсів',
    'confirm.tool.delete_invoice_company': 'Видалити компанію для інвойсів',
    // Exchange rates
    'confirm.tool.upsert_exchange_rate': 'Зберегти курс валют',
    'confirm.tool.delete_exchange_rate': 'Видалити курс валют',
    // Webhooks
    'confirm.tool.create_webhook': 'Створити вебхук',
    'confirm.tool.update_webhook': 'Змінити вебхук',
    'confirm.tool.delete_webhook': 'Видалити вебхук',
    // Integrations
    'confirm.tool.save_integration': 'Зберегти інтеграцію',
    'confirm.tool.delete_integration': 'Видалити інтеграцію',
    'confirm.tool.toggle_integration': 'Перемкнути інтеграцію',
    // HTTP
    'confirm.tool.http_request': 'Зовнішній запит',

    // Operation / counterparty type names
    'confirm.type.income': 'Дохід',
    'confirm.type.expense': 'Витрата',
    'confirm.type.transfer': 'Переказ',
    'confirm.type.suppliers': 'Постачальник',
    'confirm.type.creditors': 'Кредитор',
    'confirm.type.debitors': 'Дебітор',
    'confirm.type.investors': 'Інвестор',
    'confirm.type.employees': 'Співробітник',
    'confirm.type.owners': 'Власник',
    'confirm.type.tax-organisations': 'Податковий орган',

    // Detail fragments
    'confirm.details.amount': '{amount} ₴',
    'confirm.details.id': 'ID: {id}',
    'confirm.details.invoiceNumber': '№ {n}',
    'confirm.details.rate': 'курс {rate}',

    // Bar
    'confirm.queuedTitle': 'Дії підтверджуються по черзі',
    'confirm.queued': '+{n} у черзі',
    'confirm.confirmBtn': 'Підтвердити',
    'confirm.rejectBtn': 'Скасувати',
  },
  en: {
    // Operations
    'confirm.tool.create_operation': 'Create operation',
    'confirm.tool.patch_operation': 'Edit operation',
    'confirm.tool.delete_operation': 'Delete operation',
    // Categories
    'confirm.tool.create_category': 'Create category',
    'confirm.tool.update_category': 'Edit category',
    'confirm.tool.delete_category': 'Delete category',
    // Tags
    'confirm.tool.create_tag': 'Create tag',
    'confirm.tool.update_tag': 'Edit tag',
    'confirm.tool.delete_tag': 'Delete tag',
    // Projects
    'confirm.tool.create_project': 'Create project',
    'confirm.tool.update_project': 'Edit project',
    'confirm.tool.delete_project': 'Delete project',
    // Counterparties
    'confirm.tool.create_counterparty': 'Create counterparty',
    'confirm.tool.update_counterparty': 'Edit counterparty',
    'confirm.tool.delete_counterparty': 'Delete counterparty',
    // Invoices
    'confirm.tool.create_invoice': 'Create invoice',
    'confirm.tool.update_invoice': 'Edit invoice',
    'confirm.tool.delete_invoice': 'Delete invoice',
    'confirm.tool.create_invoice_good': 'Create product/service',
    'confirm.tool.update_invoice_good': 'Edit product/service',
    'confirm.tool.delete_invoice_good': 'Delete product/service',
    'confirm.tool.create_invoice_company': 'Create invoice company',
    'confirm.tool.update_invoice_company': 'Edit invoice company',
    'confirm.tool.delete_invoice_company': 'Delete invoice company',
    // Exchange rates
    'confirm.tool.upsert_exchange_rate': 'Save exchange rate',
    'confirm.tool.delete_exchange_rate': 'Delete exchange rate',
    // Webhooks
    'confirm.tool.create_webhook': 'Create webhook',
    'confirm.tool.update_webhook': 'Edit webhook',
    'confirm.tool.delete_webhook': 'Delete webhook',
    // Integrations
    'confirm.tool.save_integration': 'Save integration',
    'confirm.tool.delete_integration': 'Delete integration',
    'confirm.tool.toggle_integration': 'Toggle integration',
    // HTTP
    'confirm.tool.http_request': 'External request',

    // Operation / counterparty type names
    'confirm.type.income': 'Income',
    'confirm.type.expense': 'Expense',
    'confirm.type.transfer': 'Transfer',
    'confirm.type.suppliers': 'Supplier',
    'confirm.type.creditors': 'Creditor',
    'confirm.type.debitors': 'Debtor',
    'confirm.type.investors': 'Investor',
    'confirm.type.employees': 'Employee',
    'confirm.type.owners': 'Owner',
    'confirm.type.tax-organisations': 'Tax authority',

    // Detail fragments
    'confirm.details.amount': '{amount} ₴',
    'confirm.details.id': 'ID: {id}',
    'confirm.details.invoiceNumber': '#{n}',
    'confirm.details.rate': 'rate {rate}',

    // Bar
    'confirm.queuedTitle': 'Actions are confirmed one at a time',
    'confirm.queued': '+{n} queued',
    'confirm.confirmBtn': 'Confirm',
    'confirm.rejectBtn': 'Reject',
  },
};

export default strings;
