import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'Obscura',
    description: 'Переключатель своих прокси-серверов: короткие имена, одна учётная запись на все серверы.',
    permissions: ['proxy', 'storage', 'webRequest', 'webRequestAuthProvider', 'privacy'],
    host_permissions: ['<all_urls>'],
    incognito: 'spanning',
    action: { default_title: 'Obscura' },
    commands: {
      toggle: {
        suggested_key: { default: 'Alt+Shift+P' },
        description: 'Последний сервер ↔ напрямую',
      },
      next: {
        suggested_key: { default: 'Alt+Shift+N' },
        description: 'Следующий сервер',
      },
    },
  },
});
