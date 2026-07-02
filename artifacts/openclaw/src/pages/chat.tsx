import { useEffect, useRef, useState } from "react";
import {
  useListChannels,
  useCreateChannel,
  useListMessages,
  useSendMessage,
  useListAgents,
  useGetSwarmStatus,
  getListChannelsQueryKey,
  getListMessagesQueryKey,
  getListAgentsQueryKey,
  getGetSwarmStatusQueryKey,
  resolveApiUrl,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { stopSwarm } from "@/components/dashboard/SwarmStatusStrip";
import { useAiStream } from "@/hooks/useAiStream";
import { GOAL_DRAFT_KEY } from "@/lib/handoff";
import { MessageContent } from "@/components/chat/MessageContent";
import { SwarmThinking } from "@/components/dashboard/SwarmThinking";
import { speak, cancelSpeech, speechSupported } from "@/lib/speech";
import { WhatsNewButton } from "@/components/WhatsNew";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Plus, Send, Paperclip, X, Menu, Download, Trash2, Pencil, Check,
  MessageSquare, Bot, AlertTriangle, Loader2, Sparkles, Copy, Volume2, Square, Mic, Headphones, OctagonX,
} from "lucide-react";

// Uploaded to /api/uploads on pick; images are rendered inline and sent to ABBY
// as vision input, text files have their text read by the agent.
interface Attachment { id: number; name: string; size: number; kind: string; mime: string; url: string; }

// Minimal typing for the browser Web Speech API (not in lib.dom for all targets).
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: (e: SpeechRecognitionEventLike) => void;
  onerror: () => void;
  onend: () => void;
  start: () => void;
  stop: () => void;
}

// Read a File as a base64 data URL for upload.
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export default function ChatPage() {
  const qc = useQueryClient();
  const { data: channels = [], isLoading: channelsLoading } = useListChannels({
    query: { refetchInterval: 8000, queryKey: getListChannelsQueryKey() },
  });

  const [activeId, setActiveId] = useState<number | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  // Direct-to-agent: pick a specific specialist to address (null = Abby auto-route).
  const [targetAgentId, setTargetAgentId] = useState<number | null>(null);
  const { data: chatAgents = [] } = useListAgents({
    query: { refetchInterval: 15000, queryKey: getListAgentsQueryKey() },
  });
  const { data: swarmStatus } = useGetSwarmStatus({ query: { refetchInterval: 3000, queryKey: getGetSwarmStatusQueryKey() } });
  const swarmWorking = !swarmStatus?.paused && ((swarmStatus?.activeAgents ?? 0) > 0 || (swarmStatus?.runningTasks ?? 0) > 0);

  // Default to a FRESH new chat on every open (don't auto-resume the last
  // conversation). The channel is created lazily on the first message, so the
  // sidebar never fills with empty "New chat" shells. Past chats stay one tap
  // away in the sidebar.

  // Goal handed off from the Swarm page: prefill the composer so the user lands
  // in Chat (the command surface) ready to dispatch. We never auto-send.
  const [pendingDraft, setPendingDraft] = useState(false);

  const activeChannel = channels.find((c) => c.id === activeId) ?? null;

  const { data: messages = [], isLoading: msgsLoading, isError: msgsError, refetch: refetchMsgs } =
    useListMessages(activeId ?? 0, {
      query: { enabled: activeId != null, refetchInterval: 4000, queryKey: getListMessagesQueryKey(activeId ?? 0) },
    });

  const ai = useAiStream(() => {
    if (activeId) setTimeout(() => qc.invalidateQueries({ queryKey: getListMessagesQueryKey(activeId) }), 400);
  });

  const sendMessage = useSendMessage();
  const createChannel = useCreateChannel({
    mutation: {
      onSuccess: (ch) => {
        qc.invalidateQueries({ queryKey: getListChannelsQueryKey() });
        setActiveId(ch.id);
        setSidebarOpen(false);
      },
      onError: () => toast.error("Couldn't start a new chat."),
    },
  });

  // ── Composer ──────────────────────────────────────────────────────────────
  const [text, setText] = useState("");
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [uploading, setUploading] = useState(false);
  const [listening, setListening] = useState(false);
  // Hands-free "Talk to Abby" mode: she speaks her replies and re-opens the mic
  // for your next turn. Persisted so it survives reloads.
  const [voiceMode, setVoiceMode] = useState<boolean>(() => {
    try { return localStorage.getItem("abby.voiceMode") === "1"; } catch { return false; }
  });
  const voiceModeRef = useRef(voiceMode);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<unknown>(null);

  useEffect(() => {
    voiceModeRef.current = voiceMode;
    try { localStorage.setItem("abby.voiceMode", voiceMode ? "1" : "0"); } catch { /* ignore */ }
    if (!voiceMode) { cancelSpeech(); stopListening(); }
  }, [voiceMode]);

  // Voice input (speech-to-text) via the browser Web Speech API. Dictated text is
  // appended to the composer; no audio leaves the browser for this path. In voice
  // mode, the final transcript is auto-sent so you don't have to tap Send.
  function startListening() {
    const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
    const Rec = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Rec) {
      toast.error("Voice input isn't supported in this browser. Try Chrome.");
      return;
    }
    if (listening) return;
    cancelSpeech(); // don't let Abby's voice bleed into the mic
    const rec = new Rec();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = "";
    rec.onresult = (e: SpeechRecognitionEventLike) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
      }
      setText((prev) => {
        const base = prev.replace(/\s*\[…\]$/, "");
        return (finalText ? `${base}${base && !base.endsWith(" ") ? " " : ""}${finalText}` : `${base} […]`).trimStart();
      });
    };
    rec.onerror = () => { setListening(false); };
    rec.onend = () => {
      setListening(false);
      setText((prev) => prev.replace(/\s*\[…\]$/, ""));
      const said = finalText.trim();
      if (voiceModeRef.current && said) {
        // Hands-free: auto-send what you just said.
        setTimeout(() => send(said), 120);
      } else {
        requestAnimationFrame(() => taRef.current?.focus());
      }
    };
    recognitionRef.current = rec;
    try { rec.start(); setListening(true); } catch { /* already started */ }
  }

  function stopListening() {
    (recognitionRef.current as SpeechRecognitionLike | null)?.stop();
  }

  const toggleVoice = () => {
    if (listening) stopListening();
    else startListening();
  };

  // Turn the whole hands-free conversation on/off.
  const toggleVoiceMode = () => {
    if (!speechSupported()) {
      toast.error("Voice replies aren't supported in this browser. Try Chrome.");
      return;
    }
    setVoiceMode((on) => {
      const next = !on;
      if (next) {
        toast.success("Voice chat on — talk to Abby, she'll talk back.");
        // Start listening right away so it feels like a call.
        setTimeout(() => { if (!ai.streaming) startListening(); }, 150);
      } else {
        cancelSpeech();
        stopListening();
      }
      return next;
    });
  };

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  };
  useEffect(autoGrow, [text]);

  // Abby talks back: when a streamed reply finishes AND it's Abby (the
  // orchestrator) — not some other agent's wall of output — speak it aloud, then
  // re-open the mic so the conversation continues hands-free. Only runs in voice
  // mode. We watch streaming go true→false with content present.
  const prevStreaming = useRef(false);
  useEffect(() => {
    const was = prevStreaming.current;
    prevStreaming.current = ai.streaming;
    if (!was || ai.streaming) return;            // only fire on the true→false edge
    if (!voiceModeRef.current) return;
    const reply = ai.tokens.trim();
    if (!reply) return;
    const who = ai.agentName;
    const isAbby = !who || /abby/i.test(who);     // just Abby — keep it her voice only
    if (!isAbby) return;
    speak(reply, {
      onEnd: () => {
        if (voiceModeRef.current && !prevStreaming.current) startListening();
      },
    });
  }, [ai.streaming, ai.tokens, ai.agentName]);

  // Pick up a goal handed off from the Swarm page (set the composer text once,
  // then clear the handoff). If there's no conversation yet, start one so the
  // prefilled goal is immediately sendable.
  useEffect(() => {
    let draft: string | null = null;
    try { draft = sessionStorage.getItem(GOAL_DRAFT_KEY); } catch { /* ignore */ }
    if (draft) {
      setText(draft);
      setPendingDraft(true);
      try { sessionStorage.removeItem(GOAL_DRAFT_KEY); } catch { /* ignore */ }
      requestAnimationFrame(() => taRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    if (pendingDraft && activeId == null && !channelsLoading && channels.length === 0) {
      newChat();
      setPendingDraft(false);
    }
  }, [pendingDraft, activeId, channelsLoading, channels.length]);

  // Auto-scroll to newest content (and while streaming).
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, ai.tokens, ai.streaming]);

  // Post the user message into a known channel, then kick off the AI stream.
  function doSend(channelId: number, body: string, composed: string, att: Attachment | null) {
    sendMessage.mutate(
      { data: { content: composed, messageType: "user" }, channelId },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListMessagesQueryKey(channelId) });
          // The model gets the original text plus the attachment id (vision/text).
          ai.send({
            message: body || "(see attached file)",
            agentId: targetAgentId, // null = Abby auto-route; else straight to that agent
            channelId,
            attachmentIds: att ? [att.id] : undefined,
          });
        },
        onError: () => toast.error("Couldn't send your message. Try again."),
      },
    );
  }

  function send(override?: string) {
    const body = (override ?? text).trim();
    if ((!body && !attachment) || ai.streaming) return;
    const att = attachment;
    // What gets persisted/shown in the feed: images render inline via markdown,
    // other files show as a labelled link.
    let composed = body;
    if (att) {
      const tag =
        att.kind === "image"
          ? `![${att.name}](${resolveApiUrl(att.url)})`
          : `📎 [${att.name}](${resolveApiUrl(att.url)})`;
      composed = `${body}${body ? "\n\n" : ""}${tag}`;
    }
    setText("");
    setAttachment(null);
    requestAnimationFrame(autoGrow);
    if (activeId == null) {
      // Fresh new chat: create the channel now, then send into it.
      createChannel.mutate(
        { data: { name: "New chat", type: "general" } },
        { onSuccess: (ch) => doSend(ch.id, body, composed, att) },
      );
      return;
    }
    doSend(activeId, body, composed, att);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) {
      toast.error("File too large (max 20 MB).");
      return;
    }
    setUploading(true);
    try {
      const dataUrl = await fileToDataUrl(f);
      const res = await fetch(resolveApiUrl("/api/uploads"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: f.name, mime: f.type || "application/octet-stream", dataBase64: dataUrl }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${res.status}`);
      }
      const a = (await res.json()) as Attachment;
      setAttachment(a);
    } catch (err) {
      toast.error(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
    }
  };

  // ── Conversation actions ────────────────────────────────────────────────
  const newChat = () =>
    createChannel.mutate({ data: { name: `New chat`, type: "general" } });

  const renameChannel = async (id: number, name: string) => {
    if (!name.trim()) return;
    try {
      const r = await fetch(resolveApiUrl(`/api/channels/${id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!r.ok) throw new Error();
      qc.invalidateQueries({ queryKey: getListChannelsQueryKey() });
    } catch {
      toast.error("Rename failed.");
    } finally {
      setEditingId(null);
    }
  };

  const deleteChannel = async (id: number) => {
    try {
      const r = await fetch(resolveApiUrl(`/api/channels/${id}`), { method: "DELETE" });
      if (!r.ok) throw new Error();
      const remaining = channels.filter((c) => c.id !== id);
      if (activeId === id) setActiveId(remaining[0]?.id ?? null);
      qc.invalidateQueries({ queryKey: getListChannelsQueryKey() });
      toast.success("Conversation deleted.");
    } catch {
      toast.error("Delete failed.");
    }
  };

  const exportConvo = (fmt: "txt" | "json") => {
    setExportOpen(false);
    if (!messages.length) { toast("Nothing to export yet."); return; }
    const rows = messages.map((m) => ({
      role: m.messageType === "user" ? "user" : (m.agentName || "assistant"),
      content: m.content,
      at: m.timestamp,
    }));
    const blob =
      fmt === "json"
        ? new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" })
        : new Blob([rows.map((r) => `### ${r.role} · ${new Date(r.at).toLocaleString()}\n${r.content}\n`).join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(activeChannel?.name || "conversation").replace(/\s+/g, "-").toLowerCase()}.${fmt}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const visibleMessages = messages.filter((m) => (m.content ?? "").trim().length > 0);

  return (
    <div className="flex w-full h-full text-foreground overflow-hidden">
      {/* ── Conversation sidebar (drawer on mobile) ── */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 bg-black/50 z-30" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
      )}
      <aside
        className={cn(
          "w-72 shrink-0 bg-card/60 border-r border-card-border flex flex-col z-40",
          "md:static md:translate-x-0 transition-transform duration-200",
          "fixed inset-y-0 left-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        )}
        aria-label="Conversations"
      >
        <div className="p-3">
          <button
            onClick={newChat}
            disabled={createChannel.isPending}
            className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-primary/15 border border-primary/30 text-primary text-sm font-semibold hover:bg-primary/25 transition-colors"
          >
            <Plus className="w-4 h-4" /> New chat
          </button>
        </div>
        <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">Conversations</div>
        <nav className="flex-1 overflow-y-auto px-2 pb-3 space-y-0.5">
          {channelsLoading ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">Loading…</div>
          ) : channels.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">No conversations yet.</div>
          ) : (
            channels.map((c) => {
              const active = c.id === activeId;
              return (
                <div
                  key={c.id}
                  className={cn(
                    "group flex items-center gap-2 rounded-lg px-2.5 py-2 cursor-pointer transition-colors",
                    active ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-card-border/50 hover:text-foreground",
                  )}
                  onClick={() => { setActiveId(c.id); setSidebarOpen(false); }}
                >
                  <MessageSquare className={cn("w-4 h-4 shrink-0", active ? "text-primary" : "")} />
                  {editingId === c.id ? (
                    <input
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => { if (e.key === "Enter") renameChannel(c.id, editName); if (e.key === "Escape") setEditingId(null); }}
                      onBlur={() => renameChannel(c.id, editName)}
                      className="flex-1 min-w-0 bg-background border border-card-border rounded px-1.5 py-0.5 text-sm focus:outline-none focus:border-primary/50"
                      aria-label="Conversation name"
                    />
                  ) : (
                    <span className="flex-1 min-w-0 truncate text-sm">{c.name}</span>
                  )}
                  <div className={cn("flex items-center gap-0.5 shrink-0", active ? "opacity-100" : "opacity-0 group-hover:opacity-100")}>
                    {editingId === c.id ? (
                      <button onClick={(e) => { e.stopPropagation(); renameChannel(c.id, editName); }} aria-label="Save name" className="p-1 hover:text-primary">
                        <Check className="w-3.5 h-3.5" />
                      </button>
                    ) : (
                      <button onClick={(e) => { e.stopPropagation(); setEditingId(c.id); setEditName(c.name); }} aria-label="Rename conversation" className="p-1 hover:text-foreground">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); deleteChannel(c.id); }} aria-label="Delete conversation" className="p-1 hover:text-destructive">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </nav>
      </aside>

      {/* ── Main column ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="h-14 shrink-0 border-b border-card-border flex items-center gap-3 px-4">
          <button onClick={() => setSidebarOpen(true)} aria-label="Open conversations" className="md:hidden p-2 -ml-2 text-muted-foreground hover:text-foreground">
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <Bot className="w-5 h-5 text-primary shrink-0" />
            <h1 className="text-sm font-semibold truncate">{activeChannel?.name ?? "New chat"}</h1>
          </div>
          <WorkingIndicator />
          <WhatsNewButton />
          <div className="relative">
            <button
              onClick={() => setExportOpen((v) => !v)}
              aria-label="Export conversation"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-card-border/50 transition-colors"
            >
              <Download className="w-4 h-4" /> <span className="hidden sm:inline">Export</span>
            </button>
            {exportOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setExportOpen(false)} />
                <div className="absolute right-0 mt-1 w-40 rounded-lg border border-card-border bg-popover shadow-xl z-20 overflow-hidden">
                  <button onClick={() => exportConvo("txt")} className="w-full text-left px-3 py-2 text-sm hover:bg-card-border/50">Download .txt</button>
                  <button onClick={() => exportConvo("json")} className="w-full text-left px-3 py-2 text-sm hover:bg-card-border/50">Download .json</button>
                </div>
              </>
            )}
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
            {activeId == null && !channelsLoading ? (
              <EmptyConversation onPrompt={(p) => { setText(p); requestAnimationFrame(() => taRef.current?.focus()); }} />
            ) : msgsLoading ? (
              <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
                <Loader2 className="w-5 h-5 animate-spin" /> Loading conversation…
              </div>
            ) : msgsError ? (
              <div className="flex flex-col items-center py-20 gap-3 text-center">
                <AlertTriangle className="w-7 h-7 text-destructive" />
                <span className="text-sm text-muted-foreground">Couldn't load this conversation.</span>
                <button onClick={() => refetchMsgs()} className="px-4 py-1.5 rounded-lg border border-card-border text-sm hover:border-primary/40">Retry</button>
              </div>
            ) : visibleMessages.length === 0 && !ai.streaming ? (
              <EmptyConversation onPrompt={(p) => { setText(p); taRef.current?.focus(); }} />
            ) : (
              visibleMessages.map((m) => <MessageRow key={m.id} message={m} />)
            )}

            {/* Live streaming reply */}
            {ai.streaming && (
              <div className="flex gap-3">
                <Avatar name={ai.agentName ?? "ABBY"} color="#22d3ee" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-muted-foreground mb-1">{ai.agentName ?? "ABBY"}</div>
                  {ai.tokens ? (
                    <MessageContent content={ai.tokens} />
                  ) : (
                    <TypingDots />
                  )}
                </div>
              </div>
            )}
            {ai.error && (
              <div className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2">
                {ai.error.includes("402") || /credit/i.test(ai.error)
                  ? "The model provider is out of credits. Add credits or configure a fallback model."
                  : `Something went wrong: ${ai.error.slice(0, 160)}`}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* Composer — Gemini-style floating rounded pill */}
        <div className="shrink-0 bg-transparent">
          <div className="max-w-3xl mx-auto px-4 pt-2 pb-4">
            {/* Live "what the swarm is doing" cue — 3D red orb + red↔blue shimmer,
                shown while ABBY streams or any agent is working. */}
            <div className="mb-2 min-h-[20px] px-1 flex items-center justify-between gap-2">
              <SwarmThinking size="sm" force={ai.streaming} label={ai.streaming ? "ABBY is orchestrating the swarm" : undefined} />
              {(ai.streaming || swarmWorking) && (
                <button
                  onClick={async () => { await stopSwarm(); ai.cancel(); }}
                  aria-label="Stop everything now"
                  title="Hard stop — abort every running agent immediately"
                  className="shrink-0 inline-flex items-center gap-1 rounded-md border border-destructive/50 bg-destructive/15 text-destructive text-xs font-semibold px-2 py-1 hover:bg-destructive/25 transition-colors"
                >
                  <OctagonX className="w-3.5 h-3.5" /> Stop
                </button>
              )}
            </div>
            {/* Direct-to-agent selector: talk to Abby (auto-route) or send straight
                to a specific specialist (bypasses Abby's routing). */}
            <div className="mb-2 flex items-center gap-2 px-1">
              <span className="text-[11px] text-muted-foreground shrink-0">To:</span>
              <select
                value={targetAgentId ?? ""}
                onChange={(e) => setTargetAgentId(e.target.value ? Number(e.target.value) : null)}
                title="Send to a specific agent (bypasses Abby's routing), or let Abby auto-route"
                className="text-xs rounded-md border border-card-border bg-card/70 text-foreground px-2 py-1 focus:outline-none focus:border-primary/60 max-w-[60%]"
              >
                <option value="">🧠 Abby — auto-route</option>
                {chatAgents.filter((a) => a.id !== 1).map((a) => (
                  <option key={a.id} value={a.id}>{a.name} · {a.role}</option>
                ))}
              </select>
              {targetAgentId != null && (
                <span className="text-[10px] text-primary/80 truncate">→ straight to {chatAgents.find((a) => a.id === targetAgentId)?.name}, skipping Abby</span>
              )}
            </div>
            {uploading && (
              <div className="mb-2 inline-flex items-center gap-2 rounded-lg border border-card-border bg-card px-2.5 py-1.5 text-sm text-muted-foreground">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Uploading…
              </div>
            )}
            {attachment && (
              <div className="mb-2 inline-flex items-center gap-2 rounded-lg border border-card-border bg-card px-2.5 py-1.5 text-sm">
                {attachment.kind === "image" ? (
                  <img src={resolveApiUrl(attachment.url)} alt={attachment.name} className="w-8 h-8 rounded object-cover border border-card-border" />
                ) : (
                  <Paperclip className="w-3.5 h-3.5 text-muted-foreground" />
                )}
                <span className="truncate max-w-[200px]">{attachment.name}</span>
                <button onClick={() => setAttachment(null)} aria-label="Remove attachment" className="text-muted-foreground hover:text-destructive">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            <div className="flex items-end gap-1 rounded-[28px] border border-card-border bg-card/80 backdrop-blur pl-2 pr-2 py-1.5 shadow-[0_2px_16px_rgba(0,0,0,0.45)] focus-within:border-primary/60 focus-within:shadow-[0_6px_24px_rgba(26,115,232,0.22)] transition-all">
              <input ref={fileRef} type="file" className="hidden" onChange={onPickFile} aria-hidden="true" />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                aria-label="Attach a file"
                className="p-2.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40 transition-colors"
              >
                {uploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Plus className="w-5 h-5" />}
              </button>
              <textarea
                ref={taRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKey}
                rows={1}
                aria-label="Message"
                placeholder={ai.streaming ? "Waiting for the response…" : targetAgentId != null ? `Ask ${chatAgents.find((a) => a.id === targetAgentId)?.name ?? "the agent"} directly…` : "Ask Abby AI…"}
                className="flex-1 min-w-0 resize-none bg-transparent py-2 px-1 text-[13px] leading-relaxed focus:outline-none placeholder:text-muted-foreground/55 max-h-[200px]"
              />
              <button
                onClick={toggleVoiceMode}
                aria-label={voiceMode ? "Turn off voice chat with Abby" : "Talk to Abby (voice chat)"}
                title={voiceMode ? "Voice chat on — Abby talks back. Click to turn off." : "Talk to Abby — she'll speak her replies"}
                className={cn(
                  "p-2.5 rounded-full transition-colors",
                  voiceMode ? "text-primary bg-primary/15" : "text-muted-foreground hover:text-foreground hover:bg-muted",
                )}
              >
                <Headphones className={cn("w-5 h-5", voiceMode && "animate-pulse")} />
              </button>
              <button
                onClick={toggleVoice}
                aria-label={listening ? "Stop voice input" : "Speak your message"}
                title={listening ? "Listening… click to stop" : "Speak your message"}
                className={cn(
                  "p-2.5 rounded-full transition-colors disabled:opacity-40",
                  listening ? "text-[#ff2d78] bg-[#ff2d78]/10" : "text-muted-foreground hover:text-foreground hover:bg-muted",
                )}
              >
                <Mic className={cn("w-5 h-5", listening && "animate-pulse")} />
              </button>
              <button
                onClick={() => send()}
                disabled={(!text.trim() && !attachment) || ai.streaming || uploading}
                aria-label="Send message"
                style={{ borderRadius: 9999 }}
                className="btn-3d btn-3d-sm w-10 h-10 flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
              >
                {ai.streaming ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-[18px] h-[18px]" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Subcomponents ───────────────────────────────────────────────────────────

/**
 * Small live "agents working" cue in the chat header. Polls agent status every
 * 3s and shows a pulsing dot + the active agents' names while any are busy
 * (thinking/executing/waiting); renders nothing when the swarm is idle.
 */
function WorkingIndicator() {
  const { data: agents = [] } = useListAgents({
    query: { refetchInterval: 3000, queryKey: getListAgentsQueryKey() },
  });
  const busy = agents.filter((a) => a.status && a.status !== "idle");
  if (busy.length === 0) return null;
  const names = busy.map((a) => a.name).join(", ");
  return (
    <div
      title={busy.map((a) => `${a.name}: ${a.status}`).join(" · ")}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary shrink-0"
    >
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-60" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
      </span>
      <span className="text-xs font-medium max-w-[40vw] sm:max-w-[16rem] truncate">
        {busy.length === 1 ? `${names} working…` : `${busy.length} agents working…`}
      </span>
    </div>
  );
}

function Avatar({ name, color }: { name: string; color: string }) {
  const initials = name.split(/[\s.]+/).slice(0, 2).map((s) => s[0]).join("").toUpperCase();
  return (
    <div
      className="w-8 h-8 rounded-lg shrink-0 flex items-center justify-center text-xs font-bold"
      style={{ backgroundColor: `${color}22`, color, border: `1px solid ${color}44` }}
    >
      {initials || "AI"}
    </div>
  );
}

function MessageRow({ message: m }: { message: { messageType: string; content: string; agentName?: string | null; agentColor?: string | null } }) {
  if (m.messageType === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary/15 border border-primary/20 px-4 py-2.5">
          <MessageContent content={m.content} />
        </div>
      </div>
    );
  }
  if (m.messageType === "system") {
    return (
      <div className="flex justify-center">
        <div className="text-xs text-muted-foreground bg-card/60 border border-card-border rounded-full px-3 py-1">{m.content}</div>
      </div>
    );
  }
  const color = m.agentColor || "#22d3ee";
  const isTool = m.messageType === "tool_output";
  return (
    <div className="flex gap-3">
      <Avatar name={m.agentName || "Assistant"} color={color} />
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted-foreground mb-1">{m.agentName || "Assistant"}</div>
        {isTool ? (
          <div className="rounded-lg border border-card-border bg-card/50 px-3 py-2 font-mono text-[13px] text-muted-foreground whitespace-pre-wrap break-words overflow-x-auto">
            {m.content}
          </div>
        ) : (
          <>
            <MessageContent content={m.content} />
            <MessageActions content={m.content} />
          </>
        )}
      </div>
    </div>
  );
}

// Per-message actions every frontier chat has: copy to clipboard + read aloud (TTS).
function MessageActions({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  const copy = () => {
    navigator.clipboard?.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const speak = () => {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (!synth) {
      toast.error("Text-to-speech isn't supported in this browser.");
      return;
    }
    if (speaking) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    // Strip markdown noise so it reads naturally.
    const clean = content.replace(/[#*`>_~|]/g, " ").replace(/\[(.*?)\]\((.*?)\)/g, "$1").replace(/\s+/g, " ").trim();
    const u = new SpeechSynthesisUtterance(clean);
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    synth.cancel();
    synth.speak(u);
    setSpeaking(true);
  };

  return (
    <div className="mt-1.5 flex items-center gap-1">
      <button
        onClick={copy}
        title="Copy message"
        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded"
      >
        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
      <button
        onClick={speak}
        title={speaking ? "Stop" : "Read aloud"}
        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded"
      >
        {speaking ? <Square className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
        {speaking ? "Stop" : "Listen"}
      </button>
    </div>
  );
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1 py-2" aria-label="Assistant is typing">
      {[0, 1, 2].map((i) => (
        <span key={i} className="w-2 h-2 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
      ))}
    </div>
  );
}

// Warm gradient "spark" — the brand mark on the empty-state hero (Gemini-style,
// but in the Abby AI clay/amber palette rather than copying Google's colours).
function GradientSpark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="abby-spark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f59e0b" />
          <stop offset="55%" stopColor="#1a73e8" />
          <stop offset="100%" stopColor="#9a6a43" />
        </linearGradient>
      </defs>
      <path fill="url(#abby-spark)" d="M12 0c1 7 4 10 12 12-8 2-11 5-12 12-1-7-4-10-12-12 8-2 11-5 12-12Z" />
    </svg>
  );
}

function EmptyConversation({ onPrompt }: { onPrompt: (p: string) => void }) {
  const prompts: Array<{ label: string; prompt: string }> = [
    { label: "Instagram lead-gen post", prompt: "Use the marketing engine to write + post a lead-gen Instagram post for AI automation, with a real cited stat" },
    { label: "7-email nurture sequence", prompt: "Draft a 7-email nurture sequence (CAN-SPAM compliant) for a real-estate audience" },
    { label: "30-day content calendar", prompt: "Build a 30-day social media content calendar for a fitness coaching brand" },
    { label: "Generate an image", prompt: "Generate an ultra realistic image of a husky in the snow" },
    { label: "Research + PDF brief", prompt: "Research the EV market and build a downloadable PDF brief with TAM/SAM/SOM" },
    { label: "Scrape & summarize", prompt: "Scrape news.ycombinator.com and give me the top 5 stories as a table" },
  ];
  return (
    <div className="flex flex-col items-center justify-center min-h-[55vh] text-center gap-8 px-4">
      <div className="flex flex-col items-center gap-5">
        <GradientSpark className="w-12 h-12" />
        <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground/90">What can Abby do for you?</h2>
      </div>
      <div className="flex flex-wrap justify-center gap-2.5 max-w-2xl">
        {prompts.map((p) => (
          <button
            key={p.label}
            onClick={() => onPrompt(p.prompt)}
            title={p.prompt}
            className="rounded-full border border-card-border bg-card px-4 py-2 text-sm text-foreground/80 hover:border-primary/50 hover:text-foreground hover:bg-card transition-colors shadow-[0_1px_4px_rgba(74,46,20,0.06)]"
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}
