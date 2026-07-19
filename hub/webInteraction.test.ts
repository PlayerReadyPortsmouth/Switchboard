// Security tests for the web card-interaction path.
//
// The whole design claim is "a web click runs the SAME gates as a Discord click, keyed on a
// Discord snowflake it resolved from the caller's email". These tests exist to make that claim
// falsifiable: each negative case below is a specific way the endpoint could have been written
// permissively, and each asserts the endpoint refuses.
import { describe, expect, test } from "bun:test"
import { handleWebInteraction, type WebInteractionDeps } from "./webInteraction"
import { buildIdentityMap } from "./webIdentity"
import { interactionFrame } from "./transports/streamJsonFraming"
import type { CardModal, GatedAction } from "./types"

const APPROVER = "111111111111111111"     // the deploy approver / approvals approver
const MEMBER = "222222222222222222"       // allowlisted, but not an approver
const STRANGER = "333333333333333333"     // mapped, but NOT on the base allowlist

const GATED: GatedAction[] = [
  { namespace: "ops", action: "restart", approverOnly: true, command: "echo restart" } as GatedAction,
  { namespace: "ops", action: "ping", command: "echo ping" } as GatedAction,
]

interface Harness {
  deps: WebInteractionDeps
  routed: { customId: string; userId: string; fields?: Record<string, string> }[]
  approvals: { id: string; decision: string; userId: string }[]
  gated: string[]
}

function harness(overrides: Partial<WebInteractionDeps> = {}): Harness {
  const routed: Harness["routed"] = []
  const approvals: Harness["approvals"] = []
  const gated: string[] = []
  const deps: WebInteractionDeps = {
    enabled: true,
    identityMap: buildIdentityMap({
      "approver@example.test": APPROVER,
      "member@example.test": MEMBER,
      "stranger@example.test": STRANGER,
    }),
    listAllowed: () => [APPROVER, MEMBER],
    policy: { deployApproverUserId: APPROVER, approvalApprovers: [APPROVER], gatedActions: GATED },
    gatedActions: GATED,
    modalFor: () => undefined,
    resolveApproval: (id, decision, userId) => { approvals.push({ id, decision, userId }) },
    parseApproval: (customId) => {
      const m = /^approval:(grant|deny):(.+)$/.exec(customId)
      return m ? { id: m[2]!, decision: m[1] as "grant" | "deny" } : null
    },
    runGated: (_action, customId) => { gated.push(customId) },
    route: (customId, userId, fields) => { routed.push({ customId, userId, fields }) },
    ...overrides,
  }
  return { deps, routed, approvals, gated }
}

describe("identity mapping", () => {
  test("an unmapped email is rejected outright and reaches no agent", () => {
    const h = harness()
    const r = handleWebInteraction("nobody@example.test", "ticket:ack:7", undefined, h.deps)
    expect(r).toMatchObject({ status: "denied", error: "unmapped_identity" })
    expect(h.routed).toEqual([])
  })

  test("an empty or whitespace identity is rejected, not treated as a blank-key match", () => {
    const h = harness()
    for (const identity of ["", "   "]) {
      expect(handleWebInteraction(identity, "ticket:ack:7", undefined, h.deps))
        .toMatchObject({ status: "denied", error: "unmapped_identity" })
    }
    expect(h.routed).toEqual([])
  })

  test("mapping is case/whitespace insensitive on the email but exact on the snowflake", () => {
    const h = harness()
    const r = handleWebInteraction("  Member@Example.TEST ", "ticket:ack:7", undefined, h.deps)
    expect(r).toEqual({ status: "ok" })
    expect(h.routed[0]!.userId).toBe(MEMBER)
  })

  test("a config entry with a blank key cannot grant its snowflake to everyone", () => {
    // A blank key would otherwise match any identity that normalises to "".
    const map = buildIdentityMap({ "": APPROVER, "member@example.test": MEMBER })
    expect(map.has("")).toBe(false)
    const h = harness({ identityMap: map })
    expect(handleWebInteraction("", "deploy:go:1", undefined, h.deps))
      .toMatchObject({ status: "denied", error: "unmapped_identity" })
  })
})

describe("base gate", () => {
  test("a mapped identity that is not on the base allowlist is rejected", () => {
    const h = harness()
    const r = handleWebInteraction("stranger@example.test", "ticket:ack:7", undefined, h.deps)
    expect(r).toMatchObject({ status: "denied", error: "not_allowlisted" })
    expect(h.routed).toEqual([])
  })

  test("the allowlist is read per click, so a revocation takes effect immediately", () => {
    let allowed = [MEMBER]
    const h = harness({ listAllowed: () => allowed })
    expect(handleWebInteraction("member@example.test", "ticket:ack:7", undefined, h.deps).status).toBe("ok")
    allowed = []
    expect(handleWebInteraction("member@example.test", "ticket:ack:7", undefined, h.deps))
      .toMatchObject({ status: "denied", error: "not_allowlisted" })
  })
})

describe("per-namespace gates", () => {
  test("a mapped non-approver is rejected for deploy:*", () => {
    const h = harness()
    const r = handleWebInteraction("member@example.test", "deploy:go:481", undefined, h.deps)
    expect(r).toMatchObject({ status: "denied", error: "forbidden_action" })
    expect(h.routed).toEqual([])
  })

  test("a mapped non-approver is rejected for approval:*", () => {
    const h = harness()
    const r = handleWebInteraction("member@example.test", "approval:grant:abc", undefined, h.deps)
    expect(r).toMatchObject({ status: "denied", error: "forbidden_action" })
    expect(h.approvals).toEqual([])
  })

  test("a mapped non-approver is rejected for an approverOnly gated action", () => {
    const h = harness()
    const r = handleWebInteraction("member@example.test", "ops:restart:api", undefined, h.deps)
    expect(r).toMatchObject({ status: "denied", error: "forbidden_action" })
    expect(h.gated).toEqual([])
  })

  test("the approver passes all three and each runs on the right path", () => {
    const h = harness()
    expect(handleWebInteraction("approver@example.test", "deploy:go:481", undefined, h.deps)).toEqual({ status: "ok" })
    expect(handleWebInteraction("approver@example.test", "approval:grant:abc", undefined, h.deps))
      .toEqual({ status: "handled", action: "approval" })
    expect(handleWebInteraction("approver@example.test", "ops:restart:api", undefined, h.deps))
      .toEqual({ status: "handled", action: "gated" })
    // The approval and the gated action are intercepted hub-side and never reach an agent —
    // identical to the Discord path.
    expect(h.routed.map(r => r.customId)).toEqual(["deploy:go:481"])
    expect(h.approvals).toEqual([{ id: "abc", decision: "grant", userId: APPROVER }])
    expect(h.gated).toEqual(["ops:restart:api"])
  })

  test("a non-approverOnly gated action is allowed for an ordinary member", () => {
    const h = harness()
    expect(handleWebInteraction("member@example.test", "ops:ping:api", undefined, h.deps))
      .toEqual({ status: "handled", action: "gated" })
  })

  test("with no deploy approver configured, deploy:* is denied to everyone", () => {
    const h = harness({ policy: { deployApproverUserId: "", approvalApprovers: [], gatedActions: GATED } })
    for (const who of ["approver@example.test", "member@example.test"]) {
      expect(handleWebInteraction(who, "deploy:go:1", undefined, h.deps))
        .toMatchObject({ status: "denied", error: "forbidden_action" })
    }
  })
})

describe("modals", () => {
  const MODAL: CardModal = { title: "Note", inputs: [{ id: "note", label: "Note", style: "short" }] }

  test("a modal-bearing button returns the spec instead of firing", () => {
    const h = harness({ modalFor: (id) => (id === "ticket:note:7" ? MODAL : undefined) })
    const r = handleWebInteraction("member@example.test", "ticket:note:7", undefined, h.deps)
    expect(r).toEqual({ status: "modal", modal: MODAL })
    expect(h.routed).toEqual([])
  })

  test("submission carries fields through the frame", () => {
    const h = harness({ modalFor: () => MODAL })
    const r = handleWebInteraction("member@example.test", "ticket:note:7", { note: "looks good" }, h.deps)
    expect(r).toEqual({ status: "ok" })
    expect(h.routed).toEqual([{ customId: "ticket:note:7", userId: MEMBER, fields: { note: "looks good" } }])
  })

  test("posting a modal submission directly does NOT bypass the gate", () => {
    // A client could skip the "open" round-trip and POST fields straight away. The submit
    // must be gated exactly as the open was.
    const h = harness({ modalFor: () => MODAL })
    const r = handleWebInteraction("member@example.test", "deploy:go:481", { note: "ship it" }, h.deps)
    expect(r).toMatchObject({ status: "denied", error: "forbidden_action" })
    expect(h.routed).toEqual([])
  })
})

describe("frame equivalence", () => {
  test("the synthesised frame is byte-identical to a Discord-originated one", () => {
    // Both surfaces end at the same `sendInteraction(customId, userId, fields)` call, so the
    // proof is that the web path passes the resolved SNOWFLAKE — not the email — and the
    // untouched fields. If it leaked the email, these frames would differ.
    const h = harness()
    handleWebInteraction("approver@example.test", "deploy:go:481", { note: "go" }, h.deps)
    const fromWeb = h.routed[0]!
    const webFrame = interactionFrame(fromWeb.customId, fromWeb.userId, fromWeb.fields)
    const discordFrame = interactionFrame("deploy:go:481", APPROVER, { note: "go" })
    expect(webFrame).toBe(discordFrame)
    expect(webFrame).toContain(`user_id=${APPROVER}`)
    expect(webFrame).not.toContain("approver@example.test")
  })

  test("a click with no fields produces the no-fields frame, not an empty-object one", () => {
    const h = harness()
    handleWebInteraction("member@example.test", "ticket:ack:7", undefined, h.deps)
    const { customId, userId, fields } = h.routed[0]!
    expect(interactionFrame(customId, userId, fields)).toBe(interactionFrame("ticket:ack:7", MEMBER))
  })
})

describe("routing failures", () => {
  test("an unroutable click reports the reason rather than claiming success", () => {
    const h = harness({ route: () => "the agent that owns this button is no longer running" })
    const r = handleWebInteraction("member@example.test", "ticket:ack:7", undefined, h.deps)
    expect(r).toMatchObject({ status: "unroutable" })
  })
})

describe("flag", () => {
  test("flag off ⇒ every call is refused and nothing is touched, whoever is asking", () => {
    const h = harness({ enabled: false })
    for (const who of ["approver@example.test", "member@example.test", "nobody@example.test"]) {
      expect(handleWebInteraction(who, "deploy:go:481", undefined, h.deps))
        .toMatchObject({ status: "denied", error: "web_cards_disabled" })
    }
    expect(h.routed).toEqual([])
    expect(h.approvals).toEqual([])
    expect(h.gated).toEqual([])
  })
})
