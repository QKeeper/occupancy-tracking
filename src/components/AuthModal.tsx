import React, { useState, useEffect, useRef } from "react";
import { TimelineGroup, TimelineStyleConfig, User } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { ImageCropperModal, NormalizedCrop } from "@/components/ui/image-cropper-modal";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@/components/ui/select";
import {
  loginSchema,
  registerSchema,
  profileSchema,
  changePasswordSchema,
  extractZodErrors,
} from "@/lib/validators";
import {
  DEFAULT_TIMELINE_STYLE,
  MAX_ICON_HISTORY,
  TELEGRAM_PATTERN_SYMBOLS,
  TintedPatternIcon,
  getTimelineBlockStyle,
} from "@/lib/timeline-pattern";
import {
  DEFAULT_SCHEDULE_TIMEZONE,
  formatTimeZoneOptionLabel,
  getAvailableTimeZoneOptions,
  getUserTimelineGroups,
  isValidTimeZone,
  normalizeTimeZone,
} from "@/lib/schedule-engine";
import {
  ArrowRightLeft,
  Camera,
  Check,
  Globe,
  ImagePlus,
  KeyRound,
  LogOut,
  Palette,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  User as UserIcon,
} from "lucide-react";
import { toast } from "sonner";

export const AVATAR_COLORS = [
  "#3B82F6",
  "#8B5CF6",
  "#EC4899",
  "#F97316",
  "#10B981",
  "#06B6D4",
  "#71717A",
];

const TIMELINE_BG_PRESETS = [
  { label: "Алый", bg: "#e11d48", pattern: "#fda4af" },
  { label: "Фиолетовый", bg: "#7c3aed", pattern: "#ddd6fe" },
  { label: "Синий", bg: "#2563eb", pattern: "#bfdbfe" },
  { label: "Изумрудный", bg: "#059669", pattern: "#a7f3d0" },
  { label: "Янтарный", bg: "#d97706", pattern: "#fde68a" },
  { label: "Розовый", bg: "#db2777", pattern: "#fbcfe8" },
];

function readFileAsDataUrl(file: File, maxMb = 12): Promise<string> {
  return new Promise((resolve, reject) => {
    const validTypes = [
      "image/png",
      "image/gif",
      "image/jpeg",
      "image/webp",
      "image/svg+xml",
    ];
    if (!validTypes.includes(file.type)) {
      reject(new Error("Поддерживаются форматы SVG, PNG, GIF, WEBP и JPG"));
      return;
    }
    if (file.size > maxMb * 1024 * 1024) {
      reject(new Error(`Размер файла не должен превышать ${maxMb} МБ`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
    reader.readAsDataURL(file);
  });
}

function buildInitialIconHistory(savedHistory?: string[], currentSymbol?: string): string[] {
  const base =
    Array.isArray(savedHistory) && savedHistory.length > 0
      ? savedHistory.filter((s) => s !== "🐾")
      : [...TELEGRAM_PATTERN_SYMBOLS];

  // Ensure default presets (without 🐾) fill up to MAX_ICON_HISTORY
  for (const preset of TELEGRAM_PATTERN_SYMBOLS) {
    if (!base.includes(preset)) {
      base.push(preset);
    }
  }

  if (currentSymbol && currentSymbol !== "🐾") {
    return [currentSymbol, ...base.filter((s) => s !== currentSymbol)].slice(
      0,
      MAX_ICON_HISTORY
    );
  }
  return base.slice(0, MAX_ICON_HISTORY);
}

export interface SavedAccount {
  id: number;
  username: string;
  display_name: string;
  avatar_color: string;
  avatar_url?: string | null;
  requiresPassword?: boolean;
}

// ============================================================================
// 1. ЛИЧНЫЙ КАБИНЕТ В СТИЛЕ DISCORD (На полную высоту, без нижнего дивайдера)
// ============================================================================
interface ProfileCabinetModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentUser: User;
  savedAccounts: SavedAccount[];
  onSelectSavedAccount: (accountId: number) => void;
  onRemoveSavedAccount: (accountId: number) => void;
  onUpdateProfile: (updated: Partial<User>) => Promise<void>;
  onOpenAddAccount: () => void;
  onLogout: () => void;
}

export const ProfileCabinetModal: React.FC<ProfileCabinetModalProps> = ({
  open,
  onOpenChange,
  currentUser,
  savedAccounts,
  onSelectSavedAccount,
  onRemoveSavedAccount,
  onUpdateProfile,
  onOpenAddAccount,
  onLogout,
}) => {
  const [section, setSection] = useState<"profile" | "password" | "accounts">(
    "profile"
  );

  const [displayName, setDisplayName] = useState(currentUser.display_name);
  const [username, setUsername] = useState(currentUser.username);
  const [avatarColor, setAvatarColor] = useState(currentUser.avatar_color || "#3B82F6");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(currentUser.avatar_url || null);
  const [bannerUrl, setBannerUrl] = useState<string | null>(currentUser.banner_url || null);
  const [timeZone, setTimeZone] = useState<string>(
    normalizeTimeZone(currentUser.time_zone || DEFAULT_SCHEDULE_TIMEZONE)
  );


  // Password change fields inside the "password" tab
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [passwordErrors, setPasswordErrors] = useState<Record<string, string>>({});

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [cropState, setCropState] = useState<{
    open: boolean;
    kind: "avatar" | "banner";
    src: string | null;
  }>({ open: false, kind: "avatar", src: null });

  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [editRevision, setEditRevision] = useState(currentUser.revision);
  const bannerInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setEditRevision(currentUser.revision);
      setDisplayName(currentUser.display_name);
      setUsername(currentUser.username);
      setAvatarColor(currentUser.avatar_color || "#3B82F6");
      setAvatarUrl(currentUser.avatar_url || null);
      setBannerUrl(currentUser.banner_url || null);
      setTimeZone(normalizeTimeZone(currentUser.time_zone || DEFAULT_SCHEDULE_TIMEZONE));
      setCurrentPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
      setPasswordErrors({});
      setErrors({});
    }
  }, [open, currentUser.id]);

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setCropState({ open: true, kind: "avatar", src: dataUrl });
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const handleBannerUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setCropState({ open: true, kind: "banner", src: dataUrl });
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const handleConfirmCrop = async (crop: NormalizedCrop) => {
    if (!cropState.src) return;
    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dataUrl: cropState.src,
          kind: cropState.kind,
          crop,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ошибка кадрирования и загрузки");
      if (cropState.kind === "avatar") {
        setAvatarUrl(data.url);
        toast.success("Аватарка кадрирована и загружена (не забудьте сохранить)");
      } else {
        setBannerUrl(data.url);
        toast.success("Баннер кадрирован и загружен (не забудьте сохранить)");
      }
    } catch (err: any) {
      toast.error(err.message);
      throw err;
    }
  };

  const handleSaveProfileOrTimeline = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});

    const parsed = profileSchema.safeParse({
      display_name: displayName,
      username,
      avatar_color: avatarColor,
      time_zone: timeZone,
    });

    if (!parsed.success) {
      setErrors(extractZodErrors(parsed.error));
      setSection("profile");
      return;
    }

    setLoading(true);
    try {
      await onUpdateProfile({
        revision: editRevision,
        ...parsed.data,
        time_zone: normalizeTimeZone(timeZone),
        avatar_url: avatarUrl,
        banner_url: bannerUrl,
        timeline_style: currentUser.timeline_style,
        timeline_groups: currentUser.timeline_groups,
      });
      toast.success("Настройки профиля сохранены");
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || "Ошибка сохранения профиля");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitPasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordErrors({});

    const parsed = changePasswordSchema.safeParse({
      currentPassword,
      newPassword,
      confirmNewPassword,
    });

    if (!parsed.success) {
      setPasswordErrors(extractZodErrors(parsed.error));
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/users/${currentUser.id}/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: parsed.data.currentPassword,
          newPassword: parsed.data.newPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Не удалось изменить пароль");

      toast.success("Пароль успешно изменён");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
      setSection("profile");
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Модалка на полную высоту экрана (с небольшим отступом top-4 bottom-4) */}
      <DialogContent className="sm:max-w-[680px] p-0 overflow-hidden gap-0 top-4 bottom-4 translate-y-0 h-[calc(100vh-2rem)] max-h-[calc(100vh-2rem)] flex flex-col">
        <div className="flex flex-col sm:flex-row flex-1 h-full overflow-hidden">
          {/* ЛЕВОЕ МЕНЮ В СТИЛЕ НАСТРОЕК DISCORD */}
          <div className="w-full sm:w-52 shrink-0 border-b sm:border-b-0 sm:border-r border-border bg-muted/25 p-3 flex flex-col justify-between gap-4">
            <div className="space-y-1">
              <div className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Настройки юзера
              </div>

              <button
                type="button"
                onClick={() => setSection("profile")}
                className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs font-medium cursor-pointer ${
                  section === "profile"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                <UserIcon className="size-3.5 shrink-0" />
                <span>Профиль</span>
              </button>

              <button
                type="button"
                onClick={() => setSection("password")}
                className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs font-medium cursor-pointer ${
                  section === "password"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                <KeyRound className="size-3.5 shrink-0" />
                <span>Изменить пароль</span>
              </button>
            </div>

            {/* Нижние кнопки без дивайдера: Сменить аккаунт, Добавить аккаунт, Выйти */}
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => setSection("accounts")}
                className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs font-medium cursor-pointer ${
                  section === "accounts"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <ArrowRightLeft className="size-3.5 shrink-0" />
                  <span>Сменить аккаунт</span>
                </span>
                {savedAccounts.length > 0 && (
                  <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-muted text-muted-foreground">
                    {savedAccounts.length}
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  onOpenAddAccount();
                }}
                className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground cursor-pointer"
              >
                <Plus className="size-3.5 shrink-0" />
                <span>Добавить аккаунт</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  onLogout();
                  onOpenChange(false);
                }}
                className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs font-medium text-destructive hover:bg-destructive/10 cursor-pointer"
              >
                <span>Выйти</span>
                <LogOut className="size-3.5 shrink-0" />
              </button>
            </div>
          </div>

          {/* ПРАВАЯ ОБЛАСТЬ КОНТЕНТА */}
          <div className="flex-1 flex flex-col justify-between p-5 min-w-0 overflow-y-auto">
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/png,image/gif,image/webp,image/jpeg"
              onChange={handleAvatarUpload}
              className="hidden"
            />
            <input
              ref={bannerInputRef}
              type="file"
              accept="image/png,image/gif,image/webp,image/jpeg"
              onChange={handleBannerUpload}
              className="hidden"
            />

            {section === "accounts" ? (
              /* СЕКЦИЯ 4: СМЕНИТЬ АККАУНТ (Список всех сохранённых аккаунтов + кнопка Добавить аккаунт) */
              <div className="flex-1 flex flex-col justify-between">
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <DialogTitle className="text-base font-semibold">
                        Сменить аккаунт
                      </DialogTitle>
                      <DialogDescription className="text-xs">
                        Переключайтесь между аккаунтами в один клик или добавьте новый
                      </DialogDescription>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => {
                        onOpenChange(false);
                        onOpenAddAccount();
                      }}
                    >
                      <Plus className="size-3.5" />
                      Добавить аккаунт
                    </Button>
                  </div>

                  <div className="space-y-2 pt-1">
                    {savedAccounts.map((acc) => {
                      const isCurrent = acc.id === currentUser.id;
                      return (
                        <div
                          key={acc.id}
                          className={`flex items-center justify-between gap-3 p-3 rounded-xl border ${
                            isCurrent
                              ? "border-primary/50 bg-accent/50"
                              : "border-border bg-card/60 hover:bg-muted/40"
                          }`}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <span
                              className="size-10 rounded-full overflow-hidden flex items-center justify-center text-white font-semibold text-sm shrink-0"
                              style={{
                                backgroundColor: acc.avatar_url
                                  ? undefined
                                  : acc.avatar_color || "#3B82F6",
                              }}
                            >
                              {acc.avatar_url ? (
                                <img
                                  src={acc.avatar_url}
                                  alt={acc.display_name}
                                  className="size-full object-cover"
                                />
                              ) : (
                                acc.display_name.slice(0, 1).toUpperCase()
                              )}
                            </span>

                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold text-foreground truncate">
                                  {acc.display_name}
                                </span>
                                {isCurrent && (
                                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-primary text-primary-foreground">
                                    Активен
                                  </span>
                                )}
                                {acc.requiresPassword && (
                                  <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">Нужен пароль</span>
                                )}
                              </div>
                              <div className="text-xs font-mono text-muted-foreground truncate">
                                @{acc.username}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            {(!isCurrent || acc.requiresPassword) && (
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                onClick={() => {
                                  onSelectSavedAccount(acc.id);
                                  onOpenChange(false);
                                }}
                              >
                                {acc.requiresPassword ? "Войти" : "Переключиться"}
                              </Button>
                            )}
                            {!isCurrent && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => onRemoveSavedAccount(acc.id)}
                                title="Удалить из сохранённых"
                                className="text-muted-foreground hover:text-destructive"
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-4 mt-4">
                  <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                    Закрыть
                  </Button>
                </div>
              </div>
            ) : section === "password" ? (
              /* СЕКЦИЯ 3: ИЗМЕНЕНИЕ ПАРОЛЯ (Внутри той же модалки, с возможностью переключиться обратно) */
              <form onSubmit={handleSubmitPasswordChange} className="flex-1 flex flex-col justify-between">
                <div className="space-y-4">
                  <div>
                    <DialogTitle className="text-base font-semibold">Изменение пароля</DialogTitle>
                    <DialogDescription className="text-xs">
                      Укажите текущий пароль и введите новый пароль дважды
                    </DialogDescription>
                  </div>

                  <div className="space-y-3 pt-1">
                    <div className="space-y-1.5">
                      <Label htmlFor="cp-current">Текущий пароль</Label>
                      <PasswordInput
                        id="cp-current"
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        placeholder="Введите текущий пароль"
                        aria-invalid={!!passwordErrors.currentPassword}
                      />
                      {passwordErrors.currentPassword && (
                        <p className="text-[11px] text-destructive">
                          {passwordErrors.currentPassword}
                        </p>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="cp-new">Новый пароль</Label>
                      <PasswordInput
                        id="cp-new"
                        value={newPassword}
                        onChange={(e) => {
                          const val = e.target.value;
                          setNewPassword(val);
                          setPasswordErrors((prev) => ({
                            ...prev,
                            newPassword:
                              val.length > 0 && val.length < 4
                                ? "Минимум 4 символа"
                                : "",
                            confirmNewPassword:
                              confirmNewPassword.length > 0 && val !== confirmNewPassword
                                ? "Новые пароли не совпадают"
                                : "",
                          }));
                        }}
                        placeholder="Минимум 4 символа"
                        aria-invalid={!!passwordErrors.newPassword}
                      />
                      {passwordErrors.newPassword && (
                        <p className="text-[11px] text-destructive">{passwordErrors.newPassword}</p>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="cp-confirm">Подтвердите новый пароль</Label>
                      <PasswordInput
                        id="cp-confirm"
                        value={confirmNewPassword}
                        onChange={(e) => {
                          const val = e.target.value;
                          setConfirmNewPassword(val);
                          setPasswordErrors((prev) => ({
                            ...prev,
                            confirmNewPassword:
                              val.length > 0 && newPassword !== val
                                ? "Новые пароли не совпадают"
                                : "",
                          }));
                        }}
                        placeholder="Повторите новый пароль"
                        aria-invalid={!!passwordErrors.confirmNewPassword}
                      />
                      {passwordErrors.confirmNewPassword && (
                        <p className="text-[11px] text-destructive">
                          {passwordErrors.confirmNewPassword}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-4 mt-4">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setSection("profile")}
                  >
                    Назад к профилю
                  </Button>
                  <Button type="submit" disabled={loading}>
                    Обновить пароль
                  </Button>
                </div>
              </form>
            ) : (
              <form
                onSubmit={handleSaveProfileOrTimeline}
                className="flex-1 flex flex-col justify-between"
              >
                  /* СЕКЦИЯ 1: ПРОФИЛЬ (Прямое редактирование на карточке Discord) */
                  <div className="space-y-4">
                    <div>
                      <DialogTitle className="text-base font-semibold">Профиль</DialogTitle>
                      <DialogDescription className="text-xs">
                        Нажмите прямо на баннер, аватарку или имя на карточке, чтобы изменить их
                      </DialogDescription>
                    </div>

                    <div className="rounded-xl border border-border bg-card overflow-hidden shadow-md">
                      {/* Баннер (поддерживает PNG и анимированные GIF, единое соотношение сторон 18:5 / 3.6:1) */}
                      <div
                        onClick={() => bannerInputRef.current?.click()}
                        className="group/banner relative aspect-[18/5] w-full cursor-pointer overflow-hidden"
                        style={{
                          backgroundColor: bannerUrl ? undefined : avatarColor,
                          backgroundImage: bannerUrl ? `url("${bannerUrl}")` : undefined,
                          backgroundSize: "cover",
                          backgroundPosition: "center",
                        }}
                      >
                        <div className="absolute inset-0 bg-black/45 opacity-0 group-hover/banner:opacity-100 flex items-center justify-center gap-1.5 text-xs font-medium text-white">
                          <ImagePlus className="size-4" />
                          <span>Изменить баннер (PNG / GIF)</span>
                        </div>

                        {bannerUrl && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setBannerUrl(null);
                            }}
                            title="Удалить баннер"
                            className="absolute top-2 right-2 z-10 size-7 rounded-full bg-black/60 text-white hover:bg-destructive flex items-center justify-center opacity-0 group-hover/banner:opacity-100 cursor-pointer"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        )}
                      </div>

                      {/* Тело карточки профиля */}
                      <div className="px-4 pb-4 relative">
                        <div className="flex items-end justify-between -mt-10 mb-3">
                          <div className="relative group/avatar">
                            <div
                              onClick={() => avatarInputRef.current?.click()}
                              className="size-20 rounded-full ring-4 ring-card bg-card overflow-hidden flex items-center justify-center text-white font-bold text-2xl cursor-pointer relative select-none"
                              style={{
                                backgroundColor: avatarUrl ? undefined : avatarColor,
                              }}
                            >
                              {avatarUrl ? (
                                <img
                                  src={avatarUrl}
                                  alt={displayName}
                                  className="size-full object-cover"
                                />
                              ) : (
                                (displayName || currentUser.display_name).slice(0, 1).toUpperCase()
                              )}

                              <div className="absolute inset-0 bg-black/55 opacity-0 group-hover/avatar:opacity-100 flex flex-col items-center justify-center text-[10px] font-medium text-white">
                                <Camera className="size-4 mb-0.5" />
                                <span>PNG/GIF</span>
                              </div>
                            </div>

                            {avatarUrl && (
                              <button
                                type="button"
                                onClick={() => setAvatarUrl(null)}
                                title="Сбросить аватарку"
                                className="absolute -bottom-0.5 -right-0.5 size-6 rounded-full bg-popover border border-border text-muted-foreground hover:text-destructive flex items-center justify-center shadow-sm cursor-pointer"
                              >
                                <Trash2 className="size-3" />
                              </button>
                            )}
                          </div>

                          {/* Выбор акцентного цвета (отображается только когда не выбрана кастомная аватарка) */}
                          {!avatarUrl && (
                            <div className="flex items-center gap-1.5 bg-muted/40 px-2.5 py-1.5 rounded-lg border border-border/60">
                              {AVATAR_COLORS.map((c) => (
                                <button
                                  key={c}
                                  type="button"
                                  onClick={() => setAvatarColor(c)}
                                  className="size-4 rounded-full flex items-center justify-center cursor-pointer hover:scale-110"
                                  style={{ backgroundColor: c }}
                                  title="Цвет дефолтного аватара"
                                >
                                  {avatarColor === c && <Check className="size-2.5 text-white" />}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Внутренняя плашка Discord с редактируемыми на месте именем и @username */}
                        <div className="rounded-lg bg-background/70 border border-border/70 p-3 space-y-2">
                          <div>
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                Отображаемое имя
                              </span>
                              <button
                                type="button"
                                onClick={() => nameInputRef.current?.focus()}
                                className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 cursor-pointer"
                              >
                                <Pencil className="size-2.5" />
                                изменить
                              </button>
                            </div>
                            <input
                              ref={nameInputRef}
                              value={displayName}
                              onChange={(e) => setDisplayName(e.target.value)}
                              placeholder="Ваше отображаемое имя"
                              className="w-full mt-0.5 bg-transparent hover:bg-muted/50 focus:bg-muted/70 rounded-md px-2 py-1 -mx-2 text-base font-bold text-foreground outline-none focus:ring-2 focus:ring-ring/50"
                            />
                            {errors.display_name && (
                              <p className="text-[11px] text-destructive mt-0.5">
                                {errors.display_name}
                              </p>
                            )}
                          </div>

                          <div className="border-t border-border/50 pt-2">
                            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground block">
                              Юзернейм
                            </span>
                            <div className="flex items-center mt-0.5 -mx-2 px-2 py-1 rounded-md hover:bg-muted/50 focus-within:bg-muted/70 focus-within:ring-2 focus-within:ring-ring/50">
                              <span className="text-xs font-mono text-muted-foreground select-none">
                                @
                              </span>
                              <input
                                value={username.replace(/^@/, "")}
                                onChange={(e) => setUsername(e.target.value.replace(/^@/, ""))}
                                placeholder="username"
                                className="w-full bg-transparent text-xs font-mono text-foreground outline-none ml-0.5"
                              />
                            </div>
                            {errors.username && (
                              <p className="text-[11px] text-destructive mt-0.5">
                                {errors.username}
                              </p>
                            )}
                          </div>

                          <div className="border-t border-border/50 pt-2">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1">
                                <Globe className="size-3" />
                                Часовой пояс
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  try {
                                    const detected =
                                      Intl.DateTimeFormat().resolvedOptions().timeZone;
                                    if (detected && isValidTimeZone(detected)) {
                                      setTimeZone(detected);
                                      toast.info(`Выбран пояс браузера: ${detected}`);
                                    }
                                  } catch {
                                    // ignore
                                  }
                                }}
                                className="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
                              >
                                определить авто
                              </button>
                            </div>
                            <Select
                              value={timeZone || DEFAULT_SCHEDULE_TIMEZONE}
                              onValueChange={(val) => setTimeZone(val)}
                            >
                              <SelectTrigger
                                id="profile-timezone-select"
                                data-testid="profile-timezone-select"
                                className="w-full mt-1 h-8 text-xs cursor-pointer"
                              >
                                <SelectValue placeholder="Выберите часовой пояс" />
                              </SelectTrigger>
                              <SelectContent className="max-h-64">
                                {getAvailableTimeZoneOptions(timeZone).map((opt) => (
                                  <SelectItem key={opt.value} value={opt.value}>
                                    {formatTimeZoneOptionLabel(opt)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <p className="text-[11px] text-muted-foreground mt-1">
                              Все даты и интервалы на таймлайнах пересчитываются в выбранный часовой пояс
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>


                {/* Нижняя панель сохранения без дивайдера */}
                <div className="flex items-center justify-end gap-2 pt-4 mt-4">
                  <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                    Отмена
                  </Button>
                  <Button type="submit" disabled={loading}>
                    Сохранить изменения
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      </DialogContent>

      <ImageCropperModal
        open={cropState.open}
        onOpenChange={(nextOpen) => setCropState((prev) => ({ ...prev, open: nextOpen }))}
        imageSrc={cropState.src}
        kind={cropState.kind}
        onConfirmCrop={handleConfirmCrop}
      />
    </Dialog>
  );
};

// ============================================================================
// 2. ОТДЕЛЬНАЯ МОДАЛКА АВТОРИЗАЦИИ / СМЕНЫ АККАУНТА (Вход и Регистрация с Zod)
// ============================================================================
interface AuthModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialUsername?: string;
  onSelectUser: (user: User) => Promise<void>;
  onUserRegistered: (user: User) => Promise<void>;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  open,
  onOpenChange,
  initialUsername = "",
  onSelectUser,
  onUserRegistered,
}) => {
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginErrors, setLoginErrors] = useState<Record<string, string>>({});

  const [regUsername, setRegUsername] = useState("");
  const [regName, setRegName] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regConfirmPassword, setRegConfirmPassword] = useState("");
  const [regColor, setRegColor] = useState("#3B82F6");
  const [regErrors, setRegErrors] = useState<Record<string, string>>({});

  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setLoginUsername(initialUsername);
      setLoginErrors({});
      setRegErrors({});
      setLoginPassword("");
      setRegPassword("");
      setRegConfirmPassword("");
    }
  }, [open, initialUsername]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginErrors({});

    const parsed = loginSchema.safeParse({
      username: loginUsername,
      password: loginPassword,
    });

    if (!parsed.success) {
      setLoginErrors(extractZodErrors(parsed.error));
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ошибка входа");
      toast.success(`Вы вошли как @${data.username}`);
      onOpenChange(false);
      await onSelectUser(data);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegErrors({});

    const parsed = registerSchema.safeParse({
      username: regUsername,
      display_name: regName,
      password: regPassword,
      confirmPassword: regConfirmPassword,
      avatar_color: regColor,
    });

    if (!parsed.success) {
      setRegErrors(extractZodErrors(parsed.error));
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: parsed.data.username,
          display_name: parsed.data.display_name,
          password: parsed.data.password,
          avatar_color: parsed.data.avatar_color,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ошибка регистрации");
      toast.success(`Аккаунт @${data.username} создан`);
      await onUserRegistered(data);
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Авторизация</DialogTitle>
          <DialogDescription>
            Войдите в существующий аккаунт или создайте новый
          </DialogDescription>
        </DialogHeader>

        <Tabs key={`${open}:${initialUsername}`} defaultValue="login" className="pt-1">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="login">Вход</TabsTrigger>
            <TabsTrigger value="register">Регистрация</TabsTrigger>
          </TabsList>

          <TabsContent value="login" className="pt-3">
            <form onSubmit={handleLogin} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="modal-login-uname">Ваш @username</Label>
                <Input
                  id="modal-login-uname"
                  value={loginUsername}
                  onChange={(e) => setLoginUsername(e.target.value)}
                  placeholder="username"
                  className="font-mono"
                  aria-invalid={!!loginErrors.username}
                />
                {loginErrors.username && (
                  <p className="text-[11px] text-destructive">{loginErrors.username}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="modal-login-pass">Пароль</Label>
                <PasswordInput
                  id="modal-login-pass"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="Введите пароль"
                  aria-invalid={!!loginErrors.password}
                />
                {loginErrors.password && (
                  <p className="text-[11px] text-destructive">{loginErrors.password}</p>
                )}
              </div>

              <Button type="submit" className="w-full" disabled={loading}>
                Войти
              </Button>
            </form>
          </TabsContent>

          <TabsContent value="register" className="pt-3">
            <form onSubmit={handleRegister} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="modal-reg-uname">Username</Label>
                <Input
                  id="modal-reg-uname"
                  value={regUsername}
                  onChange={(e) => setRegUsername(e.target.value)}
                  placeholder="username"
                  className="font-mono"
                  aria-invalid={!!regErrors.username}
                />
                {regErrors.username && (
                  <p className="text-[11px] text-destructive">{regErrors.username}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="modal-reg-name">Отображаемое имя</Label>
                <Input
                  id="modal-reg-name"
                  value={regName}
                  onChange={(e) => setRegName(e.target.value)}
                  placeholder="Ваше имя"
                  aria-invalid={!!regErrors.display_name}
                />
                {regErrors.display_name && (
                  <p className="text-[11px] text-destructive">{regErrors.display_name}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="modal-reg-pass">Пароль</Label>
                <PasswordInput
                  id="modal-reg-pass"
                  value={regPassword}
                  onChange={(e) => {
                    const val = e.target.value;
                    setRegPassword(val);
                    setRegErrors((prev) => ({
                      ...prev,
                      password:
                        val.length > 0 && val.length < 4
                          ? "Пароль должен содержать минимум 4 символа"
                          : "",
                      confirmPassword:
                        regConfirmPassword.length > 0 && val !== regConfirmPassword
                          ? "Пароли не совпадают"
                          : "",
                    }));
                  }}
                  placeholder="Минимум 4 символа"
                  aria-invalid={!!regErrors.password}
                />
                {regErrors.password && (
                  <p className="text-[11px] text-destructive">{regErrors.password}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="modal-reg-confirm">Подтверждение пароля</Label>
                <PasswordInput
                  id="modal-reg-confirm"
                  value={regConfirmPassword}
                  onChange={(e) => {
                    const val = e.target.value;
                    setRegConfirmPassword(val);
                    setRegErrors((prev) => ({
                      ...prev,
                      confirmPassword:
                        val.length > 0 && regPassword !== val ? "Пароли не совпадают" : "",
                    }));
                  }}
                  placeholder="Повторите пароль"
                  aria-invalid={!!regErrors.confirmPassword}
                />
                {regErrors.confirmPassword && (
                  <p className="text-[11px] text-destructive">{regErrors.confirmPassword}</p>
                )}
              </div>

              <div className="flex items-center justify-between py-1">
                <span className="text-xs font-medium text-muted-foreground">Цвет аватара</span>
                <div className="flex gap-1.5">
                  {AVATAR_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setRegColor(c)}
                      className="size-5 rounded-full flex items-center justify-center cursor-pointer"
                      style={{ backgroundColor: c }}
                    >
                      {regColor === c && <Check className="size-3 text-white" />}
                    </button>
                  ))}
                </div>
              </div>

              <Button type="submit" className="w-full" disabled={loading}>
                Создать аккаунт
              </Button>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
};
