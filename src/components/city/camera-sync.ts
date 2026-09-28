import type { Vector3 } from "three";

// One camera for two panes (Split lens, Phase 8 D4): the pane being dragged publishes its camera position and the
// others follow. Only the pane whose controls are active publishes, so the panes never echo each other. Kept apart
// from CityScene so the Split lens can create it without loading three.js before the panes do.
export class CameraSync {
  private readonly listeners = new Set<(pos: Vector3, from: symbol) => void>();
  subscribe(fn: (pos: Vector3, from: symbol) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  publish(pos: Vector3, from: symbol): void {
    for (const fn of this.listeners) fn(pos, from);
  }
}
