import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type { AgentMode, BusChannel, BusMemoryEntry, BusMessage, ChatMessage, PersistedApproval, SessionKind, SessionRecord, SessionSummary } from "../../shared/contracts";
import { renameWithRetry } from "./atomic";

const nodeRequire = createRequire(import.meta.url);

export class SessionStore {
  private readonly db: Database;
  private readonly filePath: string;
  private closed = false;
  private flushQueue: Promise<void> = Promise.resolve();
  private flushSequence = 0;

  private constructor(db: Database, filePath: string) {
    this.db = db;
    this.filePath = filePath;
  }

  static async open(dataDir: string): Promise<SessionStore> {
    await mkdir(dataDir, { recursive: true });
    const wasmPath = nodeRequire.resolve("sql.js/dist/sql-wasm.wasm");
    const SQL: SqlJsStatic = await initSqlJs({ locateFile: () => wasmPath, useOldExtensionFunctions: false });
    const filePath = path.join(dataDir, "openhack.sqlite");
    let db: Database;
    try {
      db = new SQL.Database(await readFile(filePath));
    } catch {
      db = new SQL.Database();
    }
    db.run("PRAGMA foreign_keys = ON");
    db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'chat',
        mode TEXT NOT NULL DEFAULT 'act',
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        reasoning TEXT,
        tool_calls TEXT,
        tool_call_id TEXT,
        name TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        model TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE TABLE IF NOT EXISTS bus_messages (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        sender TEXT NOT NULL,
        recipient TEXT,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        hops INTEGER NOT NULL DEFAULT 0,
        run_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS bus_messages_channel ON bus_messages(channel);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        args_json TEXT NOT NULL,
        risk TEXT NOT NULL,
        digest TEXT NOT NULL,
        agent_name TEXT,
        workspace TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS approvals_pending ON approvals(status, session_id);
      CREATE TABLE IF NOT EXISTS bus_memory (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    // Sessions predating these features get additive columns so old data still opens.
    for (const [column, ddl] of [
      ["kind", "ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'"],
      ["mode", "ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'act'"],
      ["summary", "ALTER TABLE sessions ADD COLUMN summary TEXT"],
    ] as const) {
      try {
        db.exec(`SELECT ${column} FROM sessions LIMIT 1`);
      } catch {
        try {
          db.run(ddl);
        } catch {
          // Another migration already added the column.
        }
      }
    }
    // Worker attribution is additive so existing sessions keep loading.
    for (const column of ["agent_id TEXT", "agent_name TEXT", "agent_role TEXT", "parent_call_id TEXT"]) {
      try {
        db.exec(`SELECT ${column.split(" ")[0]} FROM messages LIMIT 1`);
      } catch {
        try {
          db.run(`ALTER TABLE messages ADD COLUMN ${column}`);
        } catch {
          // Column already present.
        }
      }
    }
    db.run("UPDATE runs SET status = 'interrupted', ended_at = ? WHERE status = 'running'", [new Date().toISOString()]);
    const store = new SessionStore(db, filePath);
    await store.flush();
    return store;
  }

  listSessions(kind: "chat" | "bus" | "all" = "chat"): SessionSummary[] {
    const rows = this.rows(`
      SELECT s.*, COUNT(m.id) AS message_count
      FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
      ${kind === "all" ? "" : "WHERE s.kind = ?"}
      GROUP BY s.id ORDER BY s.updated_at DESC
    `, kind === "all" ? [] : [kind]);
    return rows.map((row) => this.toSummary(row));
  }

  getSession(id: string): SessionRecord | null {
    const row = this.rows("SELECT * FROM sessions WHERE id = ?", [id])[0];
    if (!row) return null;
    const messages = this.rows("SELECT * FROM messages WHERE session_id = ? ORDER BY rowid", [id]).map((message): ChatMessage => ({
      id: String(message.id),
      role: String(message.role) as ChatMessage["role"],
      content: String(message.content ?? ""),
      ...(message.reasoning ? { reasoning: String(message.reasoning) } : {}),
      ...(message.tool_calls ? { tool_calls: JSON.parse(String(message.tool_calls)) as ChatMessage["tool_calls"] } : {}),
      ...(message.tool_call_id ? { tool_call_id: String(message.tool_call_id) } : {}),
      ...(message.name ? { name: String(message.name) } : {}),
      ...(message.agent_id ? { agentId: String(message.agent_id) } : {}),
      ...(message.agent_name ? { agentName: String(message.agent_name) } : {}),
      ...(message.agent_role ? { agentRole: String(message.agent_role) } : {}),
      ...(message.parent_call_id ? { parentCallId: String(message.parent_call_id) } : {}),
      createdAt: String(message.created_at),
    }));
    return { ...this.toSummary(row), messages, ...(row.summary ? { summary: String(row.summary) } : {}) };
  }

  async createSession(input: Omit<SessionSummary, "id" | "createdAt" | "updatedAt" | "messageCount" | "title" | "kind" | "mode"> & { id?: string; title?: string; kind?: SessionKind; mode?: AgentMode }): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const session: SessionSummary = {
      id: input.id || randomUUID(),
      title: input.title?.trim().slice(0, 120) || "New investigation",
      workspacePath: input.workspacePath,
      providerId: input.providerId,
      model: input.model,
      kind: input.kind ?? "chat",
      mode: input.mode ?? "act",
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };
    this.db.run("INSERT INTO sessions (id,title,workspace_path,provider_id,model,kind,mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", [
      session.id, session.title, session.workspacePath, session.providerId, session.model, session.kind ?? "chat", session.mode ?? "act", now, now,
    ]);
    await this.flush();
    return { ...session, messages: [] };
  }

  async updateSession(id: string, patch: Partial<Pick<SessionSummary, "title" | "providerId" | "model" | "mode">>): Promise<void> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const columns: Record<string, string> = { title: "title", providerId: "provider_id", model: "model", mode: "mode" };
    const set = entries.map(([key]) => `${columns[key]} = ?`).join(", ");
    this.db.run(`UPDATE sessions SET ${set}, updated_at = ? WHERE id = ?`, [...entries.map(([, value]) => value as string), new Date().toISOString(), id]);
    await this.flush();
  }

  async appendMessage(sessionId: string, message: ChatMessage): Promise<ChatMessage> {
    const stored: ChatMessage = {
      ...message,
      id: message.id || randomUUID(),
      createdAt: message.createdAt || new Date().toISOString(),
    };
    this.db.run(
      "INSERT INTO messages (id,session_id,role,content,reasoning,tool_calls,tool_call_id,name,agent_id,agent_name,agent_role,parent_call_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        stored.id!, sessionId, stored.role, stored.content, stored.reasoning ?? null,
        stored.tool_calls ? JSON.stringify(stored.tool_calls) : null,
        stored.tool_call_id ?? null, stored.name ?? null,
        stored.agentId ?? null, stored.agentName ?? null, stored.agentRole ?? null, stored.parentCallId ?? null,
        stored.createdAt!,
      ],
    );
    this.touch(sessionId);
    await this.flush();
    return stored;
  }

  appendDelta(messageId: string, field: "content" | "reasoning", text: string): void {
    this.db.run(`UPDATE messages SET ${field} = COALESCE(${field}, '') || ? WHERE id = ?`, [text, messageId]);
  }

  async setMessage(messageId: string, patch: { content?: string; reasoning?: string; toolCalls?: ChatMessage["tool_calls"] }): Promise<void> {
    if (patch.content !== undefined) this.db.run("UPDATE messages SET content = ? WHERE id = ?", [patch.content, messageId]);
    if (patch.reasoning !== undefined) this.db.run("UPDATE messages SET reasoning = ? WHERE id = ?", [patch.reasoning, messageId]);
    if (patch.toolCalls) this.db.run("UPDATE messages SET tool_calls = ? WHERE id = ?", [JSON.stringify(patch.toolCalls), messageId]);
    await this.flush();
  }

  async setSessionSummary(sessionId: string, summary: string): Promise<void> {
    this.db.run("UPDATE sessions SET summary = ? WHERE id = ?", [summary.slice(-16000), sessionId]);
    await this.flush();
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.db.run("DELETE FROM sessions WHERE id = ?", [sessionId]);
    await this.flush();
  }

  appendBusMessage(message: BusMessage): BusMessage {
    const stored: BusMessage = {
      ...message,
      id: message.id || randomUUID(),
      createdAt: message.createdAt || new Date().toISOString(),
    };
    this.db.run(
      "INSERT INTO bus_messages (id,channel,sender,recipient,kind,content,hops,run_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      [stored.id, stored.channel, stored.sender, stored.recipient ?? null, stored.kind, stored.content, stored.hops ?? 0, stored.runId ?? null, stored.createdAt ?? new Date().toISOString()],
    );
    return stored;
  }

  listBusMessages(channel: string, limit = 200): BusMessage[] {
    return this.rows(
      "SELECT * FROM bus_messages WHERE channel = ? ORDER BY rowid DESC LIMIT ?",
      [channel, Math.min(Math.max(limit, 1), 500)],
    ).reverse().map((row) => this.toBusMessage(row));
  }

  busChannels(): BusChannel[] {
    return this.rows(`
      SELECT channel, COUNT(*) AS message_count, MAX(created_at) AS last_at
      FROM bus_messages GROUP BY channel ORDER BY last_at DESC
    `).map((row) => ({
      channel: String(row.channel),
      messageCount: Number(row.message_count),
      lastAt: row.last_at ? String(row.last_at) : undefined,
    }));
  }

  saveApproval(record: PersistedApproval): void {
    this.db.run(
      "INSERT OR REPLACE INTO approvals (id,session_id,run_id,call_id,tool,args_json,risk,digest,agent_name,workspace,policy_version,issued_at,expires_at,status,decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        record.id, record.sessionId, record.runId, record.callId, record.tool, record.argumentsJson,
        record.risk, record.digest, record.agentName ?? null, record.workspace, record.policyVersion,
        record.issuedAt, record.expiresAt, record.status, record.decidedAt ?? null,
      ],
    );
  }

  pendingApprovals(sessionId?: string): PersistedApproval[] {
    const rows = sessionId
      ? this.rows("SELECT * FROM approvals WHERE status = 'pending' AND session_id = ? ORDER BY issued_at DESC", [sessionId])
      : this.rows("SELECT * FROM approvals WHERE status = 'pending' ORDER BY issued_at DESC");
    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      runId: String(row.run_id),
      callId: String(row.call_id),
      tool: String(row.tool),
      argumentsJson: String(row.args_json),
      risk: String(row.risk),
      digest: String(row.digest),
      ...(row.agent_name ? { agentName: String(row.agent_name) } : {}),
      workspace: String(row.workspace),
      policyVersion: String(row.policy_version),
      issuedAt: String(row.issued_at),
      expiresAt: String(row.expires_at),
      status: String(row.status) as PersistedApproval["status"],
      ...(row.decided_at ? { decidedAt: String(row.decided_at) } : {}),
    }));
  }

  getApproval(id: string): PersistedApproval | null {
    const row = this.rows("SELECT * FROM approvals WHERE id = ?", [id])[0];
    if (!row) return null;
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      runId: String(row.run_id),
      callId: String(row.call_id),
      tool: String(row.tool),
      argumentsJson: String(row.args_json),
      risk: String(row.risk),
      digest: String(row.digest),
      ...(row.agent_name ? { agentName: String(row.agent_name) } : {}),
      workspace: String(row.workspace),
      policyVersion: String(row.policy_version),
      issuedAt: String(row.issued_at),
      expiresAt: String(row.expires_at),
      status: String(row.status) as PersistedApproval["status"],
      ...(row.decided_at ? { decidedAt: String(row.decided_at) } : {}),
    };
  }

  async finishApproval(id: string, status: PersistedApproval["status"]): Promise<void> {
    this.db.run("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?", [status, new Date().toISOString(), id]);
    await this.flush();
  }

  async expireApprovals(now = new Date().toISOString()): Promise<number> {
    const before = this.rows("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending' AND expires_at <= ?", [now])[0];
    this.db.run("UPDATE approvals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND expires_at <= ?", [now, now]);
    await this.flush();
    return Number(before?.n ?? 0);
  }

  countSessionWorkers(sessionId: string): number {
    const row = this.rows(
      "SELECT COUNT(DISTINCT agent_id) AS n FROM messages WHERE session_id = ? AND agent_id IS NOT NULL",
      [sessionId],
    )[0];
    return Number(row?.n ?? 0);
  }

  busMemory(): BusMemoryEntry[] {    return this.rows("SELECT * FROM bus_memory ORDER BY updated_at DESC").map((row) => ({
      key: String(row.key),
      value: String(row.value),
      updatedBy: String(row.updated_by),
      updatedAt: String(row.updated_at),
    }));
  }

  async setBusMemory(key: string, value: string, updatedBy: string): Promise<BusMemoryEntry> {
    const entry: BusMemoryEntry = { key, value, updatedBy, updatedAt: new Date().toISOString() };
    this.db.run(
      "INSERT INTO bus_memory (key,value,updated_by,updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at",
      [entry.key, entry.value, entry.updatedBy, entry.updatedAt],
    );
    await this.flush();
    return entry;
  }

  async deleteBusMemory(key: string): Promise<void> {
    this.db.run("DELETE FROM bus_memory WHERE key = ?", [key]);
    await this.flush();
  }

  async startRun(runId: string, sessionId: string, model: string): Promise<void> {
    this.db.run("INSERT INTO runs (id,session_id,status,model,created_at) VALUES (?,?,'running',?,?)", [runId, sessionId, model, new Date().toISOString()]);
    await this.flush();
  }

  async finishRun(runId: string, status: "completed" | "failed" | "cancelled", error?: string): Promise<void> {
    this.db.run("UPDATE runs SET status = ?, error = ?, ended_at = ? WHERE id = ?", [status, error ?? null, new Date().toISOString(), runId]);
    await this.flush();
  }

  async flush(): Promise<void> {
    const write = this.flushQueue.then(async () => {
      if (this.closed) return;
      this.flushSequence += 1;
      const temporary = `${this.filePath}.${process.pid}.${this.flushSequence}.tmp`;
      await writeFile(temporary, Buffer.from(this.db.export()));
      await renameWithRetry(temporary, this.filePath);
    });
    // Keep later writes ordered even when an individual write fails; the caller
    // still receives that failure on its own returned promise.
    this.flushQueue = write.catch(() => undefined);
    return write;
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
    this.db.close();
  }

  private touch(sessionId: string): void {
    this.db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [new Date().toISOString(), sessionId]);
  }

  private rows(sql: string, params: Array<string | number | null> = []): Array<Record<string, unknown>> {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(params);
      const rows: Array<Record<string, unknown>> = [];
      while (statement.step()) rows.push(statement.getAsObject() as Record<string, unknown>);
      return rows;
    } finally {
      statement.free();
    }
  }

  private toBusMessage(row: Record<string, unknown>): BusMessage {
    return {
      id: String(row.id),
      channel: String(row.channel),
      sender: String(row.sender),
      ...(row.recipient ? { recipient: String(row.recipient) } : {}),
      kind: String(row.kind) as BusMessage["kind"],
      content: String(row.content),
      hops: Number(row.hops ?? 0),
      ...(row.run_id ? { runId: String(row.run_id) } : {}),
      createdAt: String(row.created_at),
    };
  }

  private toSummary(row: Record<string, unknown>): SessionSummary {
    return {
      id: String(row.id),
      title: String(row.title),
      workspacePath: String(row.workspace_path),
      providerId: String(row.provider_id),
      model: String(row.model),
      kind: (row.kind === "bus" ? "bus" : "chat") as SessionKind,
      mode: (row.mode === "plan" ? "plan" : "act") as AgentMode,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(row.message_count !== undefined ? { messageCount: Number(row.message_count) } : {}),
    };
  }
}
