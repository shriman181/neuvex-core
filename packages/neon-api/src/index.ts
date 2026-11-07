// A small client for the parts of the Neon API v2 that Neuvex uses. Plain fetch, so it
// runs in Workers and Node alike. Neon runs most changes as background operations and
// answers 423 while a project has one running; this client waits for operations and
// retries on 423, 429 and 5xx, so callers can go step by step.

export const NEON_API = "https://console.neon.tech/api/v2";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface NeonApiOptions {
  apiKey: string;
  /** Set when using a personal key; an organization key implies its organization. */
  orgId?: string | undefined;
  baseUrl?: string;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts per request for retryable answers (423, 429, 5xx, network errors). */
  maxAttempts?: number;
  /** How long to wait for background operations, in milliseconds. */
  operationTimeoutMs?: number;
}

export class NeonApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "NeonApiError";
  }
}

export interface Operation {
  id: string;
  action: string;
  status: string;
}

export interface Branch {
  id: string;
  name: string;
  parent_id?: string | null;
  default?: boolean;
  expires_at?: string | null;
  init_source?: string;
}

export interface CreatedProject {
  projectId: string;
  regionId: string;
  branch: Branch;
  operations: Operation[];
}

export interface CreateBranchInput {
  name: string;
  parentId: string;
  /** "schema-only" makes a root branch with the parent's schema and roles, no rows. */
  initSource?: "schema-only" | "parent-data";
  /** RFC 3339; Neon deletes the branch after this time. */
  expiresAt?: string;
  /** Give the branch its own read-write compute (needed to connect to it). */
  withCompute?: boolean;
}

const FINISHED = new Set(["finished", "skipped"]);
const FAILED = new Set(["failed", "error", "cancelled"]);

export function createNeonApi(options: NeonApiOptions) {
  const base = options.baseUrl ?? NEON_API;
  const doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxAttempts = options.maxAttempts ?? 8;
  const operationTimeoutMs = options.operationTimeoutMs ?? 180_000;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: Response;
      try {
        const init: RequestInit = {
          method,
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            accept: "application/json",
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
        };
        if (body !== undefined) init.body = JSON.stringify(body);
        res = await doFetch(`${base}${path}`, init);
      } catch (err) {
        lastError = err;
        await sleep(backoff(attempt));
        continue;
      }
      if (res.ok) {
        return (res.status === 204 ? undefined : await res.json()) as T;
      }
      const payload = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
      const error = new NeonApiError(
        `Neon API ${method} ${path} failed (${res.status}): ${payload.message ?? res.statusText}`,
        res.status,
        payload.code,
      );
      if (res.status === 423 || res.status === 429 || res.status >= 500) {
        lastError = error;
        await sleep(backoff(attempt));
        continue;
      }
      throw error;
    }
    throw lastError instanceof Error ? lastError : new Error(`Neon API ${method} ${path} failed`);
  }

  async function waitForOperations(projectId: string, operations: Operation[]): Promise<void> {
    const deadline = Date.now() + operationTimeoutMs;
    for (const op of operations) {
      let status = op.status;
      let wait = 500;
      while (!FINISHED.has(status)) {
        if (FAILED.has(status)) {
          throw new NeonApiError(`Neon operation ${op.action} (${op.id}) ${status}`, 500, "operation_failed");
        }
        if (Date.now() > deadline) {
          throw new NeonApiError(`Timed out waiting for Neon operation ${op.action} (${op.id})`, 504, "timeout");
        }
        await sleep(wait);
        wait = Math.min(wait * 2, 5000);
        const res = await request<{ operation: Operation }>(
          "GET",
          `/projects/${enc(projectId)}/operations/${enc(op.id)}`,
        );
        status = res.operation.status;
      }
    }
  }

  return {
    waitForOperations,

    /** Creates a project whose root branch is called `branchName`, and waits for it. */
    async createProject(input: {
      name: string;
      regionId: string;
      pgVersion?: number;
      branchName?: string;
    }): Promise<CreatedProject> {
      const res = await request<{
        project: { id: string; region_id: string };
        branch: Branch;
        operations: Operation[];
      }>("POST", "/projects", {
        project: {
          name: input.name,
          region_id: input.regionId,
          pg_version: input.pgVersion ?? 18,
          branch: { name: input.branchName ?? "production" },
          ...(options.orgId ? { org_id: options.orgId } : {}),
        },
      });
      await waitForOperations(res.project.id, res.operations ?? []);
      return {
        projectId: res.project.id,
        regionId: res.project.region_id,
        branch: res.branch,
        operations: res.operations ?? [],
      };
    },

    /** Projects whose name or ID contains `search`. */
    async findProjects(search: string): Promise<Array<{ id: string; name: string; region_id: string }>> {
      const params = new URLSearchParams({ search, limit: "100" });
      if (options.orgId) params.set("org_id", options.orgId);
      const res = await request<{ projects: Array<{ id: string; name: string; region_id: string }> }>(
        "GET",
        `/projects?${params}`,
      );
      return res.projects ?? [];
    },

    async listBranches(projectId: string): Promise<Branch[]> {
      const res = await request<{ branches: Branch[] }>("GET", `/projects/${enc(projectId)}/branches`);
      return res.branches ?? [];
    },

    /** Creates a branch and waits until it (and its compute, if any) is ready. */
    async createBranch(projectId: string, input: CreateBranchInput): Promise<Branch> {
      const res = await request<{ branch: Branch; operations: Operation[] }>(
        "POST",
        `/projects/${enc(projectId)}/branches`,
        {
          branch: {
            name: input.name,
            parent_id: input.parentId,
            ...(input.initSource ? { init_source: input.initSource } : {}),
            ...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
          },
          ...(input.withCompute === false ? {} : { endpoints: [{ type: "read_write" }] }),
        },
      );
      await waitForOperations(projectId, res.operations ?? []);
      return res.branch;
    },

    async deleteBranch(projectId: string, branchId: string): Promise<void> {
      try {
        const res = await request<{ operations?: Operation[] }>(
          "DELETE",
          `/projects/${enc(projectId)}/branches/${enc(branchId)}`,
        );
        await waitForOperations(projectId, res?.operations ?? []);
      } catch (err) {
        if (err instanceof NeonApiError && err.status === 404) return; // already gone
        throw err;
      }
    },

    /** A connection string for one role on one branch. */
    async connectionUri(
      projectId: string,
      input: { branchId: string; roleName: string; databaseName?: string; pooled?: boolean },
    ): Promise<string> {
      const params = new URLSearchParams({
        branch_id: input.branchId,
        role_name: input.roleName,
        database_name: input.databaseName ?? "neondb",
        pooled: String(input.pooled ?? false),
      });
      const res = await request<{ uri: string }>("GET", `/projects/${enc(projectId)}/connection_uri?${params}`);
      return res.uri;
    },

    /** A unified diff of `branchId`'s schema against `baseBranchId`'s. Empty when equal. */
    async compareSchema(
      projectId: string,
      input: { branchId: string; baseBranchId: string; databaseName?: string },
    ): Promise<string> {
      const params = new URLSearchParams({
        base_branch_id: input.baseBranchId,
        db_name: input.databaseName ?? "neondb",
      });
      const res = await request<{ diff: string }>(
        "GET",
        `/projects/${enc(projectId)}/branches/${enc(input.branchId)}/compare_schema?${params}`,
      );
      return res.diff ?? "";
    },
  };
}

export type NeonApi = ReturnType<typeof createNeonApi>;

const enc = encodeURIComponent;
const backoff = (attempt: number) => Math.min(250 * 2 ** (attempt - 1), 8000);
