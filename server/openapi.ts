export function getOpenApiSpec(baseUrl = "http://localhost:5173") {
  return {
    openapi: "3.1.0",
    info: {
      title: "Syncro Occupancy Tracking API (Agent & OpenAPI Interface)",
      version: "1.1.0",
      summary: "REST API для управления расписаниями, правками на день, группами и расчётом общих свободных окон",
      description:
        "Полная спецификация API сервиса Syncro, оптимизированная для LLM-агентов и автоматизаций. " +
        "Позволяет получать расписание участников, автоматически вычислять пересечения свободного времени в группе, " +
        "редактировать базовый график (5/2, сменный 2/2, ручной), точечно задавать или удалять правки на конкретную дату (overrides), " +
        "а также управлять аккаунтами и группами.\n\n" +
        "Для быстрого погружения нейросети также доступна текстовая инструкция по адресу `GET /api/llms.txt`.",
    },
    servers: [
      {
        url: baseUrl,
        description: "Текущий сервер Syncro (проксирует /api на backend)",
      },
      {
        url: "http://127.0.0.1:3001",
        description: "Прямой адрес Express API сервера",
      },
    ],
    tags: [
      {
        name: "Agent Helpers",
        description:
          "Высокоуровневые эндпоинты для нейросетей: расчёт расписания и общих свободных окон группы, точечная установка/сброс правки на один день и обновление базового графика",
      },
      {
        name: "Users & Auth",
        description: "Авторизация, регистрация, поиск пользователей и управление профилем",
      },
      {
        name: "Groups",
        description: "Создание групп, приглашение участников по @username, принятие приглашений и управление составом",
      },
      {
        name: "System & Meta",
        description: "OpenAPI спецификация, документация llms.txt, загрузка медиа и Server-Sent Events (SSE)",
      },
    ],
    paths: {
      "/api/groups/{groupId}/availability": {
        get: {
          tags: ["Agent Helpers"],
          operationId: "getGroupAvailability",
          summary: "Рассчитать расписание участников группы и общие свободные окна на период",
          description:
            "Основной эндпоинт для чтения расписания нейросетью. Возвращает уже вычисленное по дням расписание каждого участника " +
            "(с учётом их базового режима `fixed_weekly` / `shift_cycle` / `manual` и ручных правок `overrides`), " +
            "а также готовые пересечения свободного времени (`commonFreeWindows` по дням и непрерывные интервалы `continuousFreeWindows`).",
          parameters: [
            {
              name: "groupId",
              in: "path",
              required: true,
              description: "ID группы",
              schema: { type: "integer", example: 1 },
            },
            {
              name: "startDate",
              in: "query",
              required: false,
              description: "Дата начала периода в формате YYYY-MM-DD (по умолчанию сегодня)",
              schema: { type: "string", format: "date", example: "2026-10-25" },
            },
            {
              name: "days",
              in: "query",
              required: false,
              description: "Количество дней для расчёта (от 1 до 31, по умолчанию 7)",
              schema: { type: "integer", minimum: 1, maximum: 31, default: 7 },
            },
            {
              name: "memberIds",
              in: "query",
              required: false,
              description:
                "Список ID участников через запятую для расчёта пересечения только между выбранными людьми (по умолчанию все принятые участники группы)",
              schema: { type: "string", example: "1,2" },
            },
            {
              name: "windowStart",
              in: "query",
              required: false,
              description: "Начало дневного окна бодрствования для поиска свободных слотов (HH:MM, по умолчанию 09:00)",
              schema: { type: "string", default: "09:00", example: "09:00" },
            },
            {
              name: "windowEnd",
              in: "query",
              required: false,
              description: "Конец дневного окна бодрствования (HH:MM, по умолчанию 23:00)",
              schema: { type: "string", default: "23:00", example: "23:00" },
            },
            {
              name: "minCommonHours",
              in: "query",
              required: false,
              description: "Минимальная длительность общего окна в часах (по умолчанию 2)",
              schema: { type: "number", default: 2, example: 2 },
            },
          ],
          responses: {
            "200": {
              description: "Рассчитанная матрица занятости и общих свободных окон",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/GroupAvailabilityResponse" },
                },
              },
            },
            "404": {
              description: "Группа не найдена",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
            },
          },
        },
      },
      "/api/users/{id}/overrides/{date}": {
        put: {
          tags: ["Agent Helpers"],
          operationId: "setUserDayOverride",
          summary: "Установить или изменить правку расписания на конкретный день (YYYY-MM-DD)",
          description:
            "Точечно задаёт исключение (override) для пользователя `id` на дату `date` (`YYYY-MM-DD`), не затрагивая остальные даты. " +
            "Если `status` равен `\"free\"`, пользователь считается полностью свободным в этот день (`slots` очищаются). " +
            "Если `status` равен `\"working\"` или `\"partial\"`, передайте массив интервалов занятости `slots` (например, `[{\"start\":\"10:00\",\"end\":\"18:00\"}]`).",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              description: "ID пользователя",
              schema: { type: "integer", example: 1 },
            },
            {
              name: "date",
              in: "path",
              required: true,
              description: "Дата в формате YYYY-MM-DD",
              schema: { type: "string", format: "date", example: "2026-10-26" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DayOverride" },
                examples: {
                  busyDay: {
                    summary: "Занят с 10:00 до 19:00",
                    value: {
                      status: "working",
                      slots: [{ start: "10:00", end: "19:00" }],
                      note: "Дежурство в офисе",
                    },
                  },
                  dayOff: {
                    summary: "Полностью свободен (выходной/отгул)",
                    value: {
                      status: "free",
                      slots: [],
                      note: "Взял выходной",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Правка сохранена, возвращает обновлённую дату, правку и профиль пользователя",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      date: { type: "string" },
                      override: { $ref: "#/components/schemas/DayOverride" },
                      user: { $ref: "#/components/schemas/User" },
                    },
                  },
                },
              },
            },
          },
        },
        delete: {
          tags: ["Agent Helpers"],
          operationId: "deleteUserDayOverride",
          summary: "Удалить ручную правку на день и вернуть дату к базовому графику",
          description:
            "Удаляет запись `overrides[date]` у пользователя `id`. После этого расписание на дату `date` снова вычисляется по базовому `schedule_config`.",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              description: "ID пользователя",
              schema: { type: "integer", example: 1 },
            },
            {
              name: "date",
              in: "path",
              required: true,
              description: "Дата в формате YYYY-MM-DD",
              schema: { type: "string", format: "date", example: "2026-10-26" },
            },
          ],
          responses: {
            "200": {
              description: "Правка удалена",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      date: { type: "string" },
                      user: { $ref: "#/components/schemas/User" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/users/{id}/schedule": {
        patch: {
          tags: ["Agent Helpers"],
          operationId: "updateUserScheduleConfig",
          summary: "Обновить базовый режим графика пользователя (fixed_weekly / shift_cycle / manual)",
          description:
            "Позволяет изменить регулярное расписание пользователя (`schedule_config`) без необходимости передавать все остальные поля профиля.",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              description: "ID пользователя",
              schema: { type: "integer", example: 1 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ScheduleConfig" },
                examples: {
                  shiftCycle2x2: {
                    summary: "Сменный график 2/2 с 09:00 до 21:00",
                    value: {
                      mode: "shift_cycle",
                      shift: {
                        workDays: 2,
                        offDays: 2,
                        startDate: "2026-10-25",
                        slots: [{ start: "09:00", end: "21:00" }],
                      },
                    },
                  },
                  fixedWeekly5x2: {
                    summary: "Фиксированный недельный график Пн-Пт 09:00-18:00",
                    value: {
                      mode: "fixed_weekly",
                      weekly: {
                        "1": { isWorking: true, slots: [{ start: "09:00", end: "18:00" }] },
                        "2": { isWorking: true, slots: [{ start: "09:00", end: "18:00" }] },
                        "3": { isWorking: true, slots: [{ start: "09:00", end: "18:00" }] },
                        "4": { isWorking: true, slots: [{ start: "09:00", end: "18:00" }] },
                        "5": { isWorking: true, slots: [{ start: "09:00", end: "18:00" }] },
                        "6": { isWorking: false, slots: [] },
                        "0": { isWorking: false, slots: [] },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Обновлённый профиль пользователя",
              content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } },
            },
          },
        },
      },
      "/api/users": {
        get: {
          tags: ["Users & Auth"],
          operationId: "listUsers",
          summary: "Список всех пользователей или поиск по @username",
          description:
            "Возвращает список зарегистрированных пользователей. Удобно для агентов, чтобы узнать `id` пользователя по его `@username`.",
          parameters: [
            {
              name: "username",
              in: "query",
              required: false,
              description: "Фильтр по @username (регистронезависимый поиск)",
              schema: { type: "string", example: "alex" },
            },
          ],
          responses: {
            "200": {
              description: "Массив пользователей",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { $ref: "#/components/schemas/User" },
                  },
                },
              },
            },
          },
        },
      },
      "/api/users/{id}": {
        get: {
          tags: ["Users & Auth"],
          operationId: "getUserById",
          summary: "Получить полный профиль, график и правки пользователя по ID",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              description: "ID пользователя",
              schema: { type: "integer", example: 1 },
            },
          ],
          responses: {
            "200": {
              description: "Профиль пользователя",
              content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } },
            },
            "404": {
              description: "Пользователь не найден",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
            },
          },
        },
        put: {
          tags: ["Users & Auth"],
          operationId: "updateUser",
          summary: "Обновить профиль пользователя, настройки таймлайна, базовый график или карту правок",
          description:
            "Частичное или полное обновление пользователя. Любые непереданные поля сохраняют свои текущие значения в БД.",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              description: "ID пользователя",
              schema: { type: "integer", example: 1 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UpdateUserRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Обновлённый пользователь",
              content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } },
            },
          },
        },
      },
      "/api/auth/login": {
        post: {
          tags: ["Users & Auth"],
          operationId: "loginUser",
          summary: "Вход по @username и паролю",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["username", "password"],
                  properties: {
                    username: { type: "string", example: "admin" },
                    password: { type: "string", example: "admin" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Успешный вход, возвращает объект User",
              content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } },
            },
            "401": {
              description: "Неверный пароль",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
            },
            "404": {
              description: "Пользователь не найден",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
            },
          },
        },
      },
      "/api/auth/register": {
        post: {
          tags: ["Users & Auth"],
          operationId: "registerUser",
          summary: "Регистрация нового пользователя",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["username", "display_name", "password"],
                  properties: {
                    username: { type: "string", minLength: 2, maxLength: 32, example: "ivan_dev" },
                    display_name: { type: "string", minLength: 1, maxLength: 64, example: "Иван" },
                    password: { type: "string", minLength: 4, example: "secret123" },
                    role_title: { type: "string", example: "Backend Developer" },
                    avatar_color: { type: "string", example: "#3B82F6" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Созданный пользователь",
              content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } },
            },
          },
        },
      },
      "/api/users/{id}/change-password": {
        post: {
          tags: ["Users & Auth"],
          operationId: "changeUserPassword",
          summary: "Сменить пароль пользователя",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "integer", example: 1 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["currentPassword", "newPassword"],
                  properties: {
                    currentPassword: { type: "string", example: "admin" },
                    newPassword: { type: "string", minLength: 4, example: "newpass123" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Пароль успешно изменён",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { ok: { type: "boolean" } } },
                },
              },
            },
          },
        },
      },
      "/api/groups": {
        get: {
          tags: ["Groups"],
          operationId: "listGroups",
          summary: "Получить список групп и их участников (с расписаниями)",
          description:
            "Если передан параметр `userId`, возвращает только те группы, где пользователь состоит (`accepted`) или куда приглашён (`pending`). " +
            "Если `userId` не указан, возвращает все группы в системе.",
          parameters: [
            {
              name: "userId",
              in: "query",
              required: false,
              description: "ID пользователя для фильтрации его групп и вычисления поля my_status",
              schema: { type: "integer", example: 1 },
            },
          ],
          responses: {
            "200": {
              description: "Список групп с участниками",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Group" },
                  },
                },
              },
            },
          },
        },
        post: {
          tags: ["Groups"],
          operationId: "createGroup",
          summary: "Создать новую группу",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name", "owner_id"],
                  properties: {
                    name: { type: "string", example: "Команда разработки" },
                    description: { type: "string", example: "Синхронизация созвонов и дежурств" },
                    owner_id: { type: "integer", example: 1 },
                    invite_usernames: {
                      type: "array",
                      items: { type: "string" },
                      description: "Массив @username для отправки приглашений сразу при создании",
                      example: ["maria", "alex"],
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Созданная группа",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Group" } } },
            },
          },
        },
      },
      "/api/groups/{groupId}": {
        put: {
          tags: ["Groups"],
          operationId: "updateGroup",
          summary: "Изменить название и описание группы",
          parameters: [
            {
              name: "groupId",
              in: "path",
              required: true,
              schema: { type: "integer", example: 1 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: { type: "string", example: "Основная команда" },
                    description: { type: "string", example: "Новое описание группы" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Обновлённая группа",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Group" } } },
            },
          },
        },
        delete: {
          tags: ["Groups"],
          operationId: "deleteGroup",
          summary: "Удалить группу полностью",
          parameters: [
            {
              name: "groupId",
              in: "path",
              required: true,
              schema: { type: "integer", example: 1 },
            },
          ],
          responses: {
            "200": {
              description: "Группа удалена",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { ok: { type: "boolean" } } },
                },
              },
            },
          },
        },
      },
      "/api/groups/{groupId}/invite": {
        post: {
          tags: ["Groups"],
          operationId: "inviteGroupMember",
          summary: "Пригласить пользователя в группу по @username",
          parameters: [
            {
              name: "groupId",
              in: "path",
              required: true,
              schema: { type: "integer", example: 1 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["username"],
                  properties: {
                    username: { type: "string", example: "alex" },
                    invited_by: { type: "integer", example: 1 },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Приглашение отправлено (статус pending)",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      message: { type: "string" },
                      status: { type: "string", example: "pending" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/groups/{groupId}/respond": {
        post: {
          tags: ["Groups"],
          operationId: "respondGroupInvite",
          summary: "Принять или отклонить приглашение в группу",
          parameters: [
            {
              name: "groupId",
              in: "path",
              required: true,
              schema: { type: "integer", example: 1 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["user_id", "action"],
                  properties: {
                    user_id: { type: "integer", example: 2 },
                    action: { type: "string", enum: ["accept", "decline"], example: "accept" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Статус обновлён",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string", enum: ["accepted", "declined"] },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/groups/{groupId}/members/{targetUserId}": {
        delete: {
          tags: ["Groups"],
          operationId: "removeGroupMember",
          summary: "Исключить участника из группы, отменить приглашение или выйти из группы",
          parameters: [
            {
              name: "groupId",
              in: "path",
              required: true,
              schema: { type: "integer", example: 1 },
            },
            {
              name: "targetUserId",
              in: "path",
              required: true,
              schema: { type: "integer", example: 2 },
            },
          ],
          responses: {
            "200": {
              description: "Участник удалён из группы",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { ok: { type: "boolean" } } },
                },
              },
            },
          },
        },
      },
      "/api/groups/{groupId}/transfer-owner": {
        post: {
          tags: ["Groups"],
          operationId: "transferGroupOwnership",
          summary: "Передать права владельца группы другому участнику",
          parameters: [
            {
              name: "groupId",
              in: "path",
              required: true,
              schema: { type: "integer", example: 1 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["new_owner_id"],
                  properties: {
                    new_owner_id: { type: "integer", example: 2 },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Владелец изменён",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Group" } } },
            },
          },
        },
      },
      "/api/openapi.json": {
        get: {
          tags: ["System & Meta"],
          operationId: "getOpenApiSpec",
          summary: "Получить эту OpenAPI 3.1.0 спецификацию в формате JSON",
          responses: {
            "200": {
              description: "OpenAPI 3.1 JSON",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/api/llms.txt": {
        get: {
          tags: ["System & Meta"],
          operationId: "getLlmsTxt",
          summary: "Получить компактное руководство для нейросетей и LLM-агентов (llms.txt)",
          responses: {
            "200": {
              description: "Markdown-документация для LLM",
              content: { "text/plain": { schema: { type: "string" } } },
            },
          },
        },
      },
      "/api/events": {
        get: {
          tags: ["System & Meta"],
          operationId: "subscribeServerEvents",
          summary: "Server-Sent Events (SSE) поток обновлений расписания и групп в реальном времени",
          responses: {
            "200": {
              description: "text/event-stream поток событий",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        TimeSlot: {
          type: "object",
          required: ["start", "end"],
          description:
            "Интервал занятости в формате 24ч HH:MM. Если end < start (например, start: '21:00', end: '09:00'), смена считается ночной с переходом на следующие сутки.",
          properties: {
            start: { type: "string", pattern: "^\\d{2}:\\d{2}$", example: "09:00" },
            end: { type: "string", pattern: "^\\d{2}:\\d{2}$", example: "18:00" },
            label: { type: "string", example: "Работа" },
          },
        },
        DayWeeklySchedule: {
          type: "object",
          required: ["isWorking", "slots"],
          properties: {
            isWorking: { type: "boolean", example: true },
            slots: {
              type: "array",
              items: { $ref: "#/components/schemas/TimeSlot" },
            },
          },
        },
        ShiftCycleConfig: {
          type: "object",
          required: ["workDays", "offDays", "startDate", "slots"],
          description: "Настройки сменного графика (например, 2/2, 3/3, 1/3)",
          properties: {
            workDays: { type: "integer", minimum: 1, example: 2, description: "Количество рабочих дней подряд" },
            offDays: { type: "integer", minimum: 1, example: 2, description: "Количество выходных дней подряд" },
            startDate: {
              type: "string",
              format: "date",
              example: "2026-10-25",
              description: "Дата первого рабочего дня цикла (YYYY-MM-DD)",
            },
            slots: {
              type: "array",
              items: { $ref: "#/components/schemas/TimeSlot" },
            },
          },
        },
        ScheduleConfig: {
          type: "object",
          required: ["mode"],
          description:
            "Базовый график пользователя. Режимы: `fixed_weekly` (по дням недели 0=Вс .. 6=Сб), `shift_cycle` (цикл N рабочих / M выходных от startDate), `manual` (по умолчанию свободен, занятость задаётся через overrides).",
          properties: {
            mode: {
              type: "string",
              enum: ["fixed_weekly", "shift_cycle", "manual"],
              example: "fixed_weekly",
            },
            weekly: {
              type: "object",
              description: "Словарь по дням недели: ключи '0' (Воскресенье), '1' (Понедельник) ... '6' (Суббота)",
              additionalProperties: { $ref: "#/components/schemas/DayWeeklySchedule" },
            },
            shift: { $ref: "#/components/schemas/ShiftCycleConfig" },
          },
        },
        DayOverride: {
          type: "object",
          required: ["status", "slots"],
          description: "Точечное исключение (правка) на конкретную дату YYYY-MM-DD",
          properties: {
            status: {
              type: "string",
              enum: ["working", "free", "partial"],
              description:
                "'free' — полностью свободен весь день; 'working' — занят в указанные slots; 'partial' — частичная занятость в указанные slots",
              example: "working",
            },
            slots: {
              type: "array",
              items: { $ref: "#/components/schemas/TimeSlot" },
            },
            note: {
              type: "string",
              description: "Необязательный комментарий к дню (например, 'Отгул', 'Дежурство', 'Врач')",
              example: "Дежурство",
            },
          },
        },
        User: {
          type: "object",
          properties: {
            id: { type: "integer", example: 1 },
            username: { type: "string", example: "alex" },
            display_name: { type: "string", example: "Алексей" },
            role_title: { type: "string", example: "Участник" },
            avatar_color: { type: "string", example: "#3B82F6" },
            avatar_url: { type: ["string", "null"] },
            banner_url: { type: ["string", "null"] },
            schedule_config: { $ref: "#/components/schemas/ScheduleConfig" },
            overrides: {
              type: "object",
              description: "Карта исключений по датам (ключ — 'YYYY-MM-DD')",
              additionalProperties: { $ref: "#/components/schemas/DayOverride" },
            },
          },
        },
        UpdateUserRequest: {
          type: "object",
          properties: {
            username: { type: "string" },
            display_name: { type: "string" },
            role_title: { type: "string" },
            avatar_color: { type: "string" },
            schedule_config: { $ref: "#/components/schemas/ScheduleConfig" },
            overrides: {
              type: "object",
              additionalProperties: { $ref: "#/components/schemas/DayOverride" },
            },
          },
        },
        GroupMember: {
          allOf: [
            { $ref: "#/components/schemas/User" },
            {
              type: "object",
              properties: {
                group_id: { type: "integer" },
                user_id: { type: "integer" },
                status: { type: "string", enum: ["accepted", "pending"] },
                invited_by: { type: ["integer", "null"] },
                invited_by_username: { type: ["string", "null"] },
              },
            },
          ],
        },
        Group: {
          type: "object",
          properties: {
            id: { type: "integer", example: 1 },
            name: { type: "string", example: "Друзья" },
            description: { type: "string", example: "Совместные игры и встречи" },
            owner_id: { type: "integer", example: 1 },
            owner_username: { type: "string", example: "alex" },
            my_status: { type: ["string", "null"], enum: ["accepted", "pending", null] },
            members: {
              type: "array",
              items: { $ref: "#/components/schemas/GroupMember" },
            },
          },
        },
        ComputedDaySchedule: {
          type: "object",
          properties: {
            dateStr: { type: "string", format: "date", example: "2026-10-25" },
            status: { type: "string", enum: ["free", "working", "partial"] },
            slots: { type: "array", items: { $ref: "#/components/schemas/TimeSlot" } },
            isOverride: { type: "boolean" },
            note: { type: "string" },
            sourceLabel: { type: "string", example: "Недельный график" },
            busyHoursCount: { type: "number", example: 9 },
            freeIntervals: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  start: { type: "string", example: "18:00" },
                  end: { type: "string", example: "23:00" },
                  durationHours: { type: "number", example: 5 },
                },
              },
            },
          },
        },
        GroupAvailabilityResponse: {
          type: "object",
          properties: {
            group: {
              type: "object",
              properties: {
                id: { type: "integer" },
                name: { type: "string" },
                description: { type: "string" },
                owner_id: { type: "integer" },
              },
            },
            query: {
              type: "object",
              properties: {
                startDate: { type: "string", format: "date" },
                days: { type: "integer" },
                windowStart: { type: "string" },
                windowEnd: { type: "string" },
                minCommonHours: { type: "number" },
                selectedMemberIds: { type: "array", items: { type: "integer" } },
              },
            },
            members: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  username: { type: "string" },
                  display_name: { type: "string" },
                  role_title: { type: "string" },
                  dailySchedule: {
                    type: "array",
                    items: { $ref: "#/components/schemas/ComputedDaySchedule" },
                  },
                },
              },
            },
            dailyOverlap: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  dateStr: { type: "string", format: "date" },
                  allFreeFullDay: { type: "boolean" },
                  allHaveCommonWindow: { type: "boolean" },
                  commonFreeWindows: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        start: { type: "string" },
                        end: { type: "string" },
                        durationHours: { type: "number" },
                      },
                    },
                  },
                  availableMembersCount: { type: "integer" },
                  totalSelectedCount: { type: "integer" },
                },
              },
            },
          },
        },
        ErrorResponse: {
          type: "object",
          properties: {
            error: { type: "string" },
          },
        },
      },
    },
  };
}

export function getLlmsTxtContent(baseUrl = "http://localhost:5173"): string {
  return `# Syncro — Руководство для ИИ-агентов и нейросетей (llms.txt)

> Syncro — веб-сервис отслеживания занятости участников групп и поиска общих свободных окон.
> Полная спецификация OpenAPI 3.1.0 доступна по адресу: \`${baseUrl}/api/openapi.json\`
> Упрощённый веб-интерфейс и интерактивная консоль OpenAPI доступны на странице: \`${baseUrl}/?agent=1\` (или кнопка «OpenAPI / Агентам» в сайдбаре).

## 1. Ключевые понятия и модель данных

1. **Пользователь (\`User\`)**:
   - Имеет \`id\`, \`username\` (без \`@\`), \`display_name\`, \`schedule_config\` и \`overrides\`.
   - Активный пользователь на фронтенде хранится в \`localStorage.getItem("syncro_active_user_id")\`, активная группа — в \`localStorage.getItem("syncro_active_group_id")\`.

2. **Базовый график (\`schedule_config\`)**:
   - \`mode: "fixed_weekly"\` — расписание по дням недели в объекте \`weekly\`, где ключи от \`"0"\` (Воскресенье) до \`"6"\` (Суббота): \`{ isWorking: boolean, slots: [{ start: "09:00", end: "18:00" }] }\`.
   - \`mode: "shift_cycle"\` — сменный график в объекте \`shift\`: \`{ workDays: 2, offDays: 2, startDate: "YYYY-MM-DD", slots: [{ start: "09:00", end: "21:00" }] }\`.
   - \`mode: "manual"\` — по умолчанию все дни свободны, занятость указывается вручную на конкретные даты.

3. **Правки на конкретную дату (\`overrides\`)**:
   - Словарь \`{ "YYYY-MM-DD": { status: "working" | "free" | "partial", slots: [{ start: "HH:MM", end: "HH:MM" }], note?: string } }\`.
   - Правка на дату имеет приоритет над базовым графиком.

---

## 2. Основные сценарии для агента (REST API)

### А. Узнать расписание группы и общие свободные окна (1 запрос)
Вместо ручного вычисления графиков вызовите:
\`\`\`http
GET /api/groups/{groupId}/availability?startDate=2026-10-25&days=7&windowStart=09:00&windowEnd=23:00&minCommonHours=2
\`\`\`
Эндпоинт вернёт:
- \`members[].dailySchedule\` — расписание каждого участника на каждый день (занятые \`slots\` и свободные \`freeIntervals\`).
- \`dailyOverlap\` — на каждый день список \`commonFreeWindows\` (интервалы, когда ВСЕ выбранные участники свободны одновременно).

### Б. Поставить или изменить правку на один день (выходной, дежурство, смена часов)
\`\`\`http
PUT /api/users/{userId}/overrides/{YYYY-MM-DD}
Content-Type: application/json

{
  "status": "working",
  "slots": [{ "start": "12:00", "end": "20:00" }],
  "note": "Смена с обеда"
}
\`\`\`
Чтобы сделать день полностью свободным (отгул/выходной):
\`\`\`json
{
  "status": "free",
  "slots": [],
  "note": "Выходной"
}
\`\`\`
Чтобы удалить правку и вернуть день к базовому графику:
\`\`\`http
DELETE /api/users/{userId}/overrides/{YYYY-MM-DD}
\`\`\`

### В. Изменить базовый график работы пользователя
\`\`\`http
PATCH /api/users/{userId}/schedule
Content-Type: application/json

{
  "mode": "shift_cycle",
  "shift": {
    "workDays": 2,
    "offDays": 2,
    "startDate": "2026-10-25",
    "slots": [{ "start": "09:00", "end": "21:00" }]
  }
}
\`\`\`

### Г. Управление группами и участниками
- Список всех пользователей (найти \`id\` по \`@username\`): \`GET /api/users?username=alex\`
- Список групп пользователя: \`GET /api/groups?userId={userId}\`
- Создать группу: \`POST /api/groups\` с телом \`{ "name": "Команда", "description": "...", "owner_id": 1, "invite_usernames": ["user2"] }\`
- Пригласить участника: \`POST /api/groups/{groupId}/invite\` с телом \`{ "username": "user2", "invited_by": 1 }\`
- Принять/отклонить приглашение: \`POST /api/groups/{groupId}/respond\` с телом \`{ "user_id": 2, "action": "accept" }\`
`;
}
