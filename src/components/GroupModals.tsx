import React, { useState, useEffect } from "react";
import { Group, User } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Clock,
  Crown,
  LogOut,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  Settings,
  X,
} from "lucide-react";
import { toast } from "sonner";

interface CreateGroupModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentUser: User;
  onGroupCreated: (newGroupId: number) => Promise<void>;
}

export const CreateGroupModal: React.FC<CreateGroupModalProps> = ({
  open,
  onOpenChange,
  currentUser,
  onGroupCreated,
}) => {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedUsernames, setSelectedUsernames] = useState<string[]>([]);
  const [customUsername, setCustomUsername] = useState("");
  const [loading, setLoading] = useState(false);

  const handleAddCustom = () => {
    const clean = customUsername.trim().replace(/^@/, "").toLowerCase();
    if (!clean) return;
    if (clean === currentUser.username.toLowerCase()) {
      toast.error("Вы уже являетесь создателем группы");
      return;
    }
    if (!selectedUsernames.includes(clean)) {
      setSelectedUsernames((prev) => [...prev, clean]);
    }
    setCustomUsername("");
  };

  const removeUsername = (uname: string) => {
    setSelectedUsernames((prev) => prev.filter((u) => u !== uname));
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Введите название группы");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          owner_id: currentUser.id,
          invite_usernames: selectedUsernames,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ошибка создания группы");

      toast.success(`Группа «${name.trim()}» создана`);
      setName("");
      setDescription("");
      setSelectedUsernames([]);
      await onGroupCreated(data.id);
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Новая группа</DialogTitle>
          <DialogDescription>
            Создайте общую группу и пригласите друзей по их @username
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleCreate} className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <Label htmlFor="grp-name">Название</Label>
            <Input
              id="grp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Например: Выживание /Тусовка"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="grp-desc">Описание (необязательно)</Label>
            <Input
              id="grp-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Короткая заметка о группе"
            />
          </div>

          <div className="space-y-2">
            <Label>Пригласить по @username</Label>
            <div className="flex gap-2">
              <Input
                value={customUsername}
                onChange={(e) => setCustomUsername(e.target.value)}
                placeholder="Введите @username друга..."
                className="font-mono text-sm"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddCustom();
                  }
                }}
              />
              <Button type="button" variant="secondary" onClick={handleAddCustom}>
                Добавить
              </Button>
            </div>

            {selectedUsernames.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {selectedUsernames.map((uname) => (
                  <Badge key={uname} variant="secondary" className="gap-1 font-mono">
                    @{uname}
                    <button
                      type="button"
                      onClick={() => removeUsername(uname)}
                      className="ml-1 hover:text-destructive cursor-pointer"
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={loading}>
              Создать
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

interface GroupSettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: Group | null;
  currentUser: User;
  defaultTab?: "members" | "settings";
  onGroupUpdated: () => Promise<void>;
  onGroupDeletedOrLeft: () => Promise<void>;
}

export const GroupSettingsModal: React.FC<GroupSettingsModalProps> = ({
  open,
  onOpenChange,
  group,
  currentUser,
  defaultTab = "members",
  onGroupUpdated,
  onGroupDeletedOrLeft,
}) => {
  const [activeTab, setActiveTab] = useState<string>(defaultTab);
  const [usernameInput, setUsernameInput] = useState("");
  const [groupName, setGroupName] = useState("");
  const [groupDesc, setGroupDesc] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (group && open) {
      setGroupName(group.name || "");
      setGroupDesc(group.description || "");
      setConfirmDelete(false);
      setActiveTab(defaultTab);
    }
  }, [group, open, defaultTab]);

  if (!group) return null;

  const isOwner = group.owner_id === currentUser.id;

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = usernameInput.trim().replace(/^@/, "");
    if (!clean) {
      toast.error("Введите @username");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/groups/${group.id}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: clean,
          invited_by: currentUser.id,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ошибка приглашения");

      toast.success(`Приглашение отправлено @${clean}`);
      setUsernameInput("");
      await onGroupUpdated();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupName.trim()) {
      toast.error("Название группы не может быть пустым");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/groups/${group.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: groupName.trim(),
          description: groupDesc.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Не удалось обновить группу");

      toast.success("Настройки группы сохранены");
      await onGroupUpdated();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveMember = async (targetUserId: number, displayLabel: string, isPending: boolean) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/groups/${group.id}/members/${targetUserId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error("Не удалось удалить участника");

      toast.success(
        isPending
          ? `Приглашение для ${displayLabel} отменено`
          : `${displayLabel} исключён из группы`
      );
      await onGroupUpdated();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleTransferOwner = async (newOwnerId: number, newOwnerName: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/groups/${group.id}/transfer-owner`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_owner_id: newOwnerId }),
      });
      if (!res.ok) throw new Error("Не удалось передать права владельца");

      toast.success(`Права владельца группы переданы ${newOwnerName}`);
      await onGroupUpdated();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleLeaveGroup = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/groups/${group.id}/members/${currentUser.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error("Не удалось покинуть группу");

      toast.success(`Вы покинули группу «${group.name}»`);
      onOpenChange(false);
      await onGroupDeletedOrLeft();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteGroup = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/groups/${group.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error("Не удалось удалить группу");

      toast.success(`Группа «${group.name}» удалена`);
      onOpenChange(false);
      await onGroupDeletedOrLeft();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Модалка на полную высоту экрана точно так же, как модалка профиля */}
      <DialogContent className="sm:max-w-[680px] p-0 overflow-hidden gap-0 top-4 bottom-4 translate-y-0 h-[calc(100vh-2rem)] max-h-[calc(100vh-2rem)] flex flex-col">
        <div className="flex flex-col sm:flex-row flex-1 h-full overflow-hidden">
          {/* ЛЕВОЕ МЕНЮ В СТИЛЕ МОДАЛКИ ПРОФИЛЯ */}
          <div className="w-full sm:w-52 shrink-0 border-b sm:border-b-0 sm:border-r border-border bg-muted/25 p-3 flex flex-col justify-between gap-4">
            <div className="space-y-1">
              <div className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
                {group.name}
              </div>

              <button
                type="button"
                onClick={() => setActiveTab("members")}
                className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs font-medium cursor-pointer ${
                  activeTab === "members"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Users className="size-3.5 shrink-0" />
                  <span>Участники</span>
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-muted text-muted-foreground">
                  {group.members.length}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab("settings")}
                className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs font-medium cursor-pointer ${
                  activeTab === "settings"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                <Settings className="size-3.5 shrink-0" />
                <span>Настройки</span>
              </button>
            </div>

            <div className="space-y-1">
              <button
                type="button"
                disabled={loading}
                onClick={handleLeaveGroup}
                className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs font-medium text-destructive hover:bg-destructive/10 cursor-pointer"
              >
                <span>Покинуть группу</span>
                <LogOut className="size-3.5 shrink-0" />
              </button>
            </div>
          </div>

          {/* ПРАВАЯ ОБЛАСТЬ КОНТЕНТА */}
          <div className="flex-1 flex flex-col justify-between p-5 min-w-0 overflow-y-auto">
            {activeTab === "members" ? (
              <div className="flex-1 flex flex-col justify-between min-h-0">
                <div className="space-y-4 flex-1 flex flex-col min-h-0">
                  <div>
                    <DialogTitle className="text-base font-semibold">
                      Участники группы «{group.name}»
                    </DialogTitle>
                    <DialogDescription className="text-xs">
                      Приглашайте участников по @username и управляйте составом группы
                    </DialogDescription>
                  </div>

                  <form onSubmit={handleInvite} className="space-y-1.5 shrink-0">
                    <Label>Пригласить участника по @username</Label>
                    <div className="flex gap-2">
                      <Input
                        value={usernameInput}
                        onChange={(e) => setUsernameInput(e.target.value)}
                        placeholder="Введите @username друга..."
                        className="font-mono text-sm"
                      />
                      <Button type="submit" disabled={loading || !usernameInput.trim()}>
                        <UserPlus className="size-3.5" />
                        Пригласить
                      </Button>
                    </div>
                  </form>

                  <div className="space-y-2 border-t border-border pt-3 flex-1 flex flex-col min-h-0">
                    <Label className="text-xs text-muted-foreground shrink-0">
                      Состав группы ({group.members.length})
                    </Label>

                    <div className="space-y-1.5 flex-1 overflow-y-auto pr-1">
                      {group.members.map((m) => {
                        const isMemberOwner = m.user_id === group.owner_id;
                        const isMe = m.user_id === currentUser.id;
                        const cleanName = m.display_name.replace(" (Вы)", "");

                        return (
                          <div
                            key={m.user_id}
                            className="flex items-center justify-between gap-2 p-2.5 rounded-lg border border-border bg-background/50"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <span
                                className="size-7 rounded-full overflow-hidden flex items-center justify-center text-white font-semibold text-[11px] shrink-0"
                                style={{
                                  backgroundColor: m.avatar_url ? undefined : m.avatar_color,
                                }}
                              >
                                {m.avatar_url ? (
                                  <img
                                    src={m.avatar_url}
                                    alt={cleanName}
                                    className="size-full object-cover"
                                  />
                                ) : (
                                  cleanName.slice(0, 1).toUpperCase()
                                )}
                              </span>
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-xs font-medium text-foreground truncate">
                                    {cleanName}
                                  </span>
                                  {isMe && (
                                    <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                                      Вы
                                    </Badge>
                                  )}
                                  {isMemberOwner && (
                                    <Badge
                                      variant="outline"
                                      className="h-4 px-1.5 text-[10px] gap-0.5"
                                    >
                                      <Crown className="size-2.5 text-amber-500" />
                                      Владелец
                                    </Badge>
                                  )}
                                  {m.status === "pending" && (
                                    <Badge
                                      variant="partial"
                                      className="h-4 px-1.5 text-[10px] gap-0.5"
                                    >
                                      <Clock className="size-2.5" />
                                      ожидает
                                    </Badge>
                                  )}
                                </div>
                                <div className="text-[11px] font-mono text-muted-foreground truncate">
                                  @{m.username}
                                </div>
                              </div>
                            </div>

                            {isOwner && !isMe && (
                              <div className="flex items-center gap-1 shrink-0">
                                {m.status === "accepted" && (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-xs"
                                    disabled={loading}
                                    onClick={() => handleTransferOwner(m.user_id, cleanName)}
                                    title="Передать права владельца группы"
                                  >
                                    <Crown className="size-3.5 text-muted-foreground hover:text-amber-500" />
                                  </Button>
                                )}
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-xs"
                                  disabled={loading}
                                  onClick={() =>
                                    handleRemoveMember(
                                      m.user_id,
                                      `@${m.username}`,
                                      m.status === "pending"
                                    )
                                  }
                                  title={
                                    m.status === "pending"
                                      ? "Отменить приглашение"
                                      : "Исключить из группы"
                                  }
                                >
                                  <UserMinus className="size-3.5 text-muted-foreground hover:text-destructive" />
                                </Button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-4 mt-4 shrink-0">
                  <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                    Закрыть
                  </Button>
                </div>
              </div>
            ) : (
              <form
                onSubmit={handleSaveSettings}
                className="flex-1 flex flex-col justify-between"
              >
                <div className="space-y-4">
                  <div>
                    <DialogTitle className="text-base font-semibold">
                      Настройки группы «{group.name}»
                    </DialogTitle>
                    <DialogDescription className="text-xs">
                      Измените название, описание или параметры группы
                    </DialogDescription>
                  </div>

                  <div className="space-y-3 pt-1">
                    <div className="space-y-1.5">
                      <Label htmlFor="edit-grp-name">Название группы</Label>
                      <Input
                        id="edit-grp-name"
                        value={groupName}
                        onChange={(e) => setGroupName(e.target.value)}
                        placeholder="Название группы"
                        required
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="edit-grp-desc">Описание группы</Label>
                      <Input
                        id="edit-grp-desc"
                        value={groupDesc}
                        onChange={(e) => setGroupDesc(e.target.value)}
                        placeholder="Заметка или описание для участников..."
                      />
                    </div>
                  </div>

                  <div className="border-t border-border pt-4 space-y-2.5">
                    <Label className="text-xs text-muted-foreground">Действия с группой</Label>

                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-border bg-background/40">
                        <div className="min-w-0">
                          <div className="text-xs font-medium">Покинуть группу</div>
                          <div className="text-[11px] text-muted-foreground">
                            Вы перестанете видеть расписание этой группы
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={loading}
                          onClick={handleLeaveGroup}
                          className="shrink-0"
                        >
                          <LogOut className="size-3.5" />
                          Выйти
                        </Button>
                      </div>

                      {isOwner && (
                        <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-destructive/30 bg-destructive/5">
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-destructive">
                              Удалить группу
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              Группа и список её участников будут удалены навсегда
                            </div>
                          </div>

                          {!confirmDelete ? (
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              disabled={loading}
                              onClick={() => setConfirmDelete(true)}
                              className="shrink-0"
                            >
                              <Trash2 className="size-3.5" />
                              Удалить
                            </Button>
                          ) : (
                            <div className="flex items-center gap-1.5 shrink-0">
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                onClick={() => setConfirmDelete(false)}
                              >
                                Отмена
                              </Button>
                              <Button
                                type="button"
                                variant="destructive"
                                size="xs"
                                disabled={loading}
                                onClick={handleDeleteGroup}
                              >
                                Точно удалить
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-4 mt-4">
                  <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                    Отмена
                  </Button>
                  <Button type="submit" disabled={loading}>
                    Сохранить
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
