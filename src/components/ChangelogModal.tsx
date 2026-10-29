import React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  History,
  Sparkles,
  Layers,
  Clock,
  Link,
  MessageSquarePlus,
  Server,
  MoveHorizontal,
  Moon,
  Zap,
  CheckCircle2,
} from "lucide-react";
import { APP_VERSION } from "@/lib/version";

interface ChangelogModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ChangelogRelease {
  version: string;
  date: string;
  title: string;
  badge?: string;
  isLatest?: boolean;
  sections: {
    category: "new" | "improved" | "fixed";
    items: {
      title: string;
      desc?: string;
      icon?: React.ElementType;
    }[];
  }[];
}

const CHANGELOG_DATA: ChangelogRelease[] = [
  {
    version: "3.1.0",
    date: "29 октября 2026",
    title: "Интерактивный таймлайн: Drag-and-Drop, свайпы и ночные смены",
    badge: "Текущая версия",
    isLatest: true,
    sections: [
      {
        category: "new",
        items: [
          {
            title: "Растягивание и сжатие интервалов мышью",
            desc: "Изменяйте время начала и конца существующих блоков прямо на таймлайне с привязкой к 15 минутам. Минимальная длительность — 30 минут.",
            icon: MoveHorizontal,
          },
          {
            title: "Создание интервалов свайпом по пустой строке",
            desc: "Протяните курсор по пустой области своей строки таймлайна, чтобы мгновенно создать новый промежуток времени.",
            icon: Zap,
          },
          {
            title: "Категория «Без категории» для разовых событий",
            desc: "Создавайте единичные события и встречи без необходимости привязывать их к рабочему графику или расписанию.",
            icon: Sparkles,
          },
          {
            title: "Ночные смены и переход через полночь",
            desc: "Полноценная поддержка интервалов, переходящих через полночь (например, 22:00 – 06:00). На таймлайне и в модалках отображается бейдж «+1 день».",
            icon: Moon,
          },
        ],
      },
      {
        category: "improved",
        items: [
          {
            title: "Мгновенные оптимистичные обновления",
            desc: "После изменения размера интервала изменения сразу фиксируются в интерфейсе без задержек и ожидания ответа сервера.",
            icon: Zap,
          },
          {
            title: "Интеллектуальная подсветка ручек изменения",
            desc: "Неоновые белые маркеры на краях интервалов появляются только при приближении курсора и не засоряют таймлайн.",
            icon: Sparkles,
          },
          {
            title: "Принцип Linux: тишина при успехе",
            desc: "После успешных манипуляций таймлайн обновляется тихо без лишних всплывающих окон и уведомлений. Система сообщает только об ошибках.",
            icon: CheckCircle2,
          },
          {
            title: "Компактный вид коротких интервалов (< 2 часов)",
            desc: "Для коротких промежутков на первой строке отображается длительность, а на второй — заметка или название категории стандартным читаемым шрифтом.",
            icon: Clock,
          },
        ],
      },
      {
        category: "fixed",
        items: [
          {
            title: "Исправлен сброс времени 24:00 в 23:00",
            desc: "В таймпикере добавлена полноценная поддержка ввода и сохранения границы окончания интервала на 24:00.",
            icon: Clock,
          },
          {
            title: "Отображение кастомных иконок категорий",
            desc: "Пользовательские загруженные аватары и иконки групп корректно визуализируются в окне создания событий.",
            icon: Layers,
          },
        ],
      },
    ],
  },
  {
    version: "3.0.0",
    date: "29 октября 2026",
    title: "Мультигрупповые таймлайны, инвайт-ссылки и система фидбека",
    sections: [
      {
        category: "new",
        items: [
          {
            title: "Мультигрупповая архитектура таймлайнов",
            desc: "Создавайте независимые категории занятости («График работы», «Сон», «Спорт», «Учёба») со своими стилями, расписаниями и единым календарным отображением.",
            icon: Layers,
          },
          {
            title: "Инвайт-ссылки в группы как в Discord",
            desc: "Генерируйте уникальные ссылки-приглашения в группы с предпросмотром, возможностью сброса и мгновенным присоединением.",
            icon: Link,
          },
          {
            title: "Доска обратной связи и предложений",
            desc: "Встроенный трекер предложений и багов: создание тикетов с тегами, голосование лайками и обсуждение в комментариях.",
            icon: MessageSquarePlus,
          },
          {
            title: "Автоматический CI/CD деплой",
            desc: "Бесшовный автоматический деплой через GitHub Actions на сервер с systemd-демоном и проверкой healthcheck.",
            icon: Server,
          },
        ],
      },
      {
        category: "improved",
        items: [
          {
            title: "24-часовой ввод времени shadcn/ui",
            desc: "Новый удобный компонент ввода времени с синхронным буфером двухзначных чисел и поддержкой стрелок клавиатуры.",
            icon: Clock,
          },
          {
            title: "Оптимистичные блокировки и CAS-синхронизация",
            desc: "Устранена вероятность конфликтов и затирания данных при одновременном редактировании графика несколькими пользователями.",
            icon: CheckCircle2,
          },
        ],
      },
    ],
  },
];

const CATEGORY_CONFIG = {
  new: { label: "Новое", color: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20" },
  improved: { label: "Улучшения", color: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/20" },
  fixed: { label: "Исправления", color: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/20" },
};

export const ChangelogModal: React.FC<ChangelogModalProps> = ({ open, onOpenChange }) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="p-5 pb-4 border-b border-border/80 bg-muted/20">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="size-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <History className="size-4" />
              </div>
              <div>
                <DialogTitle className="text-base font-semibold leading-tight">
                  Список изменений
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                  История обновлений и ключевые улучшения Syncro
                </DialogDescription>
              </div>
            </div>
            <Badge variant="outline" className="font-mono text-xs px-2.5 py-1 shrink-0">
              v{APP_VERSION}
            </Badge>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-5">
          <div className="space-y-8">
            {CHANGELOG_DATA.map((release) => (
              <div key={release.version} className="relative pl-6 border-l-2 border-border/80 space-y-4">
                {/* Точка на таймлайне версий */}
                <div
                  className={`absolute -left-[9px] top-0 size-4 rounded-full border-2 bg-background flex items-center justify-center ${
                    release.isLatest ? "border-primary" : "border-muted-foreground/40"
                  }`}
                >
                  {release.isLatest && <div className="size-1.5 rounded-full bg-primary" />}
                </div>

                {/* Заголовок релиза */}
                <div>
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className="font-mono font-bold text-base text-foreground">
                      v{release.version}
                    </span>
                    <span className="text-xs text-muted-foreground">• {release.date}</span>
                    {release.badge && (
                      <Badge className="bg-primary/15 text-primary border-primary/30 text-[10px] py-0 px-2 h-4">
                        {release.badge}
                      </Badge>
                    )}
                  </div>
                  <h3 className="text-sm font-semibold text-foreground/90">{release.title}</h3>
                </div>

                {/* Секции изменений */}
                <div className="space-y-3.5 pt-1">
                  {release.sections.map((section) => {
                    const cfg = CATEGORY_CONFIG[section.category];
                    return (
                      <div key={section.category} className="space-y-2">
                        <Badge
                          variant="outline"
                          className={`text-[10px] font-semibold py-0.5 px-2 ${cfg.color}`}
                        >
                          {cfg.label}
                        </Badge>
                        <div className="grid gap-2">
                          {section.items.map((item, idx) => {
                            const IconComponent = item.icon || Sparkles;
                            return (
                              <div
                                key={idx}
                                className="p-2.5 rounded-lg border border-border/60 bg-card/60 hover:bg-muted/20 transition-colors flex items-start gap-2.5 text-left"
                              >
                                <div className="size-5 rounded-md bg-muted flex items-center justify-center shrink-0 mt-0.5 text-muted-foreground">
                                  <IconComponent className="size-3" />
                                </div>
                                <div className="min-w-0">
                                  <div className="text-xs font-semibold text-foreground leading-snug">
                                    {item.title}
                                  </div>
                                  {item.desc && (
                                    <div className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">
                                      {item.desc}
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="p-3 border-t border-border/60 bg-muted/20 text-center">
          <span className="text-[11px] text-muted-foreground font-mono">
            Версия билда: {APP_VERSION}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
};
