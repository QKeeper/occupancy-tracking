import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { User, FeedbackItem, FeedbackComment } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  MessageSquarePlus,
  MessageSquare,
  Heart,
  Send,
  Trash2,
  Tag as TagIcon,
  Search,
  X,
  Plus,
  Sparkles,
  CheckCircle2,
  RefreshCw,
  Lightbulb,
  Bug,
  Rocket,
  HelpCircle,
  Clock,
  Check,
} from "lucide-react";
import { formatDistanceToNow, parseISO } from "date-fns";
import { ru } from "date-fns/locale/ru";
import { toast } from "sonner";

interface FeedbackModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentUser: User;
}

const PRESET_TAGS = [
  { label: "Предложение", icon: Lightbulb, color: "text-amber-500" },
  { label: "Баг", icon: Bug, color: "text-rose-500" },
  { label: "Улучшение", icon: Rocket, color: "text-blue-500" },
  { label: "Вопрос", icon: HelpCircle, color: "text-purple-500" },
];

function getTagIcon(tag: string) {
  const lower = tag.toLowerCase();
  if (lower.includes("баг") || lower.includes("bug") || lower.includes("ошибк")) {
    return Bug;
  }
  if (lower.includes("предложен") || lower.includes("иде") || lower.includes("feature")) {
    return Lightbulb;
  }
  if (lower.includes("улучшен") || lower.includes("скорост") || lower.includes("enhance")) {
    return Rocket;
  }
  if (lower.includes("вопрос") || lower.includes("question") || lower.includes("помощ")) {
    return HelpCircle;
  }
  return TagIcon;
}

function getTagStyle(tag: string) {
  const lower = tag.toLowerCase();
  if (lower.includes("баг") || lower.includes("bug") || lower.includes("ошибк")) {
    return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400";
  }
  if (lower.includes("предложен") || lower.includes("иде") || lower.includes("feature")) {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400";
  }
  if (lower.includes("улучшен") || lower.includes("скорост") || lower.includes("enhance")) {
    return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400";
  }
  if (lower.includes("вопрос") || lower.includes("question") || lower.includes("помощ")) {
    return "border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-400";
  }
  return "border-border bg-muted/80 text-foreground";
}

function formatRelativeTime(dateStr: string) {
  try {
    return formatDistanceToNow(parseISO(dateStr), { addSuffix: true, locale: ru });
  } catch {
    return "недавно";
  }
}

export const FeedbackModal: React.FC<FeedbackModalProps> = ({
  open,
  onOpenChange,
  currentUser,
}) => {
  const [activeTab, setActiveTab] = useState<"list" | "create">("list");
  const [feedbackList, setFeedbackList] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Filters
  const [statusFilter, setStatusFilter] = useState<"open" | "all" | "closed" | "mine">("open");
  const [selectedTagFilter, setSelectedTagFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Create Form State
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Comments state & input refs
  const [expandedComments, setExpandedComments] = useState<Set<number>>(new Set());
  const [commentDrafts, setCommentDrafts] = useState<Record<number, string>>({});
  const [submittingComment, setSubmittingComment] = useState<Record<number, boolean>>({});
  const commentInputRefs = useRef<Record<number, HTMLInputElement | null>>({});

  // Delete Confirmation Modal State
  const [feedbackToDelete, setFeedbackToDelete] = useState<FeedbackItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const isSuperAdmin = currentUser.is_super_admin || currentUser.username.toLowerCase() === "qkeeper";
  const isAdmin = currentUser.is_admin || isSuperAdmin;

  // Fetch feedback items from backend
  const fetchFeedback = useCallback(async (isSilent = false) => {
    if (!isSilent) setLoading(true);
    else setRefreshing(true);
    try {
      const res = await fetch("/api/feedback", {
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error("Не удалось загрузить список заявок");
      const data: FeedbackItem[] = await res.json();
      setFeedbackList(data);
    } catch (err: any) {
      if (!isSilent) toast.error(err.message || "Ошибка загрузки обращений");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      fetchFeedback();
    }
  }, [open, fetchFeedback]);

  // Listen to Server-Sent Events for real-time sync
  useEffect(() => {
    if (!open) return;
    const evtSource = new EventSource("/api/events");
    evtSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "feedback_updated") {
          fetchFeedback(true);
        }
      } catch {
        // ignore
      }
    };
    return () => {
      evtSource.close();
    };
  }, [open, fetchFeedback]);

  // Available tags in existing list
  const allAvailableTags = useMemo(() => {
    const set = new Set<string>();
    feedbackList.forEach((item) => {
      item.tags.forEach((t) => set.add(t));
    });
    return Array.from(set);
  }, [feedbackList]);

  // Filtered feedback list
  const filteredItems = useMemo(() => {
    return feedbackList.filter((item) => {
      if (statusFilter === "open" && item.status !== "open") return false;
      if (statusFilter === "closed" && item.status !== "closed") return false;
      if (statusFilter === "mine" && item.user_id !== currentUser.id) return false;

      if (selectedTagFilter !== "all") {
        const matchesTag = item.tags.some(
          (t) => t.toLowerCase() === selectedTagFilter.toLowerCase()
        );
        if (!matchesTag) return false;
      }

      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchesTitle = item.title?.toLowerCase().includes(q);
        const matchesMsg = item.message?.toLowerCase().includes(q);
        const matchesAuthor =
          item.author_name.toLowerCase().includes(q) ||
          item.author_username.toLowerCase().includes(q);
        const matchesTag = item.tags.some((t) => t.toLowerCase().includes(q));
        if (!matchesTitle && !matchesMsg && !matchesAuthor && !matchesTag) return false;
      }

      return true;
    });
  }, [feedbackList, statusFilter, selectedTagFilter, searchQuery, currentUser.id]);

  // Handle Tag toggle in form
  const toggleTag = (tagName: string) => {
    setSelectedTags((prev) =>
      prev.includes(tagName) ? prev.filter((t) => t !== tagName) : [...prev, tagName]
    );
  };

  // Submit new feedback ticket (title is required, message is optional)
  const handleCreateFeedback = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || title.trim().length < 2) {
      toast.error("Заголовок должен содержать не менее 2 символов");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          message: message.trim(),
          tags: selectedTags,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Не удалось отправить обращение");
      }

      const created: FeedbackItem = await res.json();
      setFeedbackList((prev) => [created, ...prev]);
      setTitle("");
      setMessage("");
      setSelectedTags([]);
      setActiveTab("list");
      toast.success("Обращение успешно опубликовано!");
    } catch (err: any) {
      toast.error(err.message || "Ошибка отправки обращения");
    } finally {
      setSubmitting(false);
    }
  };

  // Confirm delete feedback ticket from modal
  const handleConfirmDelete = async () => {
    if (!feedbackToDelete) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/feedback/${feedbackToDelete.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Не удалось удалить заявку");
      }

      setFeedbackList((prev) => prev.filter((item) => item.id !== feedbackToDelete.id));
      toast.success("Заявка успешно удалена");
      setFeedbackToDelete(null);
    } catch (err: any) {
      toast.error(err.message || "Ошибка удаления");
    } finally {
      setDeleting(false);
    }
  };

  // Toggle status (open/closed)
  const handleToggleStatus = async (item: FeedbackItem) => {
    const nextStatus = item.status === "open" ? "closed" : "open";
    try {
      const res = await fetch(`/api/feedback/${item.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Не удалось изменить статус");
      }

      const updated = await res.json();
      setFeedbackList((prev) =>
        prev.map((f) => (f.id === item.id ? { ...f, status: updated.status } : f))
      );
      toast.success(
        nextStatus === "closed"
          ? "Заявка отмечена как решённая"
          : "Заявка снова открыта"
      );
    } catch (err: any) {
      toast.error(err.message || "Ошибка изменения статуса");
    }
  };

  // Like / Unlike feedback ticket
  const handleToggleLike = async (item: FeedbackItem) => {
    const prevLiked = item.has_liked;
    const prevCount = item.likes_count;
    const nextLiked = !prevLiked;
    const nextCount = nextLiked ? prevCount + 1 : Math.max(0, prevCount - 1);

    setFeedbackList((prev) =>
      prev.map((f) =>
        f.id === item.id ? { ...f, has_liked: nextLiked, likes_count: nextCount } : f
      )
    );

    try {
      const res = await fetch(`/api/feedback/${item.id}/like`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (!res.ok) {
        throw new Error("Не удалось поставить лайк");
      }

      const data = await res.json();
      setFeedbackList((prev) =>
        prev.map((f) =>
          f.id === item.id
            ? { ...f, has_liked: data.liked, likes_count: data.likes_count }
            : f
        )
      );
    } catch (err: any) {
      setFeedbackList((prev) =>
        prev.map((f) =>
          f.id === item.id ? { ...f, has_liked: prevLiked, likes_count: prevCount } : f
        )
      );
      toast.error(err.message || "Ошибка при попытке поставить лайк");
    }
  };

  // Toggle comments accordion
  const toggleComments = (id: number) => {
    setExpandedComments((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        // Focus the input after expanding
        setTimeout(() => {
          commentInputRefs.current[id]?.focus();
        }, 100);
      }
      return next;
    });
  };

  // Submit comment and refocus input
  const handleAddComment = async (feedbackId: number) => {
    const text = (commentDrafts[feedbackId] || "").trim();
    if (!text) return;

    setSubmittingComment((prev) => ({ ...prev, [feedbackId]: true }));
    try {
      const res = await fetch(`/api/feedback/${feedbackId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Не удалось отправить комментарий");
      }

      const newComment: FeedbackComment = await res.json();
      setFeedbackList((prev) =>
        prev.map((f) => {
          if (f.id === feedbackId) {
            const comments = f.comments || [];
            return {
              ...f,
              comments_count: (f.comments_count || 0) + 1,
              comments: [...comments, newComment],
            };
          }
          return f;
        })
      );
      setCommentDrafts((prev) => ({ ...prev, [feedbackId]: "" }));
      toast.success("Комментарий добавлен");

      // Refocus input field after sending comment
      setTimeout(() => {
        commentInputRefs.current[feedbackId]?.focus();
      }, 50);
    } catch (err: any) {
      toast.error(err.message || "Ошибка отправки комментария");
    } finally {
      setSubmittingComment((prev) => ({ ...prev, [feedbackId]: false }));
    }
  };

  // Delete comment (author or admin)
  const handleDeleteComment = async (feedbackId: number, commentId: number) => {
    try {
      const res = await fetch(`/api/feedback/comments/${commentId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Не удалось удалить комментарий");
      }

      setFeedbackList((prev) =>
        prev.map((f) => {
          if (f.id === feedbackId) {
            const comments = (f.comments || []).filter((c) => c.id !== commentId);
            return {
              ...f,
              comments_count: Math.max(0, (f.comments_count || 1) - 1),
              comments,
            };
          }
          return f;
        })
      );
      toast.success("Комментарий удалён");
    } catch (err: any) {
      toast.error(err.message || "Ошибка удаления");
    }
  };

  const openTicketsCount = useMemo(
    () => feedbackList.filter((f) => f.status === "open").length,
    [feedbackList]
  );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-3xl w-full max-h-[88vh] flex flex-col p-0 gap-0 overflow-hidden">
          {/* Header */}
          <div className="p-5 border-b border-border bg-card/60 shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="size-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <MessageSquarePlus className="size-5" />
              </div>
              <div>
                <DialogTitle className="text-base font-semibold leading-tight flex items-center gap-2">
                  Обратная связь и предложения
                  {openTicketsCount > 0 && (
                    <Badge variant="secondary" className="text-[11px] font-normal py-0 px-2 h-5">
                      {openTicketsCount} открытых
                    </Badge>
                  )}
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                  Предлагайте идеи, сообщайте об ошибках, комментируйте и поддерживайте важные заявки
                </DialogDescription>
              </div>
            </div>

            {/* Navigation Tabs */}
            <div className="flex items-center gap-1.5 mt-4">
              <button
                type="button"
                onClick={() => setActiveTab("list")}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
                  activeTab === "list"
                    ? "bg-primary text-primary-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                }`}
              >
                <MessageSquare className="size-3.5" />
                Все заявки
                <span className="ml-1 opacity-80">({feedbackList.length})</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("create")}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
                  activeTab === "create"
                    ? "bg-primary text-primary-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                }`}
              >
                <Plus className="size-3.5" />
                Создать обращение
              </button>
            </div>
          </div>

          {/* Modal Body */}
          <div className="flex-1 overflow-y-auto p-5">
            {activeTab === "list" ? (
              <div className="space-y-4">
                {/* Filter controls with refresh button placed to the right of search */}
                <div className="space-y-2.5 bg-muted/30 p-3 rounded-xl border border-border/60">
                  <div className="flex flex-col sm:flex-row gap-2 sm:items-center justify-between">
                    {/* Status Pills */}
                    <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0">
                      <button
                        type="button"
                        onClick={() => setStatusFilter("open")}
                        className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                          statusFilter === "open"
                            ? "bg-background text-foreground shadow-xs border border-border"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Открытые
                      </button>
                      <button
                        type="button"
                        onClick={() => setStatusFilter("all")}
                        className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                          statusFilter === "all"
                            ? "bg-background text-foreground shadow-xs border border-border"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Все
                      </button>
                      <button
                        type="button"
                        onClick={() => setStatusFilter("mine")}
                        className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                          statusFilter === "mine"
                            ? "bg-background text-foreground shadow-xs border border-border"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Мои заявки
                      </button>
                      <button
                        type="button"
                        onClick={() => setStatusFilter("closed")}
                        className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                          statusFilter === "closed"
                            ? "bg-background text-foreground shadow-xs border border-border"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Решённые
                      </button>
                    </div>

                    {/* Search Bar + Refresh Button */}
                    <div className="flex items-center gap-1.5 flex-1 sm:max-w-xs">
                      <div className="relative flex-1">
                        <Search className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="Поиск по заявкам..."
                          className="h-8 pl-8 pr-7 text-xs bg-background"
                        />
                        {searchQuery && (
                          <button
                            type="button"
                            onClick={() => setSearchQuery("")}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          >
                            <X className="size-3" />
                          </button>
                        )}
                      </div>

                      <Button
                        variant="outline"
                        size="icon-sm"
                        onClick={() => fetchFeedback(true)}
                        disabled={refreshing}
                        title="Обновить список"
                        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                      >
                        <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
                      </Button>
                    </div>
                  </div>

                  {/* Tag Filter Pills */}
                  {allAvailableTags.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap pt-1 border-t border-border/40">
                      <span className="text-[11px] text-muted-foreground flex items-center gap-1 mr-1">
                        <TagIcon className="size-3" /> Теги:
                      </span>
                      <button
                        type="button"
                        onClick={() => setSelectedTagFilter("all")}
                        className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium transition-colors ${
                          selectedTagFilter === "all"
                            ? "bg-foreground text-background"
                            : "bg-muted text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Все
                      </button>
                      {allAvailableTags.map((t) => {
                        const isSel = selectedTagFilter.toLowerCase() === t.toLowerCase();
                        const Icon = getTagIcon(t);
                        return (
                          <button
                            key={t}
                            type="button"
                            onClick={() => setSelectedTagFilter(isSel ? "all" : t)}
                            className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${
                              isSel
                                ? "border-primary bg-primary text-primary-foreground shadow-xs"
                                : getTagStyle(t)
                            }`}
                          >
                            <Icon className="size-3" />
                            {t}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Items List */}
                {loading ? (
                  <div className="py-12 flex flex-col items-center justify-center text-center space-y-2 text-muted-foreground">
                    <RefreshCw className="size-6 animate-spin text-primary" />
                    <p className="text-xs">Загрузка обращений...</p>
                  </div>
                ) : filteredItems.length === 0 ? (
                  <div className="py-12 px-4 rounded-xl border border-dashed border-border flex flex-col items-center justify-center text-center space-y-3">
                    <div className="size-12 rounded-2xl bg-muted/60 flex items-center justify-center text-muted-foreground">
                      <Sparkles className="size-6" />
                    </div>
                    <div className="space-y-1 max-w-sm">
                      <h3 className="text-sm font-semibold">Заявок не найдено</h3>
                      <p className="text-xs text-muted-foreground">
                        {searchQuery || selectedTagFilter !== "all" || statusFilter !== "open"
                          ? "Попробуйте сбросить фильтры поиска или тегов."
                          : "Пока нет открытых заявок. Будьте первым, кто предложит идею или сообщит о баге!"}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => setActiveTab("create")}
                      className="h-8 text-xs mt-1"
                    >
                      <Plus className="size-3.5 mr-1" />
                      Создать обращение
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredItems.map((item) => {
                      const isOwner = item.user_id === currentUser.id;
                      const canDelete = isOwner || isAdmin;
                      const canChangeStatus = isOwner || isAdmin;
                      const isCommentsOpen = expandedComments.has(item.id);
                      const comments = item.comments || [];

                      return (
                        <div
                          key={item.id}
                          className={`rounded-xl border transition-shadow p-4 bg-card ${
                            item.status === "closed"
                              ? "opacity-75 border-border/50 bg-muted/20"
                              : "border-border shadow-2xs hover:shadow-xs"
                          }`}
                        >
                          {/* Card Header: Author info, status badge & actions */}
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <span
                                className="size-7 rounded-full overflow-hidden flex items-center justify-center text-white font-semibold text-[11px] shrink-0"
                                style={{
                                  backgroundColor: item.author_avatar_url
                                    ? undefined
                                    : item.author_avatar_color || "#3B82F6",
                                }}
                              >
                                {item.author_avatar_url ? (
                                  <img
                                    src={item.author_avatar_url}
                                    alt={item.author_name}
                                    className="size-full object-cover"
                                  />
                                ) : (
                                  (item.author_name || item.author_username).slice(0, 1).toUpperCase()
                                )}
                              </span>

                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="text-xs font-semibold truncate leading-tight">
                                    {item.author_name}
                                  </span>
                                  <span className="text-[11px] font-mono text-muted-foreground truncate leading-tight">
                                    @{item.author_username}
                                  </span>
                                  {item.user_id === currentUser.id && (
                                    <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.2 rounded font-medium">
                                      вы
                                    </span>
                                  )}
                                </div>
                                <div className="flex items-center gap-1 text-[11px] text-muted-foreground mt-0.5">
                                  <Clock className="size-3" />
                                  <span>{formatRelativeTime(item.created_at)}</span>
                                </div>
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0">
                              {item.status === "closed" ? (
                                <Badge
                                  variant="outline"
                                  className="border-muted-foreground/30 text-muted-foreground bg-muted/40 text-[10px] h-5"
                                >
                                  <CheckCircle2 className="size-3 mr-1 text-emerald-500" />
                                  Решено
                                </Badge>
                              ) : (
                                <Badge
                                  variant="outline"
                                  className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 text-[10px] h-5"
                                >
                                  Открыта
                                </Badge>
                              )}

                              {canChangeStatus && (
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  onClick={() => handleToggleStatus(item)}
                                  title={
                                    item.status === "open"
                                      ? "Отметить заявку как решённую"
                                      : "Открыть заявку заново"
                                  }
                                  className="text-muted-foreground hover:text-foreground"
                                >
                                  <Check className="size-3.5" />
                                </Button>
                              )}

                              {canDelete && (
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  onClick={() => setFeedbackToDelete(item)}
                                  title="Удалить заявку"
                                  className="text-muted-foreground hover:text-destructive"
                                >
                                  <Trash2 className="size-3.5" />
                                </Button>
                              )}
                            </div>
                          </div>

                          {/* Card Content: Title (required) & Message (optional) */}
                          <div className="mt-2.5 space-y-1">
                            <h4 className="text-sm font-semibold tracking-tight text-foreground leading-snug">
                              {item.title}
                            </h4>
                            {item.message && item.message.trim() && (
                              <p className="text-xs text-foreground/90 whitespace-pre-wrap leading-relaxed break-words pt-0.5">
                                {item.message}
                              </p>
                            )}
                          </div>

                          {/* Tags with matching icons and no # prefix */}
                          {item.tags && item.tags.length > 0 && (
                            <div className="flex items-center gap-1.5 flex-wrap mt-3">
                              {item.tags.map((t, idx) => {
                                const Icon = getTagIcon(t);
                                return (
                                  <span
                                    key={idx}
                                    className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-0.5 rounded-full border ${getTagStyle(
                                      t
                                    )}`}
                                  >
                                    <Icon className="size-3" />
                                    {t}
                                  </span>
                                );
                              })}
                            </div>
                          )}

                          {/* Card Footer: Likes & Comments Bar */}
                          <div className="flex items-center justify-between gap-3 pt-3 mt-3 border-t border-border/60">
                            <div className="flex items-center gap-2">
                              {/* Like Button */}
                              <button
                                type="button"
                                onClick={() => handleToggleLike(item)}
                                aria-label="Лайкнуть обращение"
                                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                                  item.has_liked
                                    ? "bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20"
                                    : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                                }`}
                              >
                                <Heart
                                  className={`size-3.5 ${
                                    item.has_liked ? "fill-rose-500 text-rose-500" : ""
                                  }`}
                                />
                                <span>{item.likes_count || 0}</span>
                              </button>

                              {/* Comments Toggle Button */}
                              <button
                                type="button"
                                onClick={() => toggleComments(item.id)}
                                aria-label="Комментарии к обращению"
                                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                                  isCommentsOpen
                                    ? "bg-muted text-foreground"
                                    : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                                }`}
                              >
                                <MessageSquare className="size-3.5" />
                                <span>Комментарии ({comments.length || item.comments_count || 0})</span>
                              </button>
                            </div>
                          </div>

                          {/* Expanded Comments Section */}
                          {isCommentsOpen && (
                            <div className="mt-3 pt-3 border-t border-border/60 space-y-3 bg-muted/20 -mx-4 -mb-4 p-4 rounded-b-xl">
                              {/* Comments List */}
                              {comments.length > 0 ? (
                                <div className="space-y-2.5">
                                  {comments.map((comment) => {
                                    const canDeleteComment =
                                      comment.user_id === currentUser.id || isAdmin;

                                    return (
                                      <div
                                        key={comment.id}
                                        className="flex items-start gap-2.5 bg-background p-2.5 rounded-lg border border-border/70"
                                      >
                                        <span
                                          className="size-6 rounded-full overflow-hidden flex items-center justify-center text-white font-semibold text-[10px] shrink-0 mt-0.5"
                                          style={{
                                            backgroundColor: comment.author_avatar_url
                                              ? undefined
                                              : comment.author_avatar_color || "#3B82F6",
                                          }}
                                        >
                                          {comment.author_avatar_url ? (
                                            <img
                                              src={comment.author_avatar_url}
                                              alt={comment.author_name}
                                              className="size-full object-cover"
                                            />
                                          ) : (
                                            (comment.author_name || comment.author_username)
                                              .slice(0, 1)
                                              .toUpperCase()
                                          )}
                                        </span>

                                        <div className="flex-1 min-w-0">
                                          <div className="flex items-center justify-between gap-2">
                                            <div className="flex items-center gap-1.5 flex-wrap">
                                              <span className="text-xs font-medium leading-tight">
                                                {comment.author_name}
                                              </span>
                                              <span className="text-[10px] font-mono text-muted-foreground">
                                                @{comment.author_username}
                                              </span>
                                              <span className="text-[10px] text-muted-foreground">
                                                • {formatRelativeTime(comment.created_at)}
                                              </span>
                                            </div>

                                            {canDeleteComment && (
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  handleDeleteComment(item.id, comment.id)
                                                }
                                                title="Удалить комментарий"
                                                className="text-muted-foreground hover:text-destructive shrink-0"
                                              >
                                                <Trash2 className="size-3" />
                                              </button>
                                            )}
                                          </div>

                                          <p className="text-xs text-foreground mt-1 whitespace-pre-wrap break-words leading-relaxed">
                                            {comment.message}
                                          </p>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : (
                                <p className="text-xs text-muted-foreground text-center py-2">
                                  Пока нет комментариев. Оставьте первый комментарий!
                                </p>
                              )}

                              {/* New Comment Input with Refocus */}
                              <div className="flex items-center gap-2 pt-1">
                                <Input
                                  ref={(el) => {
                                    commentInputRefs.current[item.id] = el;
                                  }}
                                  value={commentDrafts[item.id] || ""}
                                  onChange={(e) =>
                                    setCommentDrafts((prev) => ({
                                      ...prev,
                                      [item.id]: e.target.value,
                                    }))
                                  }
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && !e.shiftKey) {
                                      e.preventDefault();
                                      handleAddComment(item.id);
                                    }
                                  }}
                                  placeholder="Написать комментарий (Enter для отправки)..."
                                  className="h-8 text-xs bg-background"
                                  disabled={submittingComment[item.id]}
                                />
                                <Button
                                  size="sm"
                                  onClick={() => handleAddComment(item.id)}
                                  disabled={
                                    submittingComment[item.id] ||
                                    !(commentDrafts[item.id] || "").trim()
                                  }
                                  className="h-8 px-3 text-xs shrink-0"
                                >
                                  {submittingComment[item.id] ? (
                                    <RefreshCw className="size-3.5 animate-spin" />
                                  ) : (
                                    <>
                                      <Send className="size-3.5 mr-1" />
                                      Отправить
                                    </>
                                  )}
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              /* Create New Ticket Form */
              <form onSubmit={handleCreateFeedback} className="space-y-4 max-w-xl mx-auto py-2">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-foreground">
                    Заголовок заявки <span className="text-rose-500">*</span>
                  </label>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Кратко опишите суть обращения (например: Тёмная тема в мобильном виде)"
                    maxLength={150}
                    required
                    className="text-xs"
                    autoFocus
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Обязательное поле.
                  </p>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-foreground">
                    Описание <span className="text-muted-foreground font-normal">(необязательно)</span>
                  </label>
                  <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Подробности, шаги воспроизведения или идеи по реализации..."
                    rows={4}
                    className="w-full text-xs rounded-lg border border-input bg-transparent px-3 py-2 shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-y min-h-[90px]"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Поддерживается форматирование переносами строк.
                  </p>
                </div>

                {/* Preset Tags Selector (no checkmarks, no duplication below, no custom tag input) */}
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-foreground">
                    Теги к обращению
                  </label>

                  <div className="flex items-center gap-2 flex-wrap">
                    {PRESET_TAGS.map((preset) => {
                      const isSelected = selectedTags.includes(preset.label);
                      const Icon = preset.icon;
                      return (
                        <button
                          key={preset.label}
                          type="button"
                          onClick={() => toggleTag(preset.label)}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                            isSelected
                              ? "bg-primary text-primary-foreground border-primary shadow-xs ring-1 ring-primary"
                              : "bg-muted/50 border-border text-foreground hover:bg-muted"
                          }`}
                        >
                          <Icon className={`size-3.5 ${isSelected ? "text-primary-foreground" : preset.color}`} />
                          <span>{preset.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="pt-3 border-t border-border flex items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setActiveTab("list")}
                    className="h-8 text-xs"
                  >
                    Отмена
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={submitting || !title.trim()}
                    className="h-8 text-xs"
                  >
                    {submitting ? (
                      <>
                        <RefreshCw className="size-3.5 animate-spin mr-1" />
                        Публикация...
                      </>
                    ) : (
                      <>
                        <Send className="size-3.5 mr-1" />
                        Опубликовать обращение
                      </>
                    )}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Modal */}
      <Dialog
        open={Boolean(feedbackToDelete)}
        onOpenChange={(isOpen) => {
          if (!isOpen && !deleting) setFeedbackToDelete(null);
        }}
      >
        <DialogContent className="sm:max-w-md w-full">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold text-destructive flex items-center gap-2">
              <Trash2 className="size-4" />
              Удалить заявку?
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
              Вы уверены, что хотите удалить заявку{" "}
              <strong className="text-foreground">«{feedbackToDelete?.title}»</strong>? Все
              комментарии и лайки к этой заявке также будут безвозвратно удалены.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-border mt-3">
            <Button
              variant="outline"
              size="sm"
              disabled={deleting}
              onClick={() => setFeedbackToDelete(null)}
              className="h-8 text-xs"
            >
              Отмена
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleting}
              onClick={handleConfirmDelete}
              className="h-8 text-xs"
            >
              {deleting ? (
                <>
                  <RefreshCw className="size-3.5 animate-spin mr-1" />
                  Удаление...
                </>
              ) : (
                <>
                  <Trash2 className="size-3.5 mr-1" />
                  Удалить
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};
