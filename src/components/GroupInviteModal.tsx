import React, { useState, useEffect } from "react";
import { User, GroupInviteInfo } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Users, AlertCircle, ArrowRight, Check, LogIn, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface GroupInviteModalProps {
  inviteCode: string | null;
  currentUser: User | null;
  onJoined: (groupId: number) => Promise<void>;
  onOpenAuth: () => void;
  onClose: () => void;
}

export const GroupInviteModal: React.FC<GroupInviteModalProps> = ({
  inviteCode,
  currentUser,
  onJoined,
  onOpenAuth,
  onClose,
}) => {
  const [inviteInfo, setInviteInfo] = useState<GroupInviteInfo | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [joining, setJoining] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!inviteCode) {
      setInviteInfo(null);
      setError(null);
      return;
    }

    let isCancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/invites/${encodeURIComponent(inviteCode)}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "Не удалось загрузить приглашение");
        }
        return data as GroupInviteInfo;
      })
      .then((data) => {
        if (!isCancelled) {
          setInviteInfo(data);
        }
      })
      .catch((err: any) => {
        if (!isCancelled) {
          setError(err.message || "Приглашение недействительно или ссылка устарела");
        }
      })
      .finally(() => {
        if (!isCancelled) {
          setLoading(false);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [inviteCode, currentUser?.id]);

  if (!inviteCode) return null;

  const isAlreadyMember = Boolean(
    inviteInfo &&
      currentUser &&
      (inviteInfo.my_status === "accepted" ||
        inviteInfo.owner.id === currentUser.id ||
        inviteInfo.members_preview.some((m) => m.user_id === currentUser.id))
  );

  const handleJoin = async () => {
    if (!inviteCode || !inviteInfo) return;
    setJoining(true);
    try {
      const res = await fetch(`/api/invites/${encodeURIComponent(inviteCode)}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Не удалось вступить в группу");
      }

      toast.success(data.message || `Вы вступили в группу «${inviteInfo.name}»`);
      await onJoined(data.group_id);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setJoining(false);
    }
  };

  const handleAlreadyMemberGo = async () => {
    if (!inviteInfo) return;
    toast.info(`Открываем группу «${inviteInfo.name}»`);
    await onJoined(inviteInfo.id);
  };

  return (
    <Dialog open={Boolean(inviteCode)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md p-6 sm:p-7 overflow-hidden text-center">
        {loading ? (
          <div className="py-12 flex flex-col items-center justify-center gap-3">
            <Loader2 className="size-8 text-primary animate-spin" />
            <p className="text-sm text-muted-foreground">Загрузка информации о приглашении...</p>
          </div>
        ) : error ? (
          <div className="py-6 flex flex-col items-center gap-4">
            <div className="size-16 rounded-full bg-destructive/10 text-destructive flex items-center justify-center">
              <AlertCircle className="size-8" />
            </div>
            <div className="space-y-1.5">
              <DialogTitle className="text-lg font-semibold">Ссылка недействительна</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground max-w-xs mx-auto">
                {error}
              </DialogDescription>
            </div>
            <Button variant="outline" onClick={onClose} className="mt-2">
              Закрыть
            </Button>
          </div>
        ) : inviteInfo ? (
          <div className="space-y-5">
            {/* Discord-style Top Header */}
            <div>
              <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase mb-1">
                Вас приглашают присоединиться к группе
              </div>
              <DialogTitle className="text-2xl font-bold tracking-tight text-foreground">
                {inviteInfo.name}
              </DialogTitle>
              {inviteInfo.description ? (
                <DialogDescription className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                  {inviteInfo.description}
                </DialogDescription>
              ) : null}
            </div>

            {/* Group Banner / Avatar Showcase */}
            <div className="flex flex-col items-center gap-3 py-2">
              <div className="size-20 rounded-2xl bg-gradient-to-br from-primary/20 via-primary/10 to-accent border-2 border-primary/20 shadow-sm flex items-center justify-center text-primary font-bold text-3xl">
                {inviteInfo.name.trim().slice(0, 1).toUpperCase()}
              </div>

              {/* Creator details */}
              <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/40 px-3 py-1.5 rounded-full border border-border">
                <span>Создатель:</span>
                <span
                  className="size-4 rounded-full overflow-hidden flex items-center justify-center text-[9px] text-white font-medium"
                  style={{
                    backgroundColor: inviteInfo.owner.avatar_url
                      ? undefined
                      : inviteInfo.owner.avatar_color,
                  }}
                >
                  {inviteInfo.owner.avatar_url ? (
                    <img
                      src={inviteInfo.owner.avatar_url}
                      alt={inviteInfo.owner.name}
                      className="size-full object-cover"
                    />
                  ) : (
                    inviteInfo.owner.name.slice(0, 1).toUpperCase()
                  )}
                </span>
                <span className="font-medium text-foreground">{inviteInfo.owner.name}</span>
                <span className="font-mono text-[11px]">(@{inviteInfo.owner.username})</span>
              </div>
            </div>

            {/* Members preview stack */}
            <div className="p-3 rounded-lg border border-border bg-background/50 flex items-center justify-between gap-3 text-left">
              <div className="flex items-center gap-2">
                <Users className="size-4 text-muted-foreground shrink-0" />
                <span className="text-xs font-medium">
                  {inviteInfo.members_count}{" "}
                  {inviteInfo.members_count === 1
                    ? "участник"
                    : inviteInfo.members_count >= 2 && inviteInfo.members_count <= 4
                    ? "участника"
                    : "участников"}
                </span>
              </div>

              {inviteInfo.members_preview.length > 0 && (
                <div className="flex -space-x-1.5 overflow-hidden">
                  {inviteInfo.members_preview.map((m) => (
                    <span
                      key={m.user_id}
                      title={m.display_name}
                      className="inline-block size-6 rounded-full ring-2 ring-background overflow-hidden text-[9px] font-semibold text-white text-center leading-6 shrink-0"
                      style={{
                        backgroundColor: m.avatar_url ? undefined : m.avatar_color,
                      }}
                    >
                      {m.avatar_url ? (
                        <img
                          src={m.avatar_url}
                          alt={m.display_name}
                          className="size-full object-cover"
                        />
                      ) : (
                        m.display_name.slice(0, 1).toUpperCase()
                      )}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Call To Action Buttons */}
            <div className="space-y-2 pt-1">
              {isAlreadyMember ? (
                <div className="space-y-2">
                  <Badge variant="secondary" className="gap-1 py-1 px-2 text-xs">
                    <Check className="size-3 text-emerald-500" />
                    Вы уже являетесь участником этой группы
                  </Badge>
                  <Button
                    type="button"
                    className="w-full gap-2 cursor-pointer"
                    onClick={handleAlreadyMemberGo}
                  >
                    <span>Перейти к группе</span>
                    <ArrowRight className="size-4" />
                  </Button>
                </div>
              ) : currentUser ? (
                <Button
                  type="button"
                  disabled={joining}
                  className="w-full gap-2 cursor-pointer font-medium"
                  size="lg"
                  onClick={handleJoin}
                >
                  {joining ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ArrowRight className="size-4" />
                  )}
                  <span>Вступить в группу</span>
                </Button>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Войдите или зарегистрируйтесь, чтобы принять приглашение
                  </p>
                  <Button
                    type="button"
                    className="w-full gap-2 cursor-pointer font-medium"
                    size="lg"
                    onClick={() => {
                      onOpenAuth();
                    }}
                  >
                    <LogIn className="size-4" />
                    <span>Войти для вступления</span>
                  </Button>
                </div>
              )}

              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onClose}
                className="w-full text-xs text-muted-foreground cursor-pointer"
              >
                Отклонить
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
