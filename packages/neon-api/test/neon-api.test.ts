import { describe, expect, it } from "vitest";
import { createNeonApi, NeonApiError } from "../src/index.js";

interface Call {
  method: string;
  url: string;
  body: unknown;
  auth: string | null;
}

/** A fake Neon API: answers are queued per "METHOD path" (query string ignored). */
function fakeNeon(routes: Record<string, Array<[number, unknown]>>) {
  const calls: Call[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const key = `${init?.method ?? "GET"} ${url.pathname.replace("/api/v2", "")}`;
    calls.push({
      method: init?.method ?? "GET",
      url: input,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init?.headers).get("authorization"),
    });
    const queue = routes[key];
    const next = queue?.shift();
    if (!next) throw new Error(`unexpected request ${key}`);
    const [status, body] = next;
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  };
  const api = createNeonApi({ apiKey: "napi_secret", orgId: "org-test-1", fetch, sleep: async () => {} });
  return { api, calls };
}

const op = (id: string, status: string, action = "create_timeline") => ({ id, action, status });

describe("neon api client", () => {
  it("creates a project in the organization and waits for its operations", async () => {
    const { api, calls } = fakeNeon({
      "POST /projects": [
        [201, { project: { id: "proj-1", region_id: "aws-ap-southeast-1" }, branch: { id: "br-prod", name: "production" }, operations: [op("op-1", "running")] }],
      ],
      "GET /projects/proj-1/operations/op-1": [
        [200, { operation: op("op-1", "running") }],
        [200, { operation: op("op-1", "finished") }],
      ],
    });
    const p = await api.createProject({ name: "nvx-acme", regionId: "aws-ap-southeast-1" });
    expect(p).toMatchObject({ projectId: "proj-1", branch: { id: "br-prod" } });
    expect(calls[0]?.body).toEqual({
      project: {
        name: "nvx-acme",
        region_id: "aws-ap-southeast-1",
        pg_version: 18,
        branch: { name: "production" },
        org_id: "org-test-1",
      },
    });
    expect(calls[0]?.auth).toBe("Bearer napi_secret");
    expect(calls).toHaveLength(3);
  });

  it("creates a schema-only branch with a compute", async () => {
    const { api, calls } = fakeNeon({
      "POST /projects/proj-1/branches": [
        [201, { branch: { id: "br-fix", name: "fixtures" }, operations: [op("op-2", "finished")] }],
      ],
    });
    const b = await api.createBranch("proj-1", { name: "fixtures", parentId: "br-prod", initSource: "schema-only" });
    expect(b.id).toBe("br-fix");
    expect(calls[0]?.body).toEqual({
      branch: { name: "fixtures", parent_id: "br-prod", init_source: "schema-only" },
      endpoints: [{ type: "read_write" }],
    });
  });

  it("retries while the project is locked by another operation", async () => {
    const { api, calls } = fakeNeon({
      "POST /projects/proj-1/branches": [
        [423, { code: "locked", message: "project already has running operations" }],
        [423, { code: "locked", message: "project already has running operations" }],
        [201, { branch: { id: "br-s", name: "sandbox" }, operations: [] }],
      ],
    });
    await api.createBranch("proj-1", { name: "sandbox", parentId: "br-fix", expiresAt: "2026-11-08T10:00:00Z" });
    expect(calls).toHaveLength(3);
    expect((calls[2]?.body as { branch: { expires_at: string } }).branch.expires_at).toBe("2026-11-08T10:00:00Z");
  });

  it("fails fast on client errors, without leaking the key", async () => {
    const { api } = fakeNeon({
      "POST /projects": [[422, { code: "projects_limit_exceeded", message: "project limit reached" }]],
    });
    const err = await api.createProject({ name: "x", regionId: "aws-ap-southeast-1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeonApiError);
    expect((err as NeonApiError).status).toBe(422);
    expect((err as NeonApiError).code).toBe("projects_limit_exceeded");
    expect(String((err as Error).message)).toContain("project limit reached");
    expect(String((err as Error).message)).not.toContain("napi_secret");
  });

  it("reports a failed operation", async () => {
    const { api } = fakeNeon({
      "POST /projects/proj-1/branches": [[201, { branch: { id: "b", name: "b" }, operations: [op("op-3", "failed")] }]],
    });
    await expect(api.createBranch("proj-1", { name: "b", parentId: "p" })).rejects.toThrow(/failed/);
  });

  it("treats deleting a branch that is already gone as done", async () => {
    const { api } = fakeNeon({
      "DELETE /projects/proj-1/branches/br-gone": [[404, { message: "not found" }]],
    });
    await expect(api.deleteBranch("proj-1", "br-gone")).resolves.toBeUndefined();
  });

  it("builds connection-string and schema-diff queries", async () => {
    const { api, calls } = fakeNeon({
      "GET /projects/proj-1/connection_uri": [[200, { uri: "postgresql://neondb_owner:pw@ep-x.neon.tech/neondb?sslmode=require" }]],
      "GET /projects/proj-1/branches/br-s/compare_schema": [[200, { diff: "+CREATE TABLE mold_1.tasks" }]],
    });
    await api.connectionUri("proj-1", { branchId: "br-prod", roleName: "neondb_owner" });
    const diff = await api.compareSchema("proj-1", { branchId: "br-s", baseBranchId: "br-fix" });
    expect(new URL(calls[0]!.url).searchParams.get("role_name")).toBe("neondb_owner");
    expect(new URL(calls[0]!.url).searchParams.get("pooled")).toBe("false");
    expect(new URL(calls[1]!.url).searchParams.get("base_branch_id")).toBe("br-fix");
    expect(new URL(calls[1]!.url).searchParams.get("db_name")).toBe("neondb");
    expect(diff).toContain("mold_1.tasks");
  });
});
