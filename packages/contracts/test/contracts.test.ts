import { describe, expect, it } from "vitest";
import {
  evaluate,
  isContractRules,
  REDACTED,
  shape,
  type ContractRules,
  type Decision,
} from "../src/index.js";

const listMessages: ContractRules = {
  allow: { actions: ["read"], fields: ["id", "from", "subject", "labels"] },
  deny: { actions: ["delete"], fields: ["headers"] },
  redact: ["from.address"],
};

describe("evaluate", () => {
  it("allows a listed action and returns the allowed fields and redactions", () => {
    expect(evaluate(listMessages, { action: "read" })).toEqual({
      decision: "allowed",
      reason: "allowed",
      allowedFields: ["id", "from", "subject", "labels"],
      deniedFields: ["headers"],
      redact: ["from.address"],
    });
  });

  it("narrows to the fields the caller asked for", () => {
    const d = evaluate(listMessages, { action: "read", fields: ["id", "subject"] });
    expect(d).toMatchObject({ decision: "allowed", allowedFields: ["id", "subject"] });
  });

  it("denies an action that is not allowed", () => {
    expect(evaluate(listMessages, { action: "update" })).toEqual({
      decision: "denied",
      reason: "action_not_allowed",
      detail: "update",
    });
  });

  it("lets deny win over allow", () => {
    const rules: ContractRules = { allow: { actions: ["read", "delete"] }, deny: { actions: ["delete"] } };
    expect(evaluate(rules, { action: "delete" })).toMatchObject({ reason: "action_denied" });
  });

  it("denies a field on the deny list", () => {
    expect(evaluate(listMessages, { action: "read", fields: ["id", "headers"] })).toEqual({
      decision: "denied",
      reason: "field_denied",
      detail: "headers",
    });
  });

  it("denies a field outside the allow list", () => {
    expect(evaluate(listMessages, { action: "read", fields: ["body"] })).toMatchObject({
      reason: "field_not_allowed",
      detail: "body",
    });
  });

  it("allows any field when the contract has no field list, minus denied ones", () => {
    const rules: ContractRules = { allow: { actions: ["read"] }, deny: { fields: ["secret"] } };
    expect(evaluate(rules, { action: "read", fields: ["anything"] })).toMatchObject({
      decision: "allowed",
      allowedFields: ["anything"],
    });
    expect(evaluate(rules, { action: "read" })).toMatchObject({ allowedFields: undefined });
  });

  it("requires every scope the contract names", () => {
    const rules: ContractRules = { allow: { actions: ["read"], scopes: ["mail:read", "beta"] } };
    expect(evaluate(rules, { action: "read", scopes: ["mail:read"] })).toMatchObject({
      reason: "missing_scope",
      detail: "beta",
    });
    expect(evaluate(rules, { action: "read", scopes: ["beta", "mail:read"] })).toMatchObject({
      decision: "allowed",
    });
  });
});

describe("shape", () => {
  const messages = [
    { id: "m1", from: { name: "Ann", address: "ann@x.com" }, subject: "Hi", headers: "X-1", body: "secret" },
    { id: "m2", from: { name: "Bo", address: "bo@y.com" }, subject: "Yo", headers: "X-2", body: "secret" },
  ];

  it("keeps only allowed fields and masks redacted paths in every element", () => {
    const decision = evaluate(listMessages, { action: "read" });
    if (decision.decision !== "allowed") throw new Error("expected allowed");
    expect(shape(messages, decision)).toEqual([
      { id: "m1", from: { name: "Ann", address: REDACTED }, subject: "Hi" },
      { id: "m2", from: { name: "Bo", address: REDACTED }, subject: "Yo" },
    ]);
  });

  it("never modifies the input", () => {
    const decision = evaluate(listMessages, { action: "read" });
    if (decision.decision !== "allowed") throw new Error("expected allowed");
    const before = JSON.stringify(messages);
    shape(messages, decision);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("drops denied fields even without an allow list", () => {
    const rules: ContractRules = { allow: { actions: ["read"] }, deny: { fields: ["body"] } };
    const decision = evaluate(rules, { action: "read" });
    if (decision.decision !== "allowed") throw new Error("expected allowed");
    expect(shape({ id: 1, body: "x" }, decision)).toEqual({ id: 1 });
  });

  it("ignores redaction paths that are not present", () => {
    const decision: Extract<Decision, { decision: "allowed" }> = {
      decision: "allowed",
      reason: "allowed",
      allowedFields: undefined,
      deniedFields: [],
      redact: ["a.b.c"],
    };
    expect(shape({ a: { x: 1 }, z: null }, decision)).toEqual({ a: { x: 1 }, z: null });
  });
});

describe("isContractRules", () => {
  it("accepts rules with an allow.actions list and rejects anything else", () => {
    expect(isContractRules(listMessages)).toBe(true);
    expect(isContractRules({ allow: {} })).toBe(false);
    expect(isContractRules({ deny: { actions: [] } })).toBe(false);
    expect(isContractRules(null)).toBe(false);
  });
});
