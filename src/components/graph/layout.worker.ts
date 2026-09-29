/// <reference lib="webworker" />
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";

// Graph layout off the main thread (PROJECT.md 10.4; Phase 9). The page sends node sizes and links once; the worker
// runs d3-force and posts positions as a transferable Float32Array [x0, y0, x1, y1, …] at most every 33 ms. Under
// reduced motion the layout settles here and is posted once, so nothing animates on screen (AT 28).

export type LayoutIn =
  | { type: "init"; n: number; links: Int32Array; weights: Float32Array; radius: Float32Array; center: number; reduced: boolean }
  | { type: "drag"; i: number; x: number; y: number }
  | { type: "release"; i: number }
  | { type: "stop" };
export type LayoutOut = { type: "tick"; pos: Float32Array; done: boolean };

type Node = SimulationNodeDatum & { r: number };
type Link = SimulationLinkDatum<Node> & { w: number };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let sim: ReturnType<typeof forceSimulation<Node, Link>> | null = null;
let nodes: Node[] = [];
let last = 0;
let pinned = -1;

function post(done: boolean) {
  const pos = new Float32Array(nodes.length * 2);
  nodes.forEach((d, i) => {
    pos[i * 2] = d.x ?? 0;
    pos[i * 2 + 1] = d.y ?? 0;
  });
  const msg: LayoutOut = { type: "tick", pos, done };
  scope.postMessage(msg, [pos.buffer]);
}

scope.onmessage = (e: MessageEvent<LayoutIn>) => {
  const m = e.data;
  if (m.type === "init") {
    sim?.stop();
    nodes = Array.from({ length: m.n }, (_, i) => ({ index: i, r: m.radius[i] ?? 3 }));
    pinned = m.center;
    const c = m.center >= 0 ? nodes[m.center] : undefined;
    if (c) {
      c.fx = 0;
      c.fy = 0;
    }
    const links: Link[] = [];
    for (let k = 0; k < m.links.length / 2; k++) links.push({ source: m.links[k * 2] ?? 0, target: m.links[k * 2 + 1] ?? 0, w: m.weights[k] ?? 1 });
    const maxW = Math.max(1, ...links.map((l) => l.w));
    sim = forceSimulation<Node, Link>(nodes)
      .force("link", forceLink<Node, Link>(links).distance((l) => 26 + 30 * (1 - Math.log1p(l.w) / Math.log1p(maxW))).strength(0.6))
      .force("charge", forceManyBody<Node>().strength(m.n > 800 ? -14 : -30).distanceMax(400))
      .force("collide", forceCollide<Node>((d) => d.r + 1))
      // Weak gravity keeps components that share no link from drifting away and shrinking the fitted view.
      .force("x", forceX<Node>(0).strength(0.03))
      .force("y", forceY<Node>(0).strength(0.03));
    if (m.reduced) {
      sim.stop();
      const ticks = Math.ceil(Math.log(sim.alphaMin()) / Math.log(1 - sim.alphaDecay()));
      sim.tick(ticks);
      post(true);
      return;
    }
    sim.on("tick", () => {
      const now = performance.now();
      if (now - last >= 33) {
        last = now;
        post(false);
      }
    });
    sim.on("end", () => post(true));
    return;
  }
  if (!sim) return;
  const d = "i" in m ? nodes[m.i] : undefined;
  if (m.type === "drag" && d) {
    d.fx = m.x;
    d.fy = m.y;
    sim.alphaTarget(0.2).restart();
  } else if (m.type === "release" && d) {
    // The center of an ego graph stays pinned at the origin.
    if (m.i !== pinned) {
      d.fx = null;
      d.fy = null;
    }
    sim.alphaTarget(0);
  } else if (m.type === "stop") {
    sim.stop();
    sim = null;
  }
};
