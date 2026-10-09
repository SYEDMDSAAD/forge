import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { Capability } from "./types.js";

interface RegistryEvents {
  activated: [Capability];
  removed: [string];
}

/**
 * Forged capabilities, persisted as one JSON file each. Shared by every MCP
 * session: activating a capability here makes it appear in all connected clients.
 */
export class Registry extends EventEmitter<RegistryEvents> {
  private caps = new Map<string, Capability>();
  private dir = path.join(config.dataDir, "capabilities");

  constructor() {
    super();
    mkdirSync(this.dir, { recursive: true });
    for (const file of readdirSync(this.dir).filter((f) => f.endsWith(".json"))) {
      const cap = JSON.parse(readFileSync(path.join(this.dir, file), "utf8")) as Capability;
      this.caps.set(cap.id, cap);
    }
  }

  private persist(cap: Capability) {
    const file = path.join(this.dir, `${cap.id}.json`);
    writeFileSync(file + ".tmp", JSON.stringify(cap, null, 2));
    renameSync(file + ".tmp", file);
  }

  active(): Capability[] {
    return [...this.caps.values()].filter((c) => c.status === "active");
  }

  pending(): Capability[] {
    return [...this.caps.values()].filter((c) => c.status === "pending");
  }

  get(id: string): Capability | undefined {
    return this.caps.get(id);
  }

  byName(name: string): Capability | undefined {
    return this.active().find((c) => c.spec.name === name);
  }

  addPending(cap: Capability) {
    this.caps.set(cap.id, cap);
    this.persist(cap);
  }

  activate(id: string): Capability {
    const cap = this.caps.get(id);
    if (!cap) throw new Error(`No capability ${id}`);
    // A re-forged tool with the same name replaces the old one.
    const previous = this.byName(cap.spec.name);
    if (previous && previous.id !== id) this.remove(previous.id);
    cap.status = "active";
    cap.approvedAt = new Date().toISOString();
    this.persist(cap);
    this.emit("activated", cap);
    return cap;
  }

  recordUse(id: string) {
    const cap = this.caps.get(id);
    if (!cap) return;
    cap.uses++;
    this.persist(cap);
  }

  remove(id: string) {
    const cap = this.caps.get(id);
    if (!cap) return;
    this.caps.delete(id);
    rmSync(path.join(this.dir, `${id}.json`), { force: true });
    if (cap.status === "active") this.emit("removed", cap.spec.name);
  }
}
