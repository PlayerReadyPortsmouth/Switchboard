/** Channel levels: how private a channel is, how private a tool's answer is, and so
 *  whether an answer built from someone's records may be posted where they asked or
 *  must go to them by DM.
 *
 *    public        anyone in the server may be reading
 *    sensitive     a staff-only channel where work records may be discussed
 *    confidential  a restricted channel where pay and finance may be discussed
 *
 *  One rule: an answer stays in the channel only when the channel's level is at least
 *  the tool's level. A single record fetched in detail always goes privately, because
 *  ReadyApp marks detail as private-only. With no `channelLevels` in the hub config the
 *  hub keeps its old behaviour: every records answer in a shared channel goes by DM. */
export type Level = "public" | "sensitive" | "confidential"

export interface ChannelLevelsConfig {
  /** Discord channel id → level. A thread takes its parent's level when the caller passes it. */
  channels?: Record<string, Level>
  /** Level of a channel not listed. Default "public" (the safe assumption). */
  defaultChannel?: Level
  /** Tool (read) name → level, overriding the built-in table below. */
  tools?: Record<string, Level>
  /** Level of a tool in neither table. Default "sensitive". */
  defaultTool?: Level
}

const RANK: Record<Level, number> = { public: 0, sensitive: 1, confidential: 2 }
const isLevel = (v: unknown): v is Level => v === "public" || v === "sensitive" || v === "confidential"

/** Built-in tool levels. Anything about pay, money, audit or safeguarding is confidential;
 *  reference material that holds no personal records is public; the rest is sensitive. */
const BUILT_IN: Record<string, Level> = {
  knowledge: "public", wiki: "public", settingscatalog: "public", venues: "public", venuestatus: "public",
  ticketpipelines: "public", workeventcategories: "public", announcementssince: "public", vravailability: "public",
  finance: "confidential", myhours: "confidential", audit: "confidential", attendance: "confidential",
  safeguardingcounts: "confidential", emergencycontacts: "confidential",
}

export function toolLevel(cfg: ChannelLevelsConfig | undefined, tool: string): Level {
  const own = cfg?.tools?.[tool]
  if (isLevel(own)) return own
  return BUILT_IN[tool] ?? (isLevel(cfg?.defaultTool) ? cfg!.defaultTool! : "sensitive")
}

export function channelLevel(cfg: ChannelLevelsConfig | undefined, channelId: string | undefined, parentId?: string): Level {
  const hit = (channelId && cfg?.channels?.[channelId]) || (parentId && cfg?.channels?.[parentId])
  if (isLevel(hit)) return hit
  return isLevel(cfg?.defaultChannel) ? cfg!.defaultChannel! : "public"
}

/** Must this answer go to the person privately rather than into the channel they asked in? */
export function mustGoPrivate(cfg: ChannelLevelsConfig | undefined, q: { channelId?: string; parentId?: string; tool: string; detail?: boolean }): boolean {
  if (!cfg) return true                 // not configured: the old rule, always private
  if (q.detail) return true             // ReadyApp: detail is private-only
  if (q.tool === "catalog") return false
  return RANK[channelLevel(cfg, q.channelId, q.parentId)] < RANK[toolLevel(cfg, q.tool)]
}
