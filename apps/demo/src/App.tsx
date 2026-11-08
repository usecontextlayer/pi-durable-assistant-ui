import { useCallback, useEffect, useState } from "react";
import {
  ActionBarPrimitive,
  AttachmentPrimitive,
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  ThreadPrimitive,
  WebSpeechDictationAdapter,
  WebSpeechSynthesisAdapter,
  useAui,
  useAuiState,
  type DataMessagePartProps,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { createHttpPiDurableClient, createPiDurableAttachmentAdapter, usePiDurableRuntime, usePiDurable, type SerializedAgentChange, type ConversationId } from "@usecontextlayer/pi-durable-assistant-ui";
import { ResetEntry, CompactionEntry, type AgentState, type EntryId } from "@earendil-works/pi-durable";
import { PiControls, type RegisteredModel } from "./PiControls";
import { HumanInputTool, toolRenderers } from "./ToolRenderers";
import { HarnessInspector } from "./HarnessInspector";

const client = createHttpPiDurableClient({ baseUrl: "/api" });
const attachments = createPiDurableAttachmentAdapter(client.uploadFile);
const speech = typeof window !== "undefined" && "speechSynthesis" in window ? new WebSpeechSynthesisAdapter() : undefined;
const dictation = WebSpeechDictationAdapter.isSupported() ? new WebSpeechDictationAdapter() : undefined;

const connectionLabels = {
  idle: "Ready",
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  closed: "Disconnected",
} as const;

export function App() {
  const [threadId, setThreadId] = useState<ConversationId | undefined>(() => {
    const value = new URL(window.location.href).searchParams.get("conversation");
    const id = value === null ? undefined : Number(value);
    return id !== undefined && Number.isSafeInteger(id) && id > 0 ? id as ConversationId : undefined;
  });
  const onThreadIdChange = useCallback((id: ConversationId | undefined) => {
    setThreadId(id);
    const url = new URL(window.location.href);
    if (id === undefined) url.searchParams.delete("conversation");
    else url.searchParams.set("conversation", String(id));
    window.history.replaceState(window.history.state, "", url);
  }, []);
  const runtime = usePiDurableRuntime({ client, threadId, onThreadIdChange, attachments, speech, dictation });
  return <AssistantRuntimeProvider runtime={runtime}><ChatApp /></AssistantRuntimeProvider>;
}

function ChatApp() {
  const aui = useAui();
  const { conversation, state } = usePiDurable();
  const id = conversation?.id;
  const threads = useAuiState((s) => s.threads);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [defaultAgent, setDefaultAgent] = useState<SerializedAgentChange>();
  const [models, setModels] = useState<readonly RegisteredModel[]>([]);
  const [metadataError, setMetadataError] = useState<Error>();

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/models", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not load model information (${response.status})`);
        return response.json() as Promise<{ defaultAgent: SerializedAgentChange; models: RegisteredModel[] }>;
      })
      .then((metadata) => {
        setDefaultAgent(metadata.defaultAgent);
        setModels(metadata.models);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setMetadataError(cause instanceof Error ? cause : new Error(String(cause)));
      });
    return () => controller.abort();
  }, []);

  useEffect(() => { setSidebarOpen(false); }, [id]);

  const model = id === undefined
    ? defaultAgent?.model
    : (state.view?.docs["pi.agent"] as AgentState | undefined)?.model;
  const modelLabel = model
    ? model.provider === "faux"
      ? `Deterministic demo · ${model.provider}/${model.modelId}`
      : `${model.provider}/${model.modelId}`
    : metadataError
      ? "Model information unavailable"
      : state.isLoading || !defaultAgent
        ? "Loading model…"
        : "No model configured";
  const conversationTitle = id === undefined ? "Pi Durable" : state.metadata.title ?? `Conversation ${id}`;
  const error = state.error ?? threads.loadError ?? threads.switchError?.error;
  const selectConversation = (value: ConversationId) => aui.threads().switchToThread(String(value));
  const fork = async (entryId: EntryId) => {
    if (!conversation) throw new Error("Select a conversation before forking");
    const created = await conversation.forkAt(entryId);
    selectConversation(created.id);
  };
  const retry = () => { void aui.threads().reloadMainThread().catch((error) => conversation?.reportError(error)); };

  return (
    <div className="app-shell">
        {sidebarOpen ? (
          <button
            className="sidebar-backdrop"
            aria-label="Close conversations"
            onClick={() => setSidebarOpen(false)}
          />
        ) : null}
        <aside className="sidebar" data-open={sidebarOpen} aria-label="Conversations">
          <div className="sidebar-heading">Pi Durable</div>
          <ThreadListPrimitive.Root className="conversation-list">
            <ThreadListPrimitive.New className="new-conversation">
              New conversation
            </ThreadListPrimitive.New>
            <h2 className="list-heading">Conversations</h2>
            {threads.isLoading && threads.threadIds.length === 0 ? (
              <p className="sidebar-note" role="status">Loading conversations…</p>
            ) : null}
            <ThreadListPrimitive.Items>{() => <ConversationItem />}</ThreadListPrimitive.Items>
            {!threads.isLoading && threads.threadIds.length === 0 ? (
              <p className="sidebar-note">Your conversations will appear here.</p>
            ) : null}
          </ThreadListPrimitive.Root>
          {threads.hasMore ? <button className="directory-refresh" disabled={threads.isLoadingMore} onClick={() => void aui.threads().loadMore()}>Load more conversations</button> : null}
          <button className="directory-refresh" onClick={() => void aui.threads().reload()}>Refresh conversations</button>
          <p className="sidebar-footer">History is saved locally with Pi.</p>
        </aside>

        <main className="main-panel">
          <header className="conversation-header">
            <button
              className="sidebar-toggle"
              aria-label="Toggle conversations"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              Conversations
            </button>
            <div className="conversation-heading">
              <h1>
                {conversationTitle}
              </h1>
              <span className="model-label" title={metadataError?.message}>{modelLabel}</span>
            </div>
            <span className="connection-status" role="status" aria-live="polite">
              {isRunning ? "Working" : connectionLabels[state.connection]}
            </span>
          </header>

          {error ? (
            <div className="connection-error" role="alert">
              <span>{error instanceof Error ? error.message : String(error)}</span>
              <button onClick={retry}>Retry connection</button>
            </div>
          ) : null}

          {conversation ? <PiControls key={conversation.id} client={client} state={state} actions={conversation} models={models} onSelectConversation={selectConversation} /> : null}
          <HarnessInspector load={async () => { const [inspection] = await Promise.all([client.inspect(), aui.threads().reload()]); return inspection; }} onSelectConversation={selectConversation} />

          <ThreadPrimitive.Root className="thread">
            <ThreadPrimitive.Viewport className="thread-viewport">
              <div className="thread-content">
                {state.view?.items[0]?.kind === "earlier" ? (
                  <ThreadPrimitive.LoadEarlier className="load-earlier">
                    <AuiIf condition={(s) => s.thread.isLoadingEarlier}>
                      Loading earlier messages…
                    </AuiIf>
                    <AuiIf condition={(s) => !s.thread.isLoadingEarlier}>
                      Load earlier messages
                    </AuiIf>
                  </ThreadPrimitive.LoadEarlier>
                ) : null}

                <AuiIf condition={(s) => s.thread.isEmpty}>
                  <div className="thread-empty">
                    <h2>What would you like to work on?</h2>
                    <p>Start a conversation with the local Pi agent.</p>
                  </div>
                </AuiIf>

                <ThreadPrimitive.Messages>
                  {({ message }) => message.composer.isEditing ? <EditComposer /> : (
                    <ChatMessage
                      role={message.role}
                      entryId={typeof message.metadata.custom.entryId === "number" ? message.metadata.custom.entryId as EntryId : undefined}
                      editEntryId={typeof message.metadata.custom.editEntryId === "number" ? message.metadata.custom.editEntryId as EntryId : undefined}
                      entryKind={typeof message.metadata.custom.entryKind === "string" ? message.metadata.custom.entryKind : undefined}
                      onFork={fork}
                    />
                  )}
                </ThreadPrimitive.Messages>

                {state.isLoading ? (
                  <p className="thread-loading" role="status">Loading conversation…</p>
                ) : null}
              </div>

              <ThreadPrimitive.ViewportFooter className="thread-footer">
                <div className="composer-container">
                  <ThreadPrimitive.ScrollToBottom className="scroll-to-bottom">
                    Jump to latest
                  </ThreadPrimitive.ScrollToBottom>
                  <AuiIf condition={(s) => !s.thread.isRunning && s.thread.suggestions.length > 0}>
                    <div className="suggestions">
                      <ThreadPrimitive.Suggestions>
                        {() => <SuggestionPrimitive.Trigger className="suggestion" send><SuggestionPrimitive.Title /></SuggestionPrimitive.Trigger>}
                      </ThreadPrimitive.Suggestions>
                    </div>
                  </AuiIf>
                  <Composer />
                  <p className="composer-hint">Enter to send · Shift + Enter for a new line</p>
                </div>
              </ThreadPrimitive.ViewportFooter>
            </ThreadPrimitive.Viewport>
          </ThreadPrimitive.Root>
        </main>
    </div>
  );
}

function ConversationItem() {
  const aui = useAui();
  const item = useAuiState((s) => s.threadListItem);
  const title = item.title ?? (item.remoteId ? `Conversation ${item.remoteId}` : "New conversation");
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <ThreadListItemPrimitive.Root className="conversation-item">
      {renaming ? (
        <form className="rename-conversation" onSubmit={async (event) => {
          event.preventDefault();
          const title = String(new FormData(event.currentTarget).get("title") ?? "").trim();
          try {
            await aui.threadListItem().rename(title);
            setRenaming(false);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }}>
          <input name="title" aria-label="Conversation title" defaultValue={item.title ?? ""} autoFocus />
          <div><button type="submit">Save title</button><button type="button" onClick={() => setRenaming(false)}>Cancel</button></div>
        </form>
      ) : (
        <div className="conversation-row">
          <ThreadListItemPrimitive.Trigger className="conversation-trigger">
            <ThreadListItemPrimitive.Title fallback={title} />
          </ThreadListItemPrimitive.Trigger>
          <details className="conversation-menu">
            <summary aria-label={`Actions for ${title}`}>More</summary>
            <div>
              <button onClick={() => setRenaming(true)}>Rename</button>

            </div>
          </details>
        </div>
      )}
      {error ? <p className="control-error" role="alert">{error}</p> : null}
    </ThreadListItemPrimitive.Root>
  );
}

function Composer() {
  const aui = useAui();
  const canSend = useAuiState((s) => s.composer.canSend && !s.thread.isDisabled);
  return (
    <ComposerPrimitive.Root className="composer">
      <ComposerPrimitive.AttachmentDropzone className="composer-dropzone">
        <ComposerPrimitive.Attachments components={{ Attachment: ComposerAttachment }} />
        <AuiIf condition={(s) => s.thread.isRunning && s.composer.attachments.length > 0}>
          <p className="sidebar-note" role="status">Send attachments after the current response finishes.</p>
        </AuiIf>
        <ComposerPrimitive.Input
          className="composer-input"
          aria-label="Message"
          placeholder="Message Pi…"
          rows={1}
          autoFocus
        />
        <div className="composer-actions">
          <ComposerPrimitive.AddAttachment className="text-button" aria-label="Attach files">Attach files</ComposerPrimitive.AddAttachment>
          <AuiIf condition={(s) => s.thread.capabilities.dictation && s.composer.dictation === undefined}>
            <ComposerPrimitive.Dictate className="text-button">Dictate</ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.thread.capabilities.dictation && s.composer.dictation !== undefined}>
            <ComposerPrimitive.StopDictation className="text-button">Stop dictation</ComposerPrimitive.StopDictation>
          </AuiIf>
          <div className="send-actions">
            <AuiIf condition={(s) => s.thread.isRunning && s.thread.capabilities.queue}>
              <button type="button" className="text-button" disabled={!canSend} onClick={() => aui.composer().send({ steer: false })}>Queue follow-up</button>
            </AuiIf>
            <AuiIf condition={(s) => s.thread.isRunning && s.thread.capabilities.cancel}>
              <ComposerPrimitive.Cancel className="stop-button" aria-label="Stop response">Stop</ComposerPrimitive.Cancel>
            </AuiIf>
            <ComposerPrimitive.Send className="send-button">
              <AuiIf condition={(s) => s.thread.isRunning}>Steer</AuiIf>
              <AuiIf condition={(s) => !s.thread.isRunning}>Send</AuiIf>
            </ComposerPrimitive.Send>
          </div>
        </div>
        <AuiIf condition={(s) => s.composer.dictation !== undefined}>
          <div className="dictation-transcript"><ComposerPrimitive.DictationTranscript /></div>
        </AuiIf>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
}

function ComposerAttachment() {
  return (
    <AttachmentPrimitive.Root className="composer-attachment">
      <AttachmentPrimitive.unstable_Thumb className="attachment-preview" />
      <span className="attachment-name"><AttachmentPrimitive.Name /></span>
      <AttachmentPrimitive.Remove className="text-button" aria-label="Remove attachment">Remove</AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

function EditComposer() {
  return (
    <ComposerPrimitive.Root className="composer edit-composer">
      <ComposerPrimitive.Input className="composer-input" aria-label="Edit message" autoFocus />
      <div className="composer-actions">
        <ComposerPrimitive.Cancel className="edit-cancel">Cancel edit</ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send className="send-button">Save as fork</ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  );
}

function ChatMessage({ role, entryId, editEntryId, entryKind, onFork }: {
  role: "user" | "assistant" | "system";
  entryId?: EntryId;
  editEntryId?: EntryId;
  entryKind?: string;
  onFork: (id: EntryId) => Promise<unknown>;
}) {
  const [forking, setForking] = useState(false);
  const [error, setError] = useState<string>();
  const forkEntryId = editEntryId ?? entryId;
  const branchCount = useAuiState((s) => s.message.branchCount);
  const isNotice = entryKind === ResetEntry.kind || entryKind === CompactionEntry.kind;

  const fork = async () => {
    if (forkEntryId === undefined) return;
    setForking(true);
    setError(undefined);
    try {
      await onFork(forkEntryId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setForking(false);
    }
  };

  return (
    <MessagePrimitive.Root className="message" data-role={role} data-entry-id={entryId} data-branch-count={branchCount}>
      <div className="message-label">
        {isNotice ? "Context" : role === "user" ? "You" : role === "assistant" ? "Pi" : "System"}
      </div>
      <div className="message-content">
        <MessagePrimitive.Parts components={messageParts} />
        <MessagePrimitive.Error>
          <ErrorPrimitive.Root className="message-error">
            <ErrorPrimitive.Message />
          </ErrorPrimitive.Root>
        </MessagePrimitive.Error>
      </div>
      {isNotice ? null : <ActionBarPrimitive.Root className="message-actions">
        <ActionBarPrimitive.Copy className="text-button">Copy</ActionBarPrimitive.Copy>
        {forkEntryId !== undefined ? <button className="text-button" disabled={forking} onClick={() => void fork()}>{forking ? "Forking…" : "Fork from here"}</button> : null}
        {role === "user" && entryKind === "pi.user" ? <AuiIf condition={(s) => s.thread.capabilities.edit}><ActionBarPrimitive.Edit className="text-button">Edit</ActionBarPrimitive.Edit></AuiIf> : null}
        {role === "assistant" && entryKind === "pi.assistant" ? <AuiIf condition={(s) => s.thread.capabilities.reload}><ActionBarPrimitive.Reload className="text-button">Regenerate</ActionBarPrimitive.Reload></AuiIf> : null}
        {role === "assistant" && entryKind === "pi.assistant" ? (
          <AuiIf condition={(s) => s.thread.capabilities.feedback}>
            <ActionBarPrimitive.FeedbackPositive className="text-button" aria-label="Mark helpful">Helpful</ActionBarPrimitive.FeedbackPositive>
            <ActionBarPrimitive.FeedbackNegative className="text-button" aria-label="Mark not helpful">Not helpful</ActionBarPrimitive.FeedbackNegative>
          </AuiIf>
        ) : null}
        <AuiIf condition={(s) => s.thread.capabilities.speech && (!s.message.speech || s.message.speech.status.type === "ended")}>
          <ActionBarPrimitive.Speak className="text-button">Read aloud</ActionBarPrimitive.Speak>
        </AuiIf>
        <AuiIf condition={(s) => s.thread.capabilities.speech && s.message.speech !== undefined && s.message.speech.status.type !== "ended"}>
          <ActionBarPrimitive.StopSpeaking className="text-button">Stop reading</ActionBarPrimitive.StopSpeaking>
        </AuiIf>
      </ActionBarPrimitive.Root>}
      {error ? <p className="control-error" role="alert">{error}</p> : null}
    </MessagePrimitive.Root>
  );
}

function MarkdownText() {
  return <MarkdownTextPrimitive className="markdown" />;
}

function Reasoning({ text }: { text: string }) {
  return (
    <details className="reasoning">
      <summary>Reasoning</summary>
      <div className="reasoning-content">{text}</div>
    </details>
  );
}

const messageParts = {
  Text: MarkdownText,
  Reasoning,
  tools: { ...toolRenderers, by_name: { ...toolRenderers.by_name, request_human_input: HumanInputTool } },
  data: { by_name: { "pi-context": ContextNotice } },
};

function ContextNotice({ data }: DataMessagePartProps<{ kind: string; text: string }>) {
  return <div className="context-notice">
    <p>{data.kind === "pi.reset" ? "Conversation context reset" : "Conversation context compacted"}</p>
    {data.text ? <p style={{ whiteSpace: "pre-wrap" }}>{data.text}</p> : null}
  </div>;
}
