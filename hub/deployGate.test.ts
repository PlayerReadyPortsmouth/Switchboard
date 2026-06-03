import { test, expect } from "bun:test";
import { isDeployAuthorized } from "./deployGate";

test("deploy:* is authorized ONLY for the configured approver", () => {
  expect(isDeployAuthorized("deploy:go:J1", "APPROVER", "APPROVER")).toBe(true);
  expect(isDeployAuthorized("deploy:go:J1", "SOMEONE", "APPROVER")).toBe(false);
  expect(isDeployAuthorized("deploy:discard:J1", "APPROVER", "APPROVER")).toBe(true);
});
test("non-deploy customIds are not governed by this gate", () => {
  expect(isDeployAuthorized("action:resolve:T1", "ANYONE", "APPROVER")).toBe(true);
});
test("with no approver configured, deploy is denied to everyone", () => {
  expect(isDeployAuthorized("deploy:go:J1", "APPROVER", "")).toBe(false);
});
