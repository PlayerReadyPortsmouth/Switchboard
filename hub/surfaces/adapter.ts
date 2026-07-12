import type { NormalizedSurfaceEvent, SurfaceCapabilities, SurfaceDelivery, SurfaceDeliveryResult } from "./types"

export interface SurfaceAdapter {
  readonly name: string
  readonly capabilities: SurfaceCapabilities
  start(onEvent: (event: NormalizedSurfaceEvent) => Promise<void>): Promise<void>
  stop(): Promise<void>
  send(delivery: SurfaceDelivery): Promise<SurfaceDeliveryResult>
}
