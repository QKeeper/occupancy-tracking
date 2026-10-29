# AGENTS.md — Development, Branching & Deployment Guidelines

Этот документ описывает регламент разработки, модель ветвления Git, архитектуру базы данных и процесс автоматического CI/CD деплоя проекта **Occupancy Tracking (Syncro)**.

---

## 1. Модель ветвления Git (Branching Model)

* **`dev`** — **Основная ветка разработки (Primary / Default branch)**:
  * Все новые фичи, багфиксы и повседневная разработка ведутся в ветке `dev` (или ветках `feature/*`, вливающихся в `dev`).
  * По умолчанию в GitHub репозитории главной веткой должна быть выбрана `dev`.
* **`main`** — **Продакшен-ветка (Production branch)**:
  * Содержит исключительно стабильный релизный код.
  * Изменения попадают в `main` только через Pull Request или слияние (merge) из ветки `dev` после тестирования.
  * **Каждый пуш в ветку `main` автоматически запускает GitHub Actions CI/CD пайплайн, который прогоняет тесты, собирает проект и выполняет деплой на удалённый сервер.**

---

## 2. Работа с базой данных (PostgreSQL)

> ⚠️ **КРИТИЧЕСКИ ВАЖНО:** На удалённом сервере уже работает PostgreSQL с другими базами данных.

1. **Изоляция:**
   * Проект использует отдельную базу данных `occupancy_tracking` и выделенного пользователя `occupancy_user`.
   * Ни при каких обстоятельствах нельзя перезаписывать, удалять или изменять чужие базы данных.
2. **Создание базы и пользователя на сервере (однократно):**
   ```sql
   -- Войти под postgres: sudo -u postgres psql
   CREATE USER occupancy_user WITH PASSWORD 'ВЫБЕРИТЕ_НАДЕЖНЫЙ_ПАРОЛЬ';
   CREATE DATABASE occupancy_tracking OWNER occupancy_user;
   GRANT ALL PRIVILEGES ON DATABASE occupancy_tracking TO occupancy_user;
   ```
3. **Автоматические миграции:**
   * При старте бэкенда функция `initDb()` автоматически создает все таблицы (`users`, `groups`, `group_members`, `manual_overrides`, `auth_sessions`, `pattern_media`) с использованием `CREATE TABLE IF NOT EXISTS` и `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
   * Ручное создание таблиц не требуется.

---

## 3. Архитектура деплоя (Production Deployment)

* **Продакшен-демон (systemd):**
  * Служба: `/etc/systemd/system/occupancy-tracking.service`.
  * Рабочая директория: `/var/www/schedule.ssdk.dev`.
  * Команда запуска: `ExecStart=/usr/bin/pnpm start` (запускает `tsx server/index.ts`).
  * Пользователь: `root`.
* **Раздача статики:**
  * Express-сервер автоматически раздает клиентский билд из папки `/dist` при обращении к любым SPA-маршрутам.
  * Порт бэкенда по умолчанию: `3001` (привязан к `127.0.0.1:3001` для безопасности).
* **Nginx Reverse Proxy:**
  * Проксирует запросы с 80/443 порта на `127.0.0.1:3001`.
  * Домен: `schedule.ssdk.dev`.
  * Конфиг включает поддержку Server-Sent Events `/api/events` с отключенным буферизированием (`proxy_buffering off;`) и лимит тела запроса 25MB для медиа.

---

## 4. Пайплайн CI/CD (GitHub Actions)

Файл конфигурации: `.github/workflows/deploy.yml`.

### Что делает пайплайн:
1. **Шаг `test-and-build`:**
   * Проверяет код при каждом пуше в `main` и каждом Pull Request в `main` или `dev`.
   * Устанавливает зависимости через `pnpm`.
   * Запускает полный набор юнит- и интеграционных тестов (`pnpm test`).
   * Собирает фронтенд (`pnpm run build`).
2. **Шаг `deploy`:**
   * Запускается только при пуше в `main` (или ручном запуске через `workflow_dispatch`).
   * Подключается к серверу по SSH с использованием GitHub Secrets.
   * Заходит в папку приложения (`/var/www/schedule.ssdk.dev`).
   * Запускает скрипт `./deploy.sh`: подтягивает изменения (`git pull`), устанавливает зависимости (`pnpm install --frozen-lockfile`), собирает фронтенд (`pnpm run build`), перезапускает службу (`systemctl restart occupancy-tracking`) и проверяет здоровье сервиса (`/api/health`).

### Необходимые GitHub Secrets:
В настройках GitHub репозитория (**Settings -> Secrets and variables -> Actions**):
* `SSH_HOST`: IP-адрес или домен вашего сервера (например, `schedule.ssdk.dev` или IP).
* `SSH_USER`: Пользователь SSH на сервере (например, `root`).
* `SSH_KEY`: Приватный SSH-ключ для авторизации (соответствующий публичный ключ должен быть в `~/.ssh/authorized_keys` на сервере).
* `SSH_PORT`: Порт SSH (обычно `22`).
* `APP_DIR`: Полный путь к папке проекта на сервере (`/var/www/schedule.ssdk.dev`, по умолчанию подставляется автоматически).

---

## 5. Первоначальная настройка сервера (Runbook)

1. **Клонирование проекта на сервер:**
   ```bash
   sudo mkdir -p /var/www/schedule.ssdk.dev
   git clone <URL_РЕПОЗИТОРИЯ> /var/www/schedule.ssdk.dev
   cd /var/www/schedule.ssdk.dev
   ```

2. **Создание `.env` файла:**
   ```bash
   cp .env.production.example .env
   nano .env
   ```
   Укажите строку подключения к базе `DATABASE_URL` и домен `APP_ORIGINS=https://schedule.ssdk.dev`.

3. **Служба systemd (`/etc/systemd/system/occupancy-tracking.service`):**
   ```ini
   [Unit]
   Description=Occupancy Tracking (Syncro)
   After=network.target postgresql.service

   [Service]
   Type=simple
   User=root
   WorkingDirectory=/var/www/schedule.ssdk.dev
   ExecStart=/usr/bin/pnpm start
   Restart=always
   RestartSec=3
   Environment=NODE_ENV=production

   [Install]
   WantedBy=multi-user.target
   ```
   Активация:
   ```bash
   systemctl daemon-reload
   systemctl enable occupancy-tracking
   systemctl start occupancy-tracking
   ```

4. **Проверка прав на `deploy.sh`:**
   ```bash
   chmod +x deploy.sh
   ```

---

## 6. Правила для агентов (AI Agent Checklist)

* Перед созданием коммита/PR всегда запускайте `pnpm test` и `pnpm run build`.
* Не вносите ломающие изменения в структуру базы данных без обеспечения обратной совместимости.
* Никогда не коммитьте `.env`, секреты и содержимое папки `uploads/`.
* Основная рабочая ветка для разработки — `dev`. В `main` код попадает только для релиза.
