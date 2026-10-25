/** Agent-facing contract for the relational manual-override storage. */
export function describeManualOverrides(spec: any) {
  spec.info.version = "3.0.0";
  const schemas = spec.components.schemas;
  delete schemas.UpdateUserRequest.properties.overrides;
  schemas.UpdateUserRequest.additionalProperties = false;
  schemas.User.properties.overrides.description = "Вычисляемая карта ручных правок из day_overrides и occupancy_intervals. Для записи используйте /overrides/{date}, а не PUT профиля.";
  schemas.User.properties.overrides.readOnly = true;
  schemas.ManualInterval = {
    type: "object", required: ["id", "startsAt", "endsAt", "note", "position"],
    properties: {
      id: { type: "string", pattern: "^[0-9]+$", description: "BIGSERIAL как строка. При замене правки дня идентификаторы его интервалов меняются." },
      startsAt: { type: "string", format: "date-time", description: "Начало timestamptz, RFC3339 со смещением" },
      endsAt: { type: "string", format: "date-time", description: "Конец строго после начала; может быть на следующую дату" },
      note: { type: ["string", "null"], description: "Заметка интервала; соответствует slots[].label в формате записи" },
      position: { type: "integer", minimum: 0, description: "Порядок интервалов в правке дня" },
    },
  };
  schemas.ManualDay = {
    type: "object", required: ["date", "status", "note", "timeZone", "intervals"],
    properties: {
      date: { type: "string", format: "date", description: "Исходная дата ручной правки" },
      status: { type: "string", enum: ["working", "partial", "free"] },
      note: { type: ["string", "null"], description: "Общая заметка дня" },
      timeZone: { type: "string", example: "Asia/Yekaterinburg", description: "IANA-зона календарного дня; сохранённые правки сохраняют свою зону" },
      intervals: { type: "array", items: { $ref: "#/components/schemas/ManualInterval" }, description: "У свободного дня пустой массив: это явная отмена базового графика" },
    },
  };
  const errors = { "400": { description: "Некорректные данные" }, "401": { description: "Нужна сессия" }, "403": { description: "Чужой пользователь" } };
  spec.paths["/api/users/{id}/overrides"] = { get: {
    tags: ["Agent Helpers"], operationId: "listManualOverrides", summary: "Прочитать ручные правки с полными датами начала и конца интервалов",
    description: "Только собственные правки. from/to включительны и фильтруют исходную дату правки, а не пересечение абсолютных интервалов. Недельные и сменные правила остаются в schedule_config и не входят в этот ответ. Пересекающиеся интервалы сохраняются отдельно.",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 }, description: "ID текущего пользователя" },
      ...["from", "to"].map(name => ({ name, in: "query", required: false, schema: { type: "string", format: "date" } })),
    ],
    responses: { ...errors, "200": {
      description: "Правки по исходным датам", content: { "application/json": {
        schema: { type: "object", required: ["days"], properties: { days: { type: "array", items: { $ref: "#/components/schemas/ManualDay" } } } },
        example: { days: [{ date: "2026-10-27", status: "working", note: "Две смены", timeZone: "Asia/Yekaterinburg", intervals: [
          { id: "1", startsAt: "2026-10-27T06:00:00+05:00", endsAt: "2026-10-27T14:00:00+05:00", note: "Первая", position: 0 },
          { id: "2", startsAt: "2026-10-27T10:00:00+05:00", endsAt: "2026-10-27T16:00:00+05:00", note: null, position: 1 },
        ] }] },
      } },
    } },
  } };
  const day = spec.paths["/api/users/{id}/overrides/{date}"];
  day.get = {
    tags: ["Agent Helpers"], operationId: "getManualOverride", summary: "Прочитать снимок правки дня для безопасного изменения",
    parameters: day.put.parameters,
    responses: { ...errors, "200": { description: "override=null означает отсутствие ручной правки и применение базового графика", content: { "application/json": {
      schema: { type: "object", required: ["date", "override"], properties: { date: { type: "string", format: "date" }, override: { anyOf: [{ $ref: "#/components/schemas/DayOverride" }, { type: "null" }] } } },
      example: { date: "2026-10-27", override: null },
    } } } },
  };
  day.put.description = "В одной транзакции заменяет ручную правку дня и все её интервалы. Передайте expectedOverride из GET этого же дня. Начало/конец задаются HH:MM в зоне правки; для новых дней — SCHEDULE_TIMEZONE (по умолчанию Asia/Yekaterinburg). Конец раньше начала означает следующий день; 24:00 допустимо только для конца. Пересечения допустимы. note — заметка дня, slots[].label — заметка интервала. При конфликте — 409 без изменений.";
  day.delete.description = "Удаляет настройку дня и каскадно все её интервалы в одной транзакции, возвращая базовый график. Нужен expectedOverride из GET дня. Отличается от PUT status=free с slots=[]: такой день явно отменяет базовый график.";
  spec.paths["/api/users/{id}"].put.summary = "Обновить профиль, настройки таймлайна или базовый график";
  spec.paths["/api/users/{id}"].put.description += " Ручные правки здесь больше не принимаются; используйте /overrides/{date}.";
}
